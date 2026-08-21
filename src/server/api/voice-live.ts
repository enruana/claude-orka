import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer } from 'http'
import type { Server as HttpsServer } from 'https'
import { Router } from 'express'
import fs from 'fs-extra'
import path from 'path'
import { logger } from '../../utils'
import { transcribeUtterancePcm16 } from './transcribe-live'
import { synthesizePcm16, getKokoro, listKokoroVoices } from '../../utils/kokoro'
import { getWhisperServer } from '../../utils/whisper'
// pdf-parse is pulled in lazily inside parsePdfBuffer() so the whole
// voice module doesn't pay for pdfjs at boot when no PDF is ever added.
// eslint-disable-next-line @typescript-eslint/no-var-requires

export const voiceRouter = Router()

/**
 * GET /api/voice/widget-test
 *
 * Standalone test page for the browser widget. Serves the injected
 * HTML with a CSP loose enough to pull vad-web + ONNX-runtime from a
 * CDN and to open a WebSocket back to same origin. This route exists
 * for Phase 2 hand-testing; the production widget will be inlined into
 * the /api/files/preview/*?voice=1 flow.
 */
/**
 * GET /api/voice/assets/:filename
 *
 * Serves the self-hosted vad-web + onnxruntime-web + Silero model
 * files. Loading these from a same-origin URL (rather than a CDN) is
 * required because ORT's runtime dynamically imports its wasm loader
 * via `import(specifier)`, and browsers refuse to resolve relative
 * module specifiers when the calling script comes from a different
 * origin ("The base URL is about:blank" TypeError). Same-origin →
 * problem disappears.
 *
 * Filenames are whitelisted to prevent path traversal / arbitrary
 * disclosure of files under .temp/voice-assets/.
 */
const VOICE_ASSETS_WHITELIST = new Set([
  'bundle.min.js',
  'vad.worklet.bundle.min.js',
  'silero_vad_legacy.onnx',
  'ort.min.js',
  // ORT ≥1.19 splits its wasm loader into ES modules — vad-web's bundle
  // hardcodes `ort-wasm-simd-threaded.mjs` so we must serve BOTH the
  // .mjs loader and the .wasm binary it loads.
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
])
const VOICE_ASSETS_MIME: Record<string, string> = {
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.onnx':  'application/octet-stream',
  '.wasm':  'application/wasm',
}

voiceRouter.get('/assets/:filename', async (req, res) => {
  const filename = req.params.filename
  if (!VOICE_ASSETS_WHITELIST.has(filename)) {
    res.status(404).send('not found')
    return
  }
  const abs = path.join('/home/felipe-mantilla/Desktop/Me/claude-orka/.temp/voice-assets', filename)
  try {
    const ext = path.extname(filename)
    res.setHeader('Content-Type', VOICE_ASSETS_MIME[ext] || 'application/octet-stream')
    // Cache aggressively — these are versioned via the widget's bootstrap.
    res.setHeader('Cache-Control', 'public, max-age=86400')
    // Required for AudioWorklet + WASM threads under COOP/COEP:
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    fs.createReadStream(abs).pipe(res)
  } catch (err: any) {
    res.status(500).send(`asset error: ${err.message}`)
  }
})

/**
 * GET /api/voice/widget.js
 *
 * Serves the widget's browser bundle as a standalone script. Loaded
 * via `<script src="/api/voice/widget.js" defer>` from the injected
 * overlay in /api/files/preview/*?voice=1 (see buildVoiceOverlay in
 * files.ts). Kept as its own route rather than inlined into every
 * preview response so browsers can cache the ~15 KB bundle across
 * documents.
 */
voiceRouter.get('/widget.js', async (_req, res) => {
  const jsPath = '/home/felipe-mantilla/Desktop/Me/claude-orka/.temp/voice-widget.js'
  try {
    const src = await fs.readFile(jsPath, 'utf-8')
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
    // no-store while we iterate on the widget in Phase-2/3; switch to
    // a hashed URL + long max-age once the widget stabilizes.
    res.setHeader('Cache-Control', 'no-store')
    res.send(src)
  } catch (err: any) {
    res.status(500).send(`widget.js unavailable: ${err.message}`)
  }
})

voiceRouter.get('/widget-test', async (_req, res) => {
  // Hardcoded absolute path — this is a Phase-2 hand-testing route
  // that reads .temp/voice-widget.{html,js} from the Orka repo. Not
  // portable, not shipped in production; the real widget will be
  // inlined into /api/files/preview/*?voice=1 in Phase 4.
  const repoRoot = '/home/felipe-mantilla/Desktop/Me/claude-orka'
  const htmlPath = path.join(repoRoot, '.temp/voice-widget.html')
  const jsPath   = path.join(repoRoot, '.temp/voice-widget.js')
  try {
    let html = await fs.readFile(htmlPath, 'utf-8')
    const js = await fs.readFile(jsPath, 'utf-8')
    // Inline the JS so we don't have to deal with same-origin script
    // loading + relative path resolution on this ad-hoc route.
    html = html.replace(
      '<script src="voice-widget.js"></script>',
      `<script>${js.replace(/<\/script>/g, '<\\/script>')}</script>`
    )
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self' data: blob:",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        // AudioWorklet processors are loaded from blob: URLs; WS to same origin
        "connect-src 'self' wss: ws:",
        "worker-src blob: 'self'",
      ].join('; ')
    )
    // SharedArrayBuffer isolation headers — required by ORT ≥1.19 whose
    // wasm build only ships the `-simd-threaded` variant and expects
    // SAB to be available for its worker pool. Without both COOP and
    // COEP the browser refuses to enable SAB, and ORT's instantiate
    // fails with "no available backend found".
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    // The widget file changes constantly during Phase-2 iteration; make
    // every response uncacheable so hard-reload isn't required.
    res.setHeader('Cache-Control', 'no-store')
    res.send(html)
  } catch (err: any) {
    res.status(500).send(`widget-test unavailable: ${err.message}`)
  }
})

/**
 * Voice-first document-chat WebSocket at /api/voice/live.
 *
 * Client connects with:
 *   ?project=<b64>&path=<relative-file>&voice=<kokoro-voice-id>&language=en
 *
 * On connect, the server:
 *   1. Reads the target file, strips HTML tags for a text-only doc context.
 *   2. Spawns a Claude Agent SDK session in Streaming Input Mode.
 *   3. Yields the doc + orientation prompt as message 1.
 *
 * Then per turn:
 *   - client streams mic PCM16 @ 16 kHz as binary frames
 *   - client sends {type:'utterance-end'} when its VAD detects silence
 *   - server runs STT on the buffered audio (whisper.cpp reuse)
 *   - server yields the transcript as the next user message
 *   - server pipes text_delta events through a sentence-boundary buffer
 *     into Kokoro, streaming PCM16 audio frames back to the client
 *   - client plays them; if VAD fires again mid-playback, {type:'interrupt'}
 *     stops TTS + cancels the LLM turn
 *
 * All wire messages are documented in the WS_PROTOCOL.md block below.
 */

// ============================================================
// Wire protocol
// ============================================================
//
// Client → server:
//   binary          - PCM16 mono @ 16 kHz mic audio (buffered until utterance-end)
//   JSON {type:'utterance-end'}          - VAD detected silence, transcribe now
//   JSON {type:'interrupt'}              - barge-in: stop TTS + cancel LLM turn
//   JSON {type:'set-voice', voice}       - change TTS voice mid-session
//   JSON {type:'ping'}                   - keepalive
//
// Server → client:
//   JSON {type:'ready', voices, docChars}         - session up, doc loaded
//   JSON {type:'error', message}
//   JSON {type:'transcript-final', text}          - user turn transcribed
//   JSON {type:'assistant-text', text, sentence}  - text chunk being spoken
//   JSON {type:'audio-start', sampleRate, format} - next binary frames = audio
//   JSON {type:'audio-end'}                       - end of this sentence's audio
//   JSON {type:'assistant-turn-end'}              - assistant done for this turn
//   binary          - PCM16 mono @ 24 kHz TTS audio (Kokoro native rate)

/** One entry per completed exchange in this voice session. Fed back
 *  into a fresh Claude query() when the previous one dies (typically
 *  from a barge-in abort) so the conversation continues without losing
 *  the doc or the prior turns. */
interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

/**
 * A single document loaded into the voice-agent's context. May come
 * from a project file (initial context, backward compat with the HTML
 * preview flow), from a user upload (PDF / markdown / html / txt),
 * or from a URL fetch during the conversation.
 *
 * `text` is the extracted plain text — capped per-attachment and
 * totalled across the session (see MAX_ATTACHMENT_CHARS /
 * MAX_TOTAL_ATTACHMENT_CHARS). `pendingAnnounce` flags an attachment
 * that arrived mid-conversation and has NOT been surfaced to Claude
 * yet — the next user turn prepends a note about it so the model
 * knows there's new material.
 */
type AttachmentSource = 'project-file' | 'upload' | 'url'
interface Attachment {
  id: string
  source: AttachmentSource
  label: string
  text: string
  chars: number
  addedAt: number
  pendingAnnounce: boolean
}

interface VoiceSession {
  id: string
  ws: WebSocket
  language: string
  voice: string
  projectPath: string
  attachments: Attachment[]
  // Utterance buffer: PCM16 mono @ 16 kHz. Reset after each utterance-end.
  utteranceBuffer: Buffer[]
  // Rolling conversation history. Grows with every completed turn.
  // Replayed as the first message of a re-armed Claude query after a
  // barge-in kills the current one; also seeds the initial run.
  history: HistoryEntry[]
  // The user text for the turn currently being processed by Claude.
  // Paired with `currentAssistantText` — both get committed to
  // `history` as one HistoryEntry pair when the assistant finishes,
  // or both get dropped on barge-in (partial reply doesn't reflect a
  // real exchange, and the user is starting a fresh turn anyway).
  currentUserText: string | null
  // Text accumulated during the CURRENT assistant turn — appended to
  // `history` (paired with currentUserText) when the turn ends
  // normally, dropped on barge-in.
  currentAssistantText: string
  // Claude SDK gating: resolve to release the next user message into the
  // streaming-input generator. Resolved with `null` when the session
  // closes (stop sentinel) or when a re-arm is needed (the generator
  // exits so runClaudeSession's outer loop can restart it).
  nextUserMsgDeferred: Deferred<string | null> | null
  // LLM query abort controller — recreated on every re-arm.
  abortController: AbortController
  // True while a barge-in is in progress: the query() is being aborted
  // and we're about to spin up a fresh one. runClaudeSession's outer
  // loop reads this to distinguish an intentional restart from an
  // error, and to skip re-emitting the ready state.
  bargeInPending: boolean
  // The utterance queued during barge-in (the one that TRIGGERED it).
  // Waits until the fresh query is armed, then gets yielded as its
  // first user message so the interruption feels seamless.
  queuedUserText: string | null
  // MUTEX: guards against spawning parallel runClaudeSession drivers.
  // Without this, each barge-in or idle-utterance could launch a new
  // driver on top of one that's already running, and both would race
  // to yield into the WS at the same time — an "overload" where two
  // agents speak at once until they trip over each other.
  driverRunning: boolean
  // Time of last barge-in (ms epoch). Utterances arriving within
  // BARGE_IN_GRACE_MS of this are ignored — they're almost certainly
  // the echo tail of the interrupted TTS being picked up by the mic,
  // not a real new user turn.
  lastBargeInAt: number
  // TTS state: sentence buffer + whether we're currently emitting audio.
  ttsBuffer: string
  ttsInFlight: boolean
  ttsCancelToken: { cancelled: boolean }
  // Event-driven gate: Priority 3A optimization. Deferred gate that resolves
  // when the previous sentence finishes TTS, reducing CPU and jitter.
  ttsFlushedGate: Deferred<void> | null
  closed: boolean
  startedAt: number
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const activeSessions = new Set<VoiceSession>()

// ============================================================
// SDK caching — Priority 2 optimization
// ============================================================
let sdkQueryCached: any = null
let sdkQueryLoading: Promise<any> | null = null

async function getSDKQuery() {
  if (sdkQueryCached) return sdkQueryCached
  if (sdkQueryLoading) return sdkQueryLoading

  sdkQueryLoading = (async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    sdkQueryCached = query
    return query
  })()

  return sdkQueryLoading
}

// ============================================================
// Doc loading (from the project's file tree)
// ============================================================

function decodeProjectB64(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf-8')
}

/** Read the target file and return a text-only representation. For
 *  HTML we strip tags (aggressively) so the LLM sees prose, not markup;
 *  for markdown / txt we pass through. Caps at ~80 KB to stay well
 *  under Claude's context window. */
async function loadDocContext(projectPath: string, relPath: string): Promise<string> {
  const abs = path.resolve(projectPath, relPath)
  if (!abs.startsWith(path.resolve(projectPath))) {
    throw new Error('access denied')
  }
  if (!(await fs.pathExists(abs))) {
    throw new Error(`file not found: ${relPath}`)
  }
  let text = await fs.readFile(abs, 'utf-8')
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  const ext = path.extname(relPath).toLowerCase()
  if (ext === '.html' || ext === '.htm') {
    text = htmlToText(text)
  }
  const MAX = 80 * 1024
  if (text.length > MAX) text = text.slice(0, MAX) + '\n[…document truncated]'
  return text
}

/** Minimal HTML → text: strip script/style/nav, collapse tags, decode
 *  a few common entities. Good enough to give the LLM the readable
 *  content without pulling in a full DOM parser. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// ============================================================
// Attachment loaders — PDF, URL, generic text file
// ============================================================
//
// Two knobs the whole attachment subsystem obeys:
//   MAX_ATTACHMENT_CHARS       cap for ONE attachment's extracted text
//   MAX_TOTAL_ATTACHMENT_CHARS cap across ALL attachments in a session
// The session refuses to add a new attachment that would push the total
// over the cap. This keeps Claude's context predictable and stops a
// runaway upload from silently eating the whole budget.
const MAX_ATTACHMENT_CHARS = 80 * 1024
const MAX_TOTAL_ATTACHMENT_CHARS = 240 * 1024
// Raw upload byte cap. 20 MB is comfortable for scanned PDFs and well
// below Node's default WS max-payload (~100 MB).
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
// URL fetch timeout. 15s covers heavy pages; longer than that and the
// tab starts feeling stuck to the user.
const URL_FETCH_TIMEOUT_MS = 15_000
const URL_FETCH_MAX_BYTES = 5 * 1024 * 1024

function clampText(text: string, cap: number = MAX_ATTACHMENT_CHARS): string {
  if (text.length <= cap) return text
  return text.slice(0, cap) + '\n[…truncated]'
}

function makeAttachmentId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function parsePdfBuffer(buf: Buffer, label: string): Promise<string> {
  // Lazy import so users who never touch the voice agent don't pay for
  // pdfjs at server boot. pdf-parse v2 exposes a class-based API
  // (PDFParse.getText()) — the module itself isn't callable.
  const mod = await import('pdf-parse')
  const PDFParse = (mod as { PDFParse: new (opts: { data: Buffer }) => { getText: () => Promise<{ text: string }>; destroy: () => Promise<void> } }).PDFParse
  const parser = new PDFParse({ data: buf })
  try {
    const parsed = await parser.getText().catch((err: Error) => {
      throw new Error(`PDF parse failed for ${label}: ${err.message}`)
    })
    const text = (parsed?.text || '').replace(/\s+\n/g, '\n').trim()
    if (!text) throw new Error(`PDF ${label} has no extractable text (image-only scan?)`)
    return text
  } finally {
    try { await parser.destroy() } catch { /* ignore */ }
  }
}

/** Fetch a URL and return its text content. Enforces size, timeout,
 *  and content-type sanity. Supports http(s) only. Uses the built-in
 *  fetch (Node 18+). */
async function loadUrlAsText(url: string): Promise<{ text: string; label: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Some sites gate content behind a non-empty UA.
        'User-Agent': 'ClaudeOrkaVoiceAgent/1.0 (+https://github.com/enruana/claude-orka)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
  } catch (err: any) {
    clearTimeout(timer)
    if (err?.name === 'AbortError') throw new Error(`URL fetch timed out after ${URL_FETCH_TIMEOUT_MS / 1000}s: ${url}`)
    throw new Error(`URL fetch failed: ${err?.message || err}`)
  }
  clearTimeout(timer)
  if (!res.ok) throw new Error(`URL fetch returned HTTP ${res.status}`)
  const contentType = (res.headers.get('content-type') || '').toLowerCase()

  // Size check — read body as buffer, capped.
  const body = await res.arrayBuffer()
  if (body.byteLength > URL_FETCH_MAX_BYTES) {
    throw new Error(`URL body too large: ${(body.byteLength / 1024 / 1024).toFixed(1)} MB > ${URL_FETCH_MAX_BYTES / 1024 / 1024} MB`)
  }
  const buf = Buffer.from(body)

  let text: string
  if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
    text = await parsePdfBuffer(buf, url)
  } else if (contentType.includes('text/html') || contentType.includes('xhtml')) {
    text = htmlToText(buf.toString('utf-8'))
  } else if (contentType.includes('text/') || contentType.includes('application/json') || contentType.includes('markdown')) {
    text = buf.toString('utf-8').trim()
  } else {
    // Unknown content-type: try to decode as UTF-8 and pray. If it
    // looks binary (many null bytes), reject.
    const asText = buf.toString('utf-8')
    if (asText.split('\0').length > 5) throw new Error(`Unsupported content-type: ${contentType || 'unknown'}`)
    text = asText.trim()
  }

  // Extract a short human-readable label from the URL.
  const label = parsed.hostname + parsed.pathname.replace(/\/$/, '')
  return { text, label }
}

/** Total chars across an attachments array. */
function totalAttachmentChars(atts: Attachment[]): number {
  return atts.reduce((n, a) => n + a.chars, 0)
}

/** Compose the doc-context block that goes at the top of Claude's seed
 *  message. Empty attachments list produces a short "no document yet"
 *  note so the model doesn't hallucinate one. */
function buildDocsContext(attachments: Attachment[]): string {
  if (attachments.length === 0) {
    return `[No documents attached yet. The user may attach documents or URLs during the conversation — I will announce each one when it arrives, and you should treat it as part of the shared context from that point forward.]`
  }
  const parts: string[] = []
  parts.push(`The user has attached ${attachments.length} document${attachments.length === 1 ? '' : 's'} for us to discuss. When more attachments arrive during the conversation, I'll announce them and you'll see them in the context from then on.`)
  for (const a of attachments) {
    parts.push(`\n--- ${a.source === 'url' ? 'URL' : a.source === 'upload' ? 'FILE' : 'DOCUMENT'}: ${a.label} (${a.chars} chars) ---\n${a.text}`)
  }
  return parts.join('\n')
}

// ============================================================
// Sentence-boundary buffering for TTS
// ============================================================
//
// Feeding Kokoro every text_delta token gives horrible synthesis
// (unnatural pauses, chopped prosody). Feeding it the entire assistant
// response destroys TTFA. Sweet spot: yield one sentence at a time.
// A "sentence" here is anything ending in .!?…: followed by whitespace
// or end of string. Single newlines mid-text are treated as spaces (not boundaries)
// to avoid splitting phrases that wrap across lines. Double newlines = paragraph break.

const SENTENCE_END_RE = /([.!?…]["')\]]*|\n\n+)(\s+|$)/g
const MAX_SENTENCE_CHARS = 400  // hard flush if no punctuation (increased from 260 for smoother playback)

/**
 * Strip markdown & code-ish tokens the TTS would otherwise read out
 * loud as literal punctuation ("asterisk asterisk" / "hash hash" /
 * "underscore users underscore contacts"). This is the last-line
 * defense — the system prompt already forbids all of this, but a long
 * conversation can drift, and one bad turn is enough for the user to
 * hear the model literally say "asterisk". Keep the fixes surgical:
 *
 *   1. Strip formatting *markers* (bold/italic/backticks/heading hashes,
 *      bullet dashes at line start, "1." style list markers) but keep
 *      the text they wrapped — losing the sentence entirely would be
 *      worse than reading a slightly odd version.
 *   2. Turn snake_case and identifier_names into "snake case" so the
 *      underscores don't get spoken. Same for backtick-quoted inline
 *      code — the backticks vanish and the identifier gets its
 *      underscores swapped for spaces.
 *   3. Collapse horizontal rules (---, ***) and remaining whitespace
 *      runs so the TTS doesn't pause on the empty scaffolding.
 *
 * NOTE: Any leaked hyperlink like [text](url) becomes just "text" —
 * URLs are unreadable aloud, and the label carries the meaning.
 */
function sanitizeForSpeech(text: string): string {
  let s = text

  // Fenced code blocks (```...```) — drop entirely; nothing in them
  // reads well aloud, and the surrounding sentence should still stand.
  s = s.replace(/```[\s\S]*?```/g, ' ')

  // Inline code `like_this` — strip the backticks AND swap underscores
  // for spaces inside so `user_contacts` becomes "user contacts", not
  // "user underscore contacts".
  s = s.replace(/`([^`]+)`/g, (_m, inner: string) => inner.replace(/_/g, ' '))

  // Markdown links [label](url) — keep the label only.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')

  // Bold **x** / __x__ and italic *x* / _x_ — strip the markers, keep
  // the text. Order matters: two-char markers first, then one-char.
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, '$1')
  // Single-underscore italics — but not underscores inside identifiers
  // (which are handled by the identifier pass below).
  s = s.replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '$1')

  // Heading hashes at line start (# / ## / ###...).
  s = s.replace(/^#{1,6}\s+/gm, '')

  // Bullet list markers at line start: -, *, • followed by space.
  s = s.replace(/^\s*[-*•]\s+/gm, '')
  // Numbered list markers at line start: "1. ", "2) ", etc.
  s = s.replace(/^\s*\d+[.)]\s+/gm, '')

  // Horizontal rules (---, ***, ___ on their own line).
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, '')

  // Remaining identifier_names that leaked past inline-code handling —
  // any lowercase word with an underscore inside becomes space-joined.
  // Guard: needs at least one letter on each side so we don't touch
  // things like "step_1" oddly (still fine — becomes "step 1").
  s = s.replace(/\b([A-Za-z][A-Za-z0-9]*)_([A-Za-z][A-Za-z0-9_]*)\b/g,
    (m) => m.replace(/_/g, ' '))

  // Collapse whitespace runs the strip left behind.
  s = s.replace(/[ \t]{2,}/g, ' ')
  s = s.replace(/\n{2,}/g, '\n')

  return s.trim()
}

/** Consume as many complete sentences as we can from the buffer, return
 *  them and the remaining unfinished tail. */
function extractSentences(buffer: string): { sentences: string[]; rest: string } {
  // Normalize single newlines to spaces so they don't break sentences mid-phrase.
  // Only double+ newlines are treated as paragraph/sentence boundaries.
  const normalized = buffer.replace(/\n(?!\n)/g, ' ').replace(/\s+/g, ' ')

  const sentences: string[] = []
  let lastCut = 0
  let match: RegExpExecArray | null
  const re = new RegExp(SENTENCE_END_RE.source, 'g')
  while ((match = re.exec(normalized)) !== null) {
    const end = match.index + match[1].length
    const chunk = normalized.slice(lastCut, end).trim()
    if (chunk) sentences.push(chunk)
    lastCut = end + match[2].length
  }
  const rest = normalized.slice(lastCut)
  // Hard flush: if the tail is too long without punctuation, cut on a
  // word boundary so we don't buffer forever.
  if (rest.length > MAX_SENTENCE_CHARS) {
    const cut = rest.lastIndexOf(' ', MAX_SENTENCE_CHARS)
    if (cut > 40) {
      sentences.push(rest.slice(0, cut).trim())
      return { sentences, rest: rest.slice(cut + 1) }
    }
  }
  return { sentences, rest }
}

// ============================================================
// LLM session — Claude Agent SDK in Streaming Input Mode
// ============================================================

// ============================================================================
// Voice system prompt
// ============================================================================
//
// The user's complaint (2026-08-14): the model was writing wall-of-text
// responses with markdown headings, bullet lists, code fences and
// snake_case identifiers — all of which the TTS then reads aloud
// literally ("asterisco asterisco the partitioning problem asterisco
// asterisco"). Even with "no bullet lists" in the old prompt, the model
// would break the rule as soon as it decided the topic was "important".
//
// The new prompt does three things the old one didn't:
//
//  1. States the ONE rule as "you're talking, not writing". Everything
//     else falls out of that framing — humans don't say "asterisk" or
//     "hash hash" out loud, so neither should you.
//  2. Gives concrete GOOD / BAD examples. Rules get ignored; examples
//     get imitated.
//  3. Caps depth by DEFAULT. Long answers are opt-in only when the user
//     explicitly asks to keep going, and even then they come out in
//     turns — a short beat, then "want me to keep going?" — not one
//     six-minute monologue.
//
// Change these lines with care; the user notices immediately when the
// model regresses to lecture mode.

const SYSTEM_PROMPT_HEADER =
  `You are having a spoken conversation with the user about a document. Your\n` +
  `words go straight to a text-to-speech engine and get read out loud, so\n` +
  `you are TALKING, not writing.\n` +
  `\n` +
  `HARD RULES — never break these, even when the topic feels important:\n` +
  `\n` +
  `1. Zero markdown. No asterisks for bold, no underscores, no backticks,\n` +
  `   no hash headings, no hyphens as bullets, no numbered lists like\n` +
  `   "1." "2." "3.", no tables, no code fences, no horizontal rules.\n` +
  `   If you catch yourself typing any of those, rewrite the line.\n` +
  `\n` +
  `2. Zero code. No identifiers like user_contacts or ContactAccess or\n` +
  `   payload.dig, no JSON, no SQL, no snake_case, no camelCase, no file\n` +
  `   paths. If the document uses a technical name, say it in plain\n` +
  `   words — "the contacts table" not "the contacts table with\n` +
  `   underscore users underscore contacts". Never spell out symbols.\n` +
  `\n` +
  `3. Short. Default is TWO to FOUR sentences. Then stop and let the\n` +
  `   user talk back. If they ask "explain more" or "keep going", give\n` +
  `   ANOTHER two to four sentences and stop again. Long answers happen\n` +
  `   across many short turns, never as one wall of text.\n` +
  `\n` +
  `4. Sound like a friend at a café explaining something, not a\n` +
  `   textbook. Use "so basically", "the thing is", "yeah", contractions,\n` +
  `   easy verbs. Skip academic transitions like "furthermore" or\n` +
  `   "moreover". If a sentence is longer than a normal breath, cut it.\n` +
  `\n` +
  `5. When you list things, weave them into a sentence: "there are three\n` +
  `   pieces — the join table, the search index, and the score itself"\n` +
  `   NOT "1. join table 2. search index 3. score". Never enumerate.\n` +
  `\n` +
  `6. Never offer menus like "would you like me to explain (a) X, (b) Y,\n` +
  `   or (c) Z?". Just ask one plain question: "want me to go deeper on\n` +
  `   the join table, or on why the scores get shared?".\n` +
  `\n` +
  `GOOD example (this is the vibe):\n` +
  `  "So basically, every contact gets one shared score, and everyone who\n` +
  `  can see that contact reads from the same score. That's why Derek's\n` +
  `  thumbs-down ends up dropping Kelly's ranking too — they're literally\n` +
  `  pointing at the same row. Want me to unpack why it ended up like\n` +
  `  that?"\n` +
  `\n` +
  `BAD example (never do this):\n` +
  `  "Let me deepen the discussion. **What would be most useful to\n` +
  `  clarify?** 1. **The three proposed solutions** 2. **The historical\n` +
  `  why** 3. **The implementation roadmap** ..."\n` +
  `\n` +
  `Here is the document to discuss:\n\n`

/**
 * Build the async generator the SDK consumes for one query() call.
 *
 * On every run, the FIRST yielded message stitches together:
 *   [system-prompt-header + doc]  + full history so far + optional queued utterance
 * Then it loops on `sess.nextUserMsgDeferred` for subsequent user turns.
 *
 * Two exit paths:
 *   - `text === null`  → the session is closing (stop sentinel from
 *     the WS close handler). Return cleanly.
 *   - `bargeInPending` → runClaudeSession's outer loop needs to
 *     restart the query. We resolve the deferred with `null` from the
 *     interrupt handler, then set bargeInPending so the outer loop
 *     knows this exit wasn't the session ending.
 */
async function* userTurnGenerator(sess: VoiceSession): AsyncGenerator<{
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  session_id: string
}> {
  // Build message 1: docs + history + the user's actual next question,
  // ALL as one user message. Yielding the seed AS ONE message and the
  // queued utterance SEPARATELY makes Claude see two consecutive user
  // turns and respond twice — once to the seed's "continue the
  // conversation" nudge, once to the real question. Folding them into
  // a single message eliminates that double reply.
  //
  // Doc-context is always rebuilt from `sess.attachments` so
  // mid-conversation adds are reflected on the next re-arm without
  // extra bookkeeping.
  let seed = SYSTEM_PROMPT_HEADER + buildDocsContext(sess.attachments)
  // Mark any pending-announce attachments as delivered — the seed we
  // just built includes them, so we shouldn't also prepend them to the
  // next user turn.
  for (const a of sess.attachments) a.pendingAnnounce = false
  if (sess.history.length > 0) {
    seed += '\n\n---\nSo far we have discussed:\n'
    for (const h of sess.history) {
      seed += (h.role === 'user' ? '\nYou asked: ' : '\nI replied: ') + h.content
    }
  }
  // If a barge-in / idle re-arm queued an utterance, fold it into the
  // seed as the actual user turn. This is the only user message Claude
  // sees for this query, so it responds once — to the real question.
  if (sess.queuedUserText) {
    const q = sess.queuedUserText
    sess.queuedUserText = null
    sess.currentUserText = q
    seed += `\n\n---\nMy next question: ${q}`
  }
  yield {
    type: 'user',
    message: { role: 'user', content: seed },
    parent_tool_use_id: null,
    session_id: sess.id,
  }

  while (!sess.closed && !sess.bargeInPending) {
    const d = deferred<string | null>()
    sess.nextUserMsgDeferred = d
    let text: string | null
    try {
      text = await d.promise
    } catch {
      break
    }
    if (text === null || sess.closed || sess.bargeInPending) break
    sess.currentUserText = text
    yield {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: sess.id,
    }
  }
}

/**
 * Long-lived Claude driver. Runs one `query()` at a time; when it
 * exits (naturally, via abort, or via error), decides whether to
 * re-arm with the accumulated history or terminate.
 *
 * Re-arm triggers:
 *   - bargeInPending = true  → user interrupted mid-response
 *   - sess.closed  = true    → do not re-arm, exit cleanly
 *   - any other exit         → do not re-arm; log if the exit was
 *     unexpected. (A natural end-of-generator happens when there's no
 *     more user input pending; not an error, just idle.)
 */
const BARGE_IN_GRACE_MS = 400  // ignore utterances arriving within this window of a barge-in (echo tail)

async function runClaudeSession(sess: VoiceSession): Promise<void> {
  // MUTEX: refuse to run in parallel with another driver on the same
  // session. Callers (transcribeAndTurn's fallback path) should check
  // driverRunning before spawning, but even if they slip, this second
  // line of defence prevents the "two agents talking at once" bug.
  if (sess.driverRunning) {
    logger.debug(`[voice-live ${sess.id}] runClaudeSession: driver already running, refusing to spawn parallel`)
    return
  }
  sess.driverRunning = true
  const query = await getSDKQuery()

  try {
  while (!sess.closed) {
    // Fresh abort controller per run — the previous one may have been
    // aborted by a barge-in.
    sess.abortController = new AbortController()
    sess.bargeInPending = false

    try {
      for await (const event of query({
        prompt: userTurnGenerator(sess),
        options: {
          includePartialMessages: true,
          model: 'claude-haiku-4-5-20251001',
          permissionMode: 'bypassPermissions',
          abortController: sess.abortController,
        },
      })) {
        if (sess.closed || sess.bargeInPending) break

        // Token-level streaming: pipe text into the sentence buffer.
        if (event.type === 'stream_event') {
          const inner = event.event
          if (inner?.type === 'content_block_delta') {
            const delta = (inner as { delta?: { type?: string; text?: string } }).delta
            if (delta?.type === 'text_delta' && delta.text) {
              handleAssistantText(sess, delta.text)
            }
          }
        }

        // Assistant turn boundary: flush leftover text, commit the
        // exchange (user turn + assistant reply) to history as a
        // paired entry so a future re-arm's seed replay is accurate.
        if (event.type === 'assistant') {
          if (sess.ttsBuffer.trim()) {
            const tail = sess.ttsBuffer.trim()
            sess.ttsBuffer = ''
            void speakSentence(sess, tail)
          }
          if (sess.currentAssistantText.trim()) {
            if (sess.currentUserText) {
              sess.history.push({ role: 'user', content: sess.currentUserText })
            }
            sess.history.push({ role: 'assistant', content: sess.currentAssistantText.trim() })
            sess.currentUserText = null
            sess.currentAssistantText = ''
          }
        }

        if (event.type === 'result') {
          // Flush any remaining text in the TTS buffer (text without punctuation at the end)
          if (sess.ttsBuffer.trim()) {
            const remaining = sess.ttsBuffer.trim()
            const sanitized = sanitizeForSpeech(remaining)
            if (sanitized) {
              sendJson(sess.ws, { type: 'assistant-text', text: sanitized })
              void speakSentence(sess, sanitized)
            }
            sess.ttsBuffer = ''
          }
          sendJson(sess.ws, { type: 'assistant-turn-end' })
        }
      }
    } catch (err) {
      const msg = (err as Error).message || String(err)
      const looksLikeAbort =
        (err as Error).name === 'AbortError' ||
        /abort/i.test(msg) ||
        sess.bargeInPending
      if (sess.closed) {
        break
      }
      if (looksLikeAbort) {
        logger.info(`[voice-live ${sess.id}] Claude query aborted (barge-in re-arm)`)
      } else {
        logger.error(`[voice-live ${sess.id}] Claude session error: ${msg}`)
        sendJson(sess.ws, { type: 'error', message: msg })
        // Non-abort error: bail out of the re-arm loop. The client
        // sees the error message and can reconnect the WS to start
        // fresh. Continuing to re-arm on real errors would just
        // loop the same failure forever.
        break
      }
    }

    // ALWAYS exit after one query — whether closed, natural end, or
    // barge-in. Spawning a fresh query() while `bargeInPending` is
    // true but the user's actual utterance hasn't been transcribed
    // yet would cause Claude to respond to just the seed+history,
    // ignoring what the user is trying to say. Instead we let the
    // driver die and let `transcribeAndTurn` spin up a fresh driver
    // once the utterance-end + STT completes.
    break
  }
  } finally {
    sess.driverRunning = false
  }
}

/** Buffer streaming text, extract complete sentences, fire them at TTS.
 *  Also accumulates the raw text into `currentAssistantText` so we can
 *  commit it to `history` at the end of the turn (for re-arm replay). */
function handleAssistantText(sess: VoiceSession, chunk: string): void {
  // Post-abort race: text_delta events can still arrive between the
  // moment we call abortController.abort() and when the SDK's fetch
  // actually terminates. Silently drop them — turning them into TTS
  // sentences after a barge-in would produce "ghost" audio that the
  // user perceives as the agent briefly continuing.
  if (sess.bargeInPending || sess.closed) return
  sess.currentAssistantText += chunk
  sess.ttsBuffer += chunk
  const { sentences, rest } = extractSentences(sess.ttsBuffer)
  sess.ttsBuffer = rest
  for (const raw of sentences) {
    // Defense-in-depth: even with an explicit "no markdown" system
    // prompt, long conversations can drift into asterisks and hash
    // headings. Strip them before both the caption and the TTS see
    // them so the user never hears "asterisk asterisk".
    const s = sanitizeForSpeech(raw)
    // A sentence that was entirely markdown (e.g. a horizontal rule
    // line, or an empty bullet) leaves nothing to speak. Skip it —
    // synthesizing empty text just wastes a Kokoro round-trip and
    // creates a suspicious silent audio-start / audio-end pair on the
    // client.
    if (!s) continue
    // Announce the text for on-screen captions BEFORE the audio arrives
    // — the client can render subtitles slightly ahead of the audio,
    // which reads as tight lip-sync in practice.
    sendJson(sess.ws, { type: 'assistant-text', text: s })
    void speakSentence(sess, s)
  }
}

// ============================================================
// TTS pipeline — Kokoro synthesis, one sentence at a time
// ============================================================
//
// We keep a per-session cancel token so barge-in can invalidate any
// synthesis that's mid-flight. Sentences synthesize sequentially (a
// promise chain) so audio frames arrive at the client in order — the
// browser side plays them from a FIFO.

async function speakSentence(sess: VoiceSession, text: string): Promise<void> {
  const token = sess.ttsCancelToken
  try {
    // Serialize — wait for the previous sentence to finish streaming.
    // Priority 3A: Event-driven gate replaces setTimeout polling.
    // The previous sentence's finally block will resolve this gate.
    while (sess.ttsInFlight && !token.cancelled && !sess.closed) {
      // Create a gate for this sentence to wait on
      const gate = deferred<void>()
      sess.ttsFlushedGate = gate
      await gate.promise
    }
    if (token.cancelled || sess.closed) return
    sess.ttsInFlight = true

    const { pcm, sampleRate, audioMs, synthMs } = await synthesizePcm16(text, {
      voice: sess.voice,
      outSampleRate: 24000,
    })
    if (token.cancelled || sess.closed) return

    sendJson(sess.ws, { type: 'audio-start', sampleRate, format: 'pcm16le', chars: text.length })
    // Send as chunks so the client can start playing as bytes arrive
    // instead of waiting for the full sentence.
    // Priority 3B: Adaptive chunks — scale by synthesis RTF for smoother playback
    const baseChunk = 8000 // 250ms of audio at 16-bit 24kHz mono
    const rtf = synthMs / audioMs
    const adaptiveRtf = Math.max(0.3, Math.min(1.5, rtf))
    const scaledChunk = Math.round(baseChunk / adaptiveRtf)
    const chunk = Math.max(4000, Math.min(16000, scaledChunk))

    for (let i = 0; i < pcm.length; i += chunk) {
      if (token.cancelled || sess.closed) return
      sess.ws.send(pcm.subarray(i, Math.min(i + chunk, pcm.length)))
    }
    sendJson(sess.ws, { type: 'audio-end' })
    logger.debug(`[voice-live ${sess.id}] spoke "${text.slice(0, 40)}…" synth=${synthMs}ms audio=${audioMs}ms rtf=${rtf.toFixed(2)}x chunk=${chunk}`)
  } catch (err) {
    if (!sess.closed) {
      logger.error(`[voice-live ${sess.id}] TTS failed:`, err)
    }
  } finally {
    sess.ttsInFlight = false
    // Priority 3A: Trigger the gate so the next waiting sentence can proceed
    if (sess.ttsFlushedGate) {
      sess.ttsFlushedGate.resolve()
      sess.ttsFlushedGate = null
    }
  }
}

// ============================================================
// Barge-in
// ============================================================

function handleInterrupt(sess: VoiceSession): void {
  logger.info(`[voice-live ${sess.id}] barge-in`)
  sess.lastBargeInAt = Date.now()
  // 1. Invalidate any TTS in flight; the pending speakSentence() calls
  //    check this token and short-circuit before their next byte.
  sess.ttsCancelToken.cancelled = true
  sess.ttsCancelToken = { cancelled: false }
  sess.ttsBuffer = ''
  // Priority 3A: Trigger flushed gate to wake pending speakSentence waiters
  if (sess.ttsFlushedGate) {
    sess.ttsFlushedGate.resolve()
    sess.ttsFlushedGate = null
  }
  // 2. Drop both sides of the in-flight turn from history. The user
  //    cut us off before we finished; committing a partial assistant
  //    reply would misrepresent the conversation ("I said X" when I
  //    actually said Xy). The user text also stays out — they're
  //    about to speak again, and that new utterance becomes the turn
  //    of record.
  sess.currentAssistantText = ''
  sess.currentUserText = null
  // 3. Mark re-arm intent and abort the LLM. The abort makes the
  //    for-await in runClaudeSession throw AbortError, which the catch
  //    absorbs; the outer while-loop then re-invokes query() with the
  //    accumulated history + any queued utterance from the new turn.
  sess.bargeInPending = true
  try { sess.abortController.abort() } catch { /* ignore */ }
  // Release the awaiting generator too so it exits its while-loop
  // instead of blocking on a deferred that will never resolve.
  if (sess.nextUserMsgDeferred) {
    sess.nextUserMsgDeferred.resolve(null)
    sess.nextUserMsgDeferred = null
  }
}

// ============================================================
// STT — batch on utterance-end
// ============================================================

async function transcribeAndTurn(sess: VoiceSession): Promise<void> {
  const pcm = Buffer.concat(sess.utteranceBuffer)
  sess.utteranceBuffer = []
  if (pcm.length < 3200 /* ~100ms */) {
    logger.debug(`[voice-live ${sess.id}] utterance too short, skipping`)
    return
  }
  // Grace period: swallow utterances that arrive right after a barge-in.
  // These are usually the mic capturing the tail of the interrupted TTS
  // through the speakers — not a real user turn. Real user speech comes
  // in ≥400 ms later because the VAD needed a few frames to trigger,
  // which by then is outside the grace window.
  const sinceBargeIn = Date.now() - sess.lastBargeInAt
  if (sinceBargeIn < BARGE_IN_GRACE_MS) {
    logger.info(`[voice-live ${sess.id}] utterance dropped (${sinceBargeIn}ms after barge-in, likely echo)`)
    return
  }
  try {
    const rawText = (await transcribeUtterancePcm16(pcm, sess.language)).trim()
    if (!rawText || rawText.length < 2) {
      logger.debug(`[voice-live ${sess.id}] empty transcript, skipping`)
      return
    }
    // If new attachments arrived since the last turn AND we're feeding
    // this into an active query() (not a re-arm — those rebuild the
    // seed which includes attachments), prepend a note about them so
    // Claude sees the new material. Re-arm paths handle their own
    // announcement via buildDocsContext in userTurnGenerator, which
    // also clears `pendingAnnounce`.
    const pendingNow = sess.attachments.filter((a) => a.pendingAnnounce)
    let text = rawText
    if (pendingNow.length > 0 && !sess.bargeInPending) {
      const notes = pendingNow.map((a) => {
        // Include the actual text of the attachment inline so the
        // model can reason about it in the current turn without
        // waiting for the next re-arm's seed. Capped per-attachment
        // to keep the injected note reasonable.
        return `[New attachment: ${a.label} (${a.chars} chars)]\n${a.text}`
      }).join('\n\n')
      text = `${notes}\n\n---\n${rawText}`
      for (const a of pendingNow) a.pendingAnnounce = false
      logger.info(`[voice-live ${sess.id}] injected ${pendingNow.length} pending attachment(s) into user turn`)
    }
    sendJson(sess.ws, { type: 'transcript-final', text: rawText })
    // NOTE: we do NOT push to history here. The user turn only becomes
    // "committed" once the assistant actually replies to it — that
    // pairing (user + assistant) is what gets stored, in runClaudeSession
    // at the assistant-event boundary. Pushing here would duplicate the
    // last user turn: once in history, once again as queuedUserText for
    // the fresh driver spawn.

    // Route the utterance to whichever consumer is ready:
    //   A. A live query() is awaiting on the gate → resolve it and let
    //      the async generator yield it as the next message.
    //   B. No live consumer (either the session went idle after a natural
    //      end, or a barge-in is pending / just happened) → stash it in
    //      queuedUserText and spin up a fresh runClaudeSession, whose
    //      generator picks up the queued utterance right after replaying
    //      the seed.
    const d = sess.nextUserMsgDeferred
    if (d) {
      sess.nextUserMsgDeferred = null
      sess.currentUserText = text
      d.resolve(text)
    } else {
      // Queue the text so the driver picks it up as its first turn.
      // If a barge-in queued something and this utterance arrives
      // right after, we OVERWRITE — the newer utterance is what the
      // user actually wants answered.
      sess.queuedUserText = text
      // Mutex: only spawn a fresh driver if none is running. If one
      // IS running (e.g. mid-abort settling), it'll pick up
      // queuedUserText on its next iteration. Without this guard,
      // rapid utterances during barge-in produced multiple parallel
      // drivers, each streaming into the same WS — the "overload"
      // where the agent seems to talk over itself.
      if (!sess.driverRunning) {
        void runClaudeSession(sess).catch((err) => {
          logger.error(`[voice-live ${sess.id}] re-arm failed:`, err)
        })
      } else {
        logger.debug(`[voice-live ${sess.id}] driver already running, queued for next turn`)
      }
    }
  } catch (err) {
    logger.error(`[voice-live ${sess.id}] STT failed:`, err)
    sendJson(sess.ws, { type: 'error', message: 'transcription failed' })
  }
}

// ============================================================
// WS lifecycle
// ============================================================

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try { ws.send(JSON.stringify(payload)) } catch { /* ignore */ }
}

function makeSessionId(): string {
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ============================================================
// Attachment control-message handlers
// ============================================================
//
// Each handler validates + parses the incoming attachment, checks the
// per-session total budget, mutates `sess.attachments`, and replies
// with `attachment-added` (success) or `attachment-error` (failure).
// New attachments carry `pendingAnnounce: true` so the next user
// utterance prepends a note about them for Claude (see
// transcribeAndTurn). Barge-in re-arms rebuild the seed from scratch
// including all attachments and clear the flag.

function replyAttachmentError(sess: VoiceSession, message: string): void {
  sendJson(sess.ws, { type: 'attachment-error', message })
}

function tryAddAttachment(sess: VoiceSession, next: Attachment): boolean {
  const projected = totalAttachmentChars(sess.attachments) + next.chars
  if (projected > MAX_TOTAL_ATTACHMENT_CHARS) {
    replyAttachmentError(sess,
      `Attachment budget exceeded (${projected} / ${MAX_TOTAL_ATTACHMENT_CHARS} chars). Remove an attachment first.`)
    return false
  }
  sess.attachments.push(next)
  sendJson(sess.ws, {
    type: 'attachment-added',
    id: next.id,
    source: next.source,
    label: next.label,
    chars: next.chars,
    addedAt: next.addedAt,
    totalChars: totalAttachmentChars(sess.attachments),
  })
  logger.info(
    `[voice-live ${sess.id}] attachment added · source=${next.source} · label="${next.label}" · ` +
    `${next.chars} chars · total=${totalAttachmentChars(sess.attachments)}`
  )
  return true
}

/** Parse a `{type:'attach-file', name, mime, dataBase64}` message.
 *  Decodes the base64 payload, dispatches to the PDF / text / html
 *  parser based on file extension, and hands the extracted text off
 *  to tryAddAttachment. */
async function handleAttachFile(sess: VoiceSession, msg: Record<string, unknown>): Promise<void> {
  const name = typeof msg.name === 'string' ? msg.name : 'unnamed'
  const b64 = typeof msg.dataBase64 === 'string' ? msg.dataBase64 : ''
  if (!b64) { replyAttachmentError(sess, 'attach-file: dataBase64 required'); return }

  let buf: Buffer
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    replyAttachmentError(sess, 'attach-file: invalid base64 payload')
    return
  }
  if (buf.length === 0) { replyAttachmentError(sess, `attach-file: empty payload for ${name}`); return }
  if (buf.length > MAX_UPLOAD_BYTES) {
    replyAttachmentError(sess,
      `File too large: ${(buf.length / 1024 / 1024).toFixed(1)} MB > ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
    return
  }

  const ext = path.extname(name).toLowerCase()
  let text: string
  try {
    if (ext === '.pdf') {
      text = await parsePdfBuffer(buf, name)
    } else if (ext === '.html' || ext === '.htm') {
      text = htmlToText(buf.toString('utf-8'))
    } else if (ext === '.md' || ext === '.markdown' || ext === '.txt' || ext === '') {
      text = buf.toString('utf-8').trim()
    } else if (ext === '.json') {
      text = buf.toString('utf-8').trim()
    } else {
      // Try UTF-8 decode; reject if it looks binary.
      const asText = buf.toString('utf-8')
      if (asText.split('\0').length > 5) {
        replyAttachmentError(sess, `Unsupported file type: ${ext || '(no extension)'}`)
        return
      }
      text = asText.trim()
    }
  } catch (err: any) {
    replyAttachmentError(sess, err?.message || 'file parse failed')
    return
  }

  text = clampText(text)
  if (!text) { replyAttachmentError(sess, `${name} had no extractable text`); return }

  tryAddAttachment(sess, {
    id: makeAttachmentId(),
    source: 'upload',
    label: name,
    text,
    chars: text.length,
    addedAt: Date.now(),
    pendingAnnounce: true,
  })
}

/** Parse a `{type:'attach-url', url}` message. Fetches the URL,
 *  extracts text (HTML/PDF/text supported), and hands off. */
async function handleAttachUrl(sess: VoiceSession, msg: Record<string, unknown>): Promise<void> {
  const url = typeof msg.url === 'string' ? msg.url.trim() : ''
  if (!url) { replyAttachmentError(sess, 'attach-url: url required'); return }

  try {
    const { text, label } = await loadUrlAsText(url)
    const clamped = clampText(text)
    if (!clamped) { replyAttachmentError(sess, `${url} had no extractable text`); return }
    tryAddAttachment(sess, {
      id: makeAttachmentId(),
      source: 'url',
      label,
      text: clamped,
      chars: clamped.length,
      addedAt: Date.now(),
      pendingAnnounce: true,
    })
  } catch (err: any) {
    replyAttachmentError(sess, err?.message || 'url fetch failed')
  }
}

function handleAttachmentRemove(sess: VoiceSession, msg: Record<string, unknown>): void {
  const id = typeof msg.id === 'string' ? msg.id : ''
  const idx = sess.attachments.findIndex((a) => a.id === id)
  if (idx < 0) return
  const [removed] = sess.attachments.splice(idx, 1)
  sendJson(sess.ws, {
    type: 'attachment-removed',
    id: removed.id,
    totalChars: totalAttachmentChars(sess.attachments),
  })
  logger.info(`[voice-live ${sess.id}] attachment removed · label="${removed.label}"`)
}

/**
 * Attach the /api/voice/live WebSocket to an existing HTTP(S) server.
 * Called once from src/server/index.ts during setup — the upgrade
 * handler filters on the request path so ttyd and transcribe-live
 * routes stay untouched.
 */
export function attachVoiceLiveWS(server: HttpServer | HttpsServer): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || ''
    if (!url.startsWith('/api/voice/live')) return
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', async (ws, req) => {
    const id = makeSessionId()
    let sess: VoiceSession | null = null
    try {
      const url = new URL(req.url || '/', 'http://x')
      const projectB64 = url.searchParams.get('project') || ''
      const relPath = url.searchParams.get('path') || ''
      const language = url.searchParams.get('language') || 'en'
      const voice = url.searchParams.get('voice') || ''
      if (!projectB64) {
        sendJson(ws, { type: 'error', message: 'project query param required' })
        ws.close()
        return
      }
      // `path` is optional: with it, we auto-load that file as the
      // initial attachment (HTML preview `?voice=1` flow); without it,
      // the session starts empty and attachments arrive via control
      // messages (standalone /agent page flow).
      const projectPath = decodeProjectB64(projectB64)
      // Two entry modes:
      //   A. Preview flow (path present): auto-load that file as the
      //      initial attachment. Backwards-compat with the HTML
      //      preview `?voice=1` route.
      //   B. Standalone agent (path omitted): start empty; the client
      //      will send `attach-file` / `attach-url` control messages
      //      to populate the context.
      const initialAttachments: Attachment[] = []
      if (relPath) {
        try {
          const docText = clampText(await loadDocContext(projectPath, relPath))
          initialAttachments.push({
            id: makeAttachmentId(),
            source: 'project-file',
            label: relPath,
            text: docText,
            chars: docText.length,
            addedAt: Date.now(),
            pendingAnnounce: false,
          })
        } catch (err: any) {
          // Refuse the connection if the caller asked for a specific
          // file that we can't load — the client set up its UI
          // expecting that doc to be present.
          throw err
        }
      }
      const voices = await listKokoroVoices()
      const chosenVoice = voice && voices.includes(voice) ? voice : voices[0]

      sess = {
        id,
        ws,
        language,
        voice: chosenVoice,
        projectPath,
        attachments: initialAttachments,
        utteranceBuffer: [],
        history: [],
        currentUserText: null,
        currentAssistantText: '',
        nextUserMsgDeferred: null,
        abortController: new AbortController(),
        bargeInPending: false,
        queuedUserText: null,
        driverRunning: false,
        lastBargeInAt: 0,
        ttsBuffer: '',
        ttsInFlight: false,
        ttsCancelToken: { cancelled: false },
        ttsFlushedGate: null,
        closed: false,
        startedAt: Date.now(),
      }
      activeSessions.add(sess)
      logger.info(
        `[voice-live ${id}] open · project=${projectPath} · initial-attachments=${initialAttachments.length} ` +
        `(${totalAttachmentChars(initialAttachments)} chars) · voice=${chosenVoice}`
      )

      // Warm Kokoro and Whisper in parallel with the ready signal so the first
      // synthesis and transcription don't eat the model load time.
      void getKokoro().catch((err) => logger.warn(`[voice-live ${id}] kokoro warmup failed: ${err.message}`))
      void getWhisperServer().catch((err) => logger.warn(`[voice-live ${id}] whisper warmup failed: ${err.message}`))

      sendJson(ws, {
        type: 'ready',
        voices,
        voice: chosenVoice,
        // New shape: attachments array with per-item metadata. Kept
        // `docChars` + `docPath` alongside so the existing HTML
        // preview widget (which reads those fields) still works.
        attachments: initialAttachments.map(({ id: aid, source, label, chars, addedAt }) => ({
          id: aid, source, label, chars, addedAt,
        })),
        docChars: totalAttachmentChars(initialAttachments),
        docPath: relPath || null,
      })

      // NOTE: we intentionally do NOT spawn runClaudeSession here.
      // The first user utterance (`transcribeAndTurn`) will spawn it
      // via the "no live consumer" path, folding the utterance into
      // the seed as a single user turn. Spawning here would send just
      // the seed (with no queued user text) to Claude, and Claude
      // would greet the user unprompted with something like "Hey,
      // ready when you are" — annoying and burns tokens.
    } catch (err: any) {
      logger.error(`[voice-live ${id}] init failed:`, err)
      sendJson(ws, { type: 'error', message: err.message || 'init failed' })
      ws.close()
      return
    }

    ws.on('message', async (data, isBinary) => {
      if (!sess || sess.closed) return
      if (isBinary && data instanceof Buffer) {
        sess.utteranceBuffer.push(data)
        return
      }
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      switch (msg.type) {
        case 'utterance-end':
          await transcribeAndTurn(sess)
          break
        case 'interrupt':
          handleInterrupt(sess)
          break
        case 'set-voice':
          if (typeof msg.voice === 'string') sess.voice = msg.voice
          break
        case 'ping':
          sendJson(ws, { type: 'pong' })
          break
        case 'attach-file':
          await handleAttachFile(sess, msg)
          break
        case 'attach-url':
          await handleAttachUrl(sess, msg)
          break
        case 'attachment-remove':
          handleAttachmentRemove(sess, msg)
          break
      }
    })

    ws.on('close', () => {
      if (!sess) return
      sess.closed = true
      sess.ttsCancelToken.cancelled = true
      // Release the awaiting generator with the null stop sentinel. We
      // used to reject with an Error here — that surfaced as an
      // unhandled rejection and crashed the whole Node process, which
      // in turn crashed orka ~340 times before the fix.
      if (sess.nextUserMsgDeferred) {
        sess.nextUserMsgDeferred.resolve(null)
        sess.nextUserMsgDeferred = null
      }
      try { sess.abortController.abort() } catch { /* ignore */ }
      activeSessions.delete(sess)
      logger.info(`[voice-live ${sess.id}] closed after ${((Date.now() - sess.startedAt) / 1000).toFixed(1)}s`)
    })

    ws.on('error', (err) => {
      logger.warn(`[voice-live ${id}] ws error: ${err.message}`)
    })
  })
}
