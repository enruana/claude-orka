import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import type { Server as HttpServer } from 'http'
import type { Server as HttpsServer } from 'https'
import type { Duplex } from 'stream'
import execa from 'execa'
import path from 'path'
import fs from 'fs-extra'
import os from 'os'
import { logger } from '../../utils'
import {
  getWhisperCppPath,
  getWhisperServer,
  resolveAvailableWhisperModel,
  WHISPER_MODEL_PREFERENCE,
  WHISPER_PREFERRED_MODEL,
} from '../../utils/whisper'

// --- Whisper batch pipeline -------------------------------------------------
//
// For each connection we maintain a rolling PCM16 buffer. Every
// ~CHUNK_MS milliseconds of audio, we pull the last CHUNK_MS worth of
// samples out of the buffer, write a WAV file, run whisper-cli, and
// emit the resulting text back to the client as a transcript_delta.
// Nothing here is streaming inside whisper itself — we simply chunk
// the input, which is enough for a live-transcript feel (~3s latency).
//
// This module is intentionally isolated from the file-upload transcribe
// endpoint (transcribe.ts). Both share the model on disk but the live
// flow needs its own state per socket and its own IO pattern.

// Legacy constant kept for downstream references; real model choice is
// per-request via resolveAvailableWhisperModel().
const WHISPER_MODEL_FALLBACK = WHISPER_PREFERRED_MODEL
// Chunk sizing — the key knobs for the latency / drift trade-off.
//
// MIN_HOP_MS: don't process a chunk smaller than this. Whisper's
//   quality collapses below ~1s of audio (fragmentary output, wrong
//   words). 1500ms is a good floor.
// MAX_HOP_MS: never take more than this in one shot, even if the
//   buffer has more. Bounds the max user-visible latency of a single
//   chunk. 6000ms keeps latency under ~7s worst case.
// DEFAULT_CHUNK_MS: the "aimed for" size when we're keeping up. Sent
//   back to the client as the initial hop it uses to pace expectations.
//
// The consumer (tryFinalize) is ADAPTIVE: when whisper is free and the
// buffer has >= MIN_HOP_MS, it takes MIN(buffer.length, MAX_HOP_MS).
// So when we're caught up, chunks are ~MIN_HOP_MS and latency is low.
// When we fall behind (e.g. CPU spikes), chunks grow up to MAX_HOP_MS,
// throughput increases (fixed overhead amortized, whisper more
// efficient per audio-second on longer windows), and we catch up.
const DEFAULT_CHUNK_MS = 1500
const MIN_HOP_MS = 1500
const MAX_HOP_MS = 6000
const MIN_CHUNK_MS = 750       // client can request smaller floor
const MAX_CHUNK_MS = 6000
// Prepend this much of the PREVIOUS chunk's audio to each whisper
// window so words that straddle boundaries aren't cut mid-syllable.
// The extra tokens whisper produces for this region get deduped against
// what we already emitted (see dedupHead). 500ms covers a comfortable
// word plus co-articulation on natural speech.
const OVERLAP_MS = 500
// How many chars of prior transcript to feed whisper as `--prompt`.
// Whisper.cpp uses this as decoder conditioning (soft bias for
// vocabulary and continuation), which is the single biggest quality
// win when chunking. Too long (>250 chars) starts to dominate over the
// current audio, too short (<80) loses continuity.
const PROMPT_TAIL_CHARS = 200
const EMITTED_TAIL_KEEP_CHARS = 800
const SAMPLE_RATE = 16000                // whisper expects 16 kHz
const BYTES_PER_SAMPLE = 2               // PCM16 LE

const getWhisperPath = getWhisperCppPath

const getTempDir = () => path.join(os.tmpdir(), 'orka-whisper-live')

interface Session {
  id: string
  language: string
  chunkMs: number              // client-requested hop size (floor)
  minHopBytes: number          // don't process anything smaller
  maxHopBytes: number          // never process more than this at once
  overlapBytes: number         // OVERLAP_MS worth of samples
  buffer: Buffer               // rolling PCM16 waiting to be consumed
  audioTail: Buffer            // last OVERLAP_MS of audio from previous chunk
  emittedMs: number            // audio time already committed
  receivedMs: number           // total audio time received from the client
  emittedTail: string          // tail of previously-emitted text (prompt + dedup)
  processing: boolean          // guard against overlapping whisper spawns
  closed: boolean
  startedAt: number
  tempDir: string
  ws: WebSocket
}

const activeSessions = new Set<Session>()

function makeSessionId(): string {
  return `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Build a minimal 16-bit PCM WAV header for the given payload length.
 * whisper-cli reads WAV files natively via drwav.h, so this avoids
 * spawning ffmpeg for every chunk.
 */
function buildWavHeader(pcmBytes: number): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = SAMPLE_RATE * BYTES_PER_SAMPLE
  const blockAlign = BYTES_PER_SAMPLE
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcmBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)             // fmt chunk size
  header.writeUInt16LE(1, 20)              // PCM
  header.writeUInt16LE(1, 22)              // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(16, 34)             // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcmBytes, 40)
  return header
}

/**
 * Transcribe a single WAV chunk with whisper-cli. We keep this synchronous
 * per-session (queued by the processing flag) to avoid spawning multiple
 * whisper processes at once against the same model.
 *
 * `prompt` is passed to whisper-cli's `--prompt` — decoder conditioning
 * that biases the model toward continuing from the given text. Not a
 * strict rule, but empirically the biggest streaming-quality win.
 */
// Prefer the persistent whisper-server (loads the model once). Fall back
// to spawning whisper-cli per chunk if the server can't start (older
// whisper.cpp build, missing binary, etc.). We latch onto whichever
// path succeeded on the FIRST call so we don't keep retrying a failing
// server on every chunk.
type TranscribeBackend = 'server' | 'cli'
let backendChoice: TranscribeBackend | null = null
let backendPreflight: Promise<TranscribeBackend> | null = null

async function pickTranscribeBackend(): Promise<TranscribeBackend> {
  if (backendChoice) return backendChoice
  if (backendPreflight) return backendPreflight
  backendPreflight = (async () => {
    try {
      const handle = await getWhisperServer()
      await handle.ready
      logger.info(`[transcribe-live] using persistent whisper-server (${handle.modelName})`)
      backendChoice = 'server'
      return 'server' as const
    } catch (err) {
      logger.warn(`[transcribe-live] whisper-server unavailable, falling back to whisper-cli spawn — ${(err as Error).message}`)
      backendChoice = 'cli'
      return 'cli' as const
    }
  })()
  return backendPreflight
}

async function transcribeChunkViaCli(
  wavPath: string,
  language: string,
  prompt?: string
): Promise<string> {
  const whisperPath = getWhisperPath()
  const whisperBin = path.join(whisperPath, 'build', 'bin', 'whisper-cli')
  const resolved = await resolveAvailableWhisperModel()
  if (!resolved) {
    throw new Error(
      `No whisper model available (checked: ${WHISPER_MODEL_PREFERENCE.join(', ')}). ` +
      `Run 'orka prepare' to download '${WHISPER_MODEL_FALLBACK}'.`
    )
  }
  const modelPath = resolved.path

  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-l', language,
    '--no-timestamps',
    '-nt',
    '--no-prints',
    '-t', '4',
  ]
  const trimmedPrompt = (prompt || '').trim()
  if (trimmedPrompt) {
    args.push('--prompt', trimmedPrompt.slice(-PROMPT_TAIL_CHARS))
  }

  const { stdout } = await execa(whisperBin, args, {
    cwd: whisperPath,
    timeout: 30000,
  })

  return stdout.trim()
}

async function transcribeChunk(
  wavPath: string,
  wavBuffer: Buffer,
  language: string,
  prompt?: string
): Promise<string> {
  const backend = await pickTranscribeBackend()
  if (backend === 'server') {
    try {
      const handle = await getWhisperServer()
      return await handle.transcribe(wavBuffer, {
        language,
        prompt: (prompt || '').trim().slice(-PROMPT_TAIL_CHARS),
      })
    } catch (err) {
      // One-shot recovery: if the server died mid-session, fall back to
      // CLI for THIS chunk and let the next call re-preflight the server.
      logger.warn(`[transcribe-live] server transcribe failed, retrying via CLI: ${(err as Error).message}`)
      backendChoice = null
      backendPreflight = null
      return transcribeChunkViaCli(wavPath, language, prompt)
    }
  }
  return transcribeChunkViaCli(wavPath, language, prompt)
}

/**
 * Strip words from the start of `newText` that whisper re-transcribed
 * because the window included the tail of the previous chunk. We
 * compare word sequences after normalization — greedy longest match up
 * to 12 words. Falls back to a single-word match for the trivial case
 * of one repeated word at the seam.
 *
 * This is standard technique in streaming whisper systems: cheap,
 * language-agnostic, and robust to punctuation drift between calls.
 */
function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[^a-z0-9áéíóúñüàèìòùâêîôû]/gi, '')
}

/**
 * Whisper emits bracketed annotations for events it detects but doesn't
 * transcribe (music, applause, silence, laughter). They're noise for a
 * live-meeting transcript, so we strip them. Both bracket styles are
 * covered because Spanish captions from whisper often use "( )" while
 * English uses "[ ]". Keeps the surrounding whitespace tidy.
 */
const NON_SPEECH_KEYWORDS = [
  'música', 'music', 'musica',
  'aplausos', 'applause', 'applauso',
  'silencio', 'silence',
  'risa', 'risas', 'laughter', 'laughing',
  'ruido', 'noise',
  'inaudible', 'unintelligible',
  'susurro', 'whisper', 'whispering',
  'tos', 'tosidos', 'coughing', 'cough',
  'chime', 'ding', 'ringtone', 'timbre',
  'sonido', 'sound',
]
const NON_SPEECH_RE = new RegExp(
  `[\\[\\(]\\s*(?:${NON_SPEECH_KEYWORDS.join('|')})[^\\]\\)]{0,20}[\\]\\)]`,
  'gi'
)

function stripNonSpeech(text: string): string {
  return text
    .replace(NON_SPEECH_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------
// Whisper hallucination-loop guard
// ---------------------------------------------------------------
//
// Whisper's greedy decoding sometimes gets stuck on a single token or
// short n-gram and produces output like "to. to. to. to. to. to. …" or
// "OK. OK. OK. OK. …" for the rest of the chunk. It happens most on
// silence, background noise, or ambiguous transitions.
//
// Two things to fix:
//   1. Collapse the runaway repetition in the emitted text so the user
//      doesn't see the wall of duplicates.
//   2. NEVER feed a degenerate chunk back as the `--prompt` for the next
//      call — otherwise whisper sees "to. to. to." as context and keeps
//      producing more "to.", cascading the failure across chunks.
//
// Detection is heuristic: token-uniqueness ratio + consecutive-repeat
// runs at both the unigram and bigram level. Cheap enough to run on
// every chunk; language-agnostic.

/** How many times the same unigram/bigram must repeat consecutively to
 *  be considered a hallucination run (rather than legit emphasis). */
const REPEAT_RUN_THRESHOLD = 4
/** Below this unique/total token ratio (on chunks with >= 8 tokens) the
 *  chunk is considered degenerate — used as a defense-in-depth signal
 *  in addition to the run detector. */
const UNIQUE_RATIO_THRESHOLD = 0.35

/** Split into whitespace tokens preserving punctuation for round-trip,
 *  and produce a parallel normalized array for comparisons. Both arrays
 *  have the same length so we can slice by index. */
function tokenizeForRepeat(text: string): { raw: string[]; norm: string[] } {
  const raw = text.split(/\s+/).filter(Boolean)
  const norm = raw.map(normalizeWord)
  return { raw, norm }
}

/**
 * Collapse consecutive same-token runs (unigrams) and consecutive same-
 * bigram runs into at most 2 occurrences. Preserves the first two so
 * legitimate emphasis ("no no", "ok ok") survives, but any longer
 * runaway ("to. to. to. to. …") gets trimmed. Returns the cleaned
 * string and a boolean flagging whether a "significant" collapse
 * happened — used by the caller to skip poisoning the prompt.
 */
function collapseRepetitions(text: string): { text: string; collapsed: boolean } {
  const { raw, norm } = tokenizeForRepeat(text)
  if (raw.length < 2) return { text, collapsed: false }

  const kept: string[] = []
  const keptNorm: string[] = []
  let removedRun = 0

  // Bigram-run collapse first: e.g. "muy bien muy bien muy bien" →
  // "muy bien muy bien". Two-pointer sweep detecting if positions
  // (i, i+1) match (i+2, i+3) and (i+4, i+5) ... — we skip forward
  // past the run keeping only the first two repetitions.
  let i = 0
  while (i < raw.length) {
    // Try bigram at position i.
    if (i + 3 < raw.length && norm[i] && norm[i + 1] &&
        norm[i] === norm[i + 2] && norm[i + 1] === norm[i + 3]) {
      // Look ahead: how many bigram-repeats?
      let repeats = 2
      while (i + repeats * 2 + 1 < raw.length &&
             norm[i] === norm[i + repeats * 2] &&
             norm[i + 1] === norm[i + repeats * 2 + 1]) {
        repeats++
      }
      if (repeats >= 3) {
        // Keep only the first two bigrams; drop the rest of the run.
        kept.push(raw[i], raw[i + 1], raw[i + 2], raw[i + 3])
        keptNorm.push(norm[i], norm[i + 1], norm[i + 2], norm[i + 3])
        removedRun += (repeats - 2) * 2
        i += repeats * 2
        continue
      }
    }
    kept.push(raw[i])
    keptNorm.push(norm[i])
    i++
  }

  // Unigram-run collapse pass over the bigram-collapsed output.
  const finalRaw: string[] = []
  let removedUnigram = 0
  let j = 0
  while (j < kept.length) {
    let runEnd = j + 1
    while (runEnd < kept.length && keptNorm[runEnd] === keptNorm[j] && keptNorm[j].length > 0) {
      runEnd++
    }
    const runLen = runEnd - j
    if (runLen >= REPEAT_RUN_THRESHOLD) {
      // Keep the first two, drop the rest.
      finalRaw.push(kept[j], kept[j + 1])
      removedUnigram += runLen - 2
    } else {
      for (let k = j; k < runEnd; k++) finalRaw.push(kept[k])
    }
    j = runEnd
  }

  const totalRemoved = removedRun + removedUnigram
  // "Significant" collapse = we stripped at least 3 tokens AND stripped
  // more than we kept (i.e. this chunk was mostly hallucination). This
  // threshold is what gates the prompt-poisoning avoidance below.
  const collapsed = totalRemoved >= 3 && totalRemoved > finalRaw.length
  return { text: finalRaw.join(' '), collapsed }
}

/** Compression-ratio style secondary check: if a chunk has many tokens
 *  but very few unique ones, treat it as degenerate even if no single
 *  run tripped the threshold (edge case: interleaved "a b a b a b …"). */
function isDegenerateChunk(text: string): boolean {
  const { norm } = tokenizeForRepeat(text)
  if (norm.length < 8) return false
  const unique = new Set(norm.filter(Boolean))
  return unique.size / norm.length < UNIQUE_RATIO_THRESHOLD
}

/**
 * Levenshtein distance — small helper for the fuzzy tail matcher below.
 * Two strings under distance 2 are treated as "the same word" for
 * dedup purposes. This tolerates whisper's slight rephrasings on the
 * overlap region ("intertería"/"invertiría", "féspe"/"fíjate").
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const prev = new Array<number>(n + 1)
  const cur = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j]
  }
  return prev[n]
}

function wordsRoughlyEqual(a: string, b: string): boolean {
  if (a === b) return true
  if (!a || !b) return false
  // Short words: require exact match — 1-char edit distance would
  // conflate too many meaningful words ("si"/"se", "de"/"le").
  if (a.length <= 3 || b.length <= 3) return a === b
  const dist = editDistance(a, b)
  return dist <= Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.2))
}

/**
 * Strip words from the start of `newText` that whisper re-transcribed
 * because the window included the tail of the previous chunk. Two
 * passes:
 *   1. Exact multi-word match (fast path, catches most cases).
 *   2. Fuzzy multi-word match with per-word edit-distance tolerance —
 *      whisper occasionally rephrases the overlap region.
 * Falls back to a single-word strip for the trivial one-word seam.
 */
function dedupHead(newText: string, lastTail: string): string {
  const clean = newText.trim()
  if (!clean) return ''
  const tail = (lastTail || '').trim()
  if (!tail) return clean

  const newWords = clean.split(/\s+/)
  const tailWords = tail.split(/\s+/)

  const maxOverlap = Math.min(newWords.length, tailWords.length, 12)
  const normNew = newWords.map(normalizeWord)
  const normTail = tailWords.map(normalizeWord)

  // Exact match pass — cheaper than fuzzy, catches clean cases.
  for (let n = maxOverlap; n >= 2; n--) {
    const suffix = normTail.slice(-n).join(' ')
    const prefix = normNew.slice(0, n).join(' ')
    if (suffix && suffix === prefix) {
      return newWords.slice(n).join(' ')
    }
  }
  // Fuzzy match pass — allow up to 1 word off within a 3-6 word window.
  // This handles whisper drift on the overlap region.
  for (let n = Math.min(maxOverlap, 6); n >= 3; n--) {
    const suffix = normTail.slice(-n)
    const prefix = normNew.slice(0, n)
    let mismatches = 0
    for (let i = 0; i < n; i++) {
      if (!wordsRoughlyEqual(suffix[i], prefix[i])) mismatches++
    }
    if (mismatches <= 1) {
      return newWords.slice(n).join(' ')
    }
  }
  // Single-word tail duplicate — common at seams where whisper closes
  // and re-opens a word ("hello... hello world"). Only strip if the
  // word is meaty (>=3 chars) to avoid killing short function words.
  const lastWord = normTail[normTail.length - 1] || ''
  const firstWord = normNew[0] || ''
  if (lastWord && firstWord && lastWord === firstWord && lastWord.length >= 3) {
    return newWords.slice(1).join(' ')
  }
  return newWords.join(' ')
}

function msFromBytes(bytes: number): number {
  return Math.floor((bytes / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000)
}

/**
 * Adaptive consumer. Waits for at least `minHopBytes` of audio to have
 * accumulated, then hands whisper the whole buffered lump (capped at
 * `maxHopBytes`). When we're keeping up, chunks are ~minHopBytes; when
 * we've fallen behind (e.g. a slow whisper call), the buffer grew in
 * the meantime and the next call catches up with a bigger chunk. This
 * self-tunes without the caller having to pick a specific hop size.
 */
async function tryFinalize(sess: Session): Promise<void> {
  if (sess.processing || sess.closed) return
  if (sess.buffer.length < sess.minHopBytes) return

  sess.processing = true
  // Take everything we've got, up to the ceiling. This is where the
  // adaptive behavior comes from — a small chunk when we're on time,
  // a big chunk when there's a backlog.
  const takeBytes = Math.min(sess.buffer.length, sess.maxHopBytes)
  const hop = Buffer.from(sess.buffer.subarray(0, takeBytes))
  sess.buffer = Buffer.from(sess.buffer.subarray(takeBytes))
  const hopMs = msFromBytes(takeBytes)

  // Window = [prev tail][new hop]. Whisper decodes the whole thing, we
  // dedupe its output against what we already emitted.
  const window = sess.audioTail.length > 0
    ? Buffer.concat([sess.audioTail, hop])
    : Buffer.from(hop)
  // Retain the last OVERLAP_MS of this window for the NEXT call.
  sess.audioTail = window.length > sess.overlapBytes
    ? Buffer.from(window.subarray(window.length - sess.overlapBytes))
    : Buffer.from(window)

  const since = sess.emittedMs
  const until = since + hopMs
  sess.emittedMs = until

  const wavPath = path.join(sess.tempDir, `chunk-${since}.wav`)
  try {
    const header = buildWavHeader(window.length)
    const wavBuffer = Buffer.concat([header, window])
    await fs.writeFile(wavPath, wavBuffer)
    const inferStart = Date.now()
    const raw = await transcribeChunk(wavPath, wavBuffer, sess.language, sess.emittedTail)
    const inferMs = Date.now() - inferStart
    const backlogMs = msFromBytes(sess.buffer.length)
    logger.info(
      `[transcribe-live ${sess.id}] hop=${hopMs}ms window=${msFromBytes(window.length)}ms ` +
      `infer=${inferMs}ms via=${backendChoice || 'unknown'} backlog=${backlogMs}ms chars=${raw.length}`
    )
    // Strip [Música], (music), etc. BEFORE the dedup pass so the
    // annotation isn't the thing that gets matched between chunks.
    const speechOnly = stripNonSpeech(raw)
    const seamCleaned = dedupHead(speechOnly, sess.emittedTail)
    // Collapse whisper hallucination loops ("to. to. to. …") to at most
    // two occurrences. Also flag when the collapse was significant so
    // we can protect the next chunk's prompt from cascading the bug.
    const { text: cleaned, collapsed } = collapseRepetitions(seamCleaned)
    const degenerate = collapsed || isDegenerateChunk(seamCleaned)
    if (degenerate) {
      logger.warn(
        `[transcribe-live ${sess.id}] hallucination-loop guard: ` +
        `raw="${speechOnly.slice(0, 80)}${speechOnly.length > 80 ? '…' : ''}" ` +
        `→ collapsed="${cleaned.slice(0, 80)}${cleaned.length > 80 ? '…' : ''}"`
      )
    }
    if (!sess.closed && cleaned) {
      sendJson(sess.ws, {
        type: 'transcript',
        text: cleaned,
        since,
        until,
        // driftMs = audio the client already sent us but we haven't
        // finished transcribing yet. Users see this as "N seconds
        // behind" in the panel. inferMs helps if we want to expose
        // the raw processing cost.
        driftMs: backlogMs,
        inferMs,
      })
      // Keep a rolling window of emitted text for the next prompt +
      // dedup pass. Bounded so it doesn't grow without limit.
      //
      // Prompt-poisoning guard: if this chunk was degenerate, DO NOT
      // append it to the tail — whisper uses emittedTail as `--prompt`
      // and a runaway pattern in the prompt biases the model to keep
      // producing the same runaway, cascading the failure. Skipping
      // just this chunk leaves the previous good context in place.
      if (!degenerate) {
        sess.emittedTail = (sess.emittedTail + ' ' + cleaned).trim().slice(-EMITTED_TAIL_KEEP_CHARS)
      }
    }
  } catch (err) {
    logger.error(`[transcribe-live ${sess.id}] whisper failed`, err)
    if (!sess.closed) {
      sendJson(sess.ws, {
        type: 'error',
        message: (err as Error).message,
      })
    }
  } finally {
    await fs.remove(wavPath).catch(() => {})
    sess.processing = false
    // If enough audio came in while we were transcribing, chain
    // straight into the next chunk — no scheduling gap.
    if (!sess.closed && sess.buffer.length >= sess.minHopBytes) {
      void tryFinalize(sess)
    }
  }
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify(payload))
  } catch {
    // ignore — connection may have dropped between the readyState check
    // and the send call
  }
}

async function cleanupSession(sess: Session): Promise<void> {
  sess.closed = true
  activeSessions.delete(sess)
  await fs.remove(sess.tempDir).catch(() => {})
}

/**
 * Attach the live-transcription WebSocket to the given HTTP(S) server.
 * Path: /api/transcribe/live?language=es
 *
 * Wire protocol:
 *   Client → server (binary):  raw PCM16 LE 16kHz mono samples
 *   Client → server (text):    { type: 'init'|'flush'|'close', language? }
 *   Server → client (text):    { type: 'ready' }
 *                              { type: 'transcript', text, since, until }
 *                              { type: 'error', message }
 */
export function attachLiveTranscribeWS(server: HttpServer | HttpsServer): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url || ''
    if (!url.startsWith('/api/transcribe/live')) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const urlObj = new URL(req.url || '/', 'http://localhost')
    const langParam = urlObj.searchParams.get('language') || 'auto'
    const validLangs = ['es', 'en', 'auto']
    const language = validLangs.includes(langParam) ? langParam : 'auto'
    const chunkMsParam = parseInt(urlObj.searchParams.get('chunkMs') || '', 10)
    const chunkMs = Number.isFinite(chunkMsParam)
      ? Math.max(MIN_CHUNK_MS, Math.min(MAX_CHUNK_MS, chunkMsParam))
      : DEFAULT_CHUNK_MS
    // Per-session floor / ceiling. Floor honors the client's preference
    // but never goes below MIN_HOP_MS (whisper quality collapses under
    // a second of context). Ceiling is fixed — bounds worst-case single
    // chunk latency.
    const minHopMs = Math.max(MIN_HOP_MS, chunkMs)
    const minHopBytes = Math.floor((minHopMs / 1000) * SAMPLE_RATE) * BYTES_PER_SAMPLE
    const maxHopBytes = Math.floor((MAX_HOP_MS / 1000) * SAMPLE_RATE) * BYTES_PER_SAMPLE
    const overlapBytes = Math.floor((OVERLAP_MS / 1000) * SAMPLE_RATE) * BYTES_PER_SAMPLE

    const sess: Session = {
      id: makeSessionId(),
      language,
      chunkMs,
      minHopBytes,
      maxHopBytes,
      overlapBytes,
      buffer: Buffer.alloc(0),
      audioTail: Buffer.alloc(0),
      emittedMs: 0,
      receivedMs: 0,
      emittedTail: '',
      processing: false,
      closed: false,
      startedAt: Date.now(),
      tempDir: path.join(getTempDir(), makeSessionId()),
      ws,
    }
    activeSessions.add(sess)
    await fs.ensureDir(sess.tempDir).catch(() => {})
    logger.info(
      `[transcribe-live ${sess.id}] connected (lang=${language}, ` +
      `minHop=${minHopMs}ms, maxHop=${MAX_HOP_MS}ms, overlap=${OVERLAP_MS}ms)`
    )
    sendJson(ws, {
      type: 'ready',
      sessionId: sess.id,
      chunkMs,
      minHopMs,
      maxHopMs: MAX_HOP_MS,
    })

    ws.on('message', (data, isBinary) => {
      if (sess.closed) return
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        sess.buffer = sess.buffer.length === 0 ? buf : Buffer.concat([sess.buffer, buf])
        sess.receivedMs += msFromBytes(buf.length)
        void tryFinalize(sess)
        return
      }
      let msg: { type?: string; language?: string } = {}
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (msg.type === 'init' && typeof msg.language === 'string') {
        const l = msg.language
        if (validLangs.includes(l)) sess.language = l
      } else if (msg.type === 'flush') {
        // Force a chunk even if we don't have a full hop yet — pad
        // with silence so whisper has a workable buffer.
        if (sess.buffer.length > 0 && sess.buffer.length < sess.minHopBytes) {
          const pad = Buffer.alloc(sess.minHopBytes - sess.buffer.length)
          sess.buffer = Buffer.concat([sess.buffer, pad])
        }
        void tryFinalize(sess)
      } else if (msg.type === 'close') {
        ws.close(1000, 'client requested close')
      }
    })

    ws.on('close', () => {
      logger.info(`[transcribe-live ${sess.id}] closed after ${Date.now() - sess.startedAt}ms`)
      void cleanupSession(sess)
    })

    ws.on('error', (err) => {
      logger.error(`[transcribe-live ${sess.id}] ws error`, err)
      void cleanupSession(sess)
    })
  })
}
