import { Router, Request, Response } from 'express'
import execa from 'execa'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { createReadStream } from 'fs'
import { randomUUID } from 'crypto'
import { logger } from '../../utils'
import { getWhisperServer } from '../../utils/whisper'

export const englishRouter = Router()

const CLIPS_DIR = path.join(os.homedir(), '.orka', 'english-clips')
const INDEX_PATH = path.join(CLIPS_DIR, 'index.json')
const MAX_AUDIO_BYTES = 150 * 1024 * 1024

export interface ClipSegment {
  start: number
  end: number
  text: string
}

interface ClipRow {
  id: string
  name: string
  filename: string
  mimeType: string
  bytes: number
  durationSec: number | null
  createdAt: string
  status: 'transcribing' | 'ready' | 'failed'
  transcript: string
  segments?: ClipSegment[]
  error?: string
  source?: 'upload' | 'chrome-ext'
}

interface ClipIndex {
  clips: ClipRow[]
}

export async function loadEnglishClip(id: string): Promise<ClipRow | null> {
  const idx = await readIndex()
  return idx.clips.find((c) => c.id === id) || null
}

/**
 * Fetch a clip from a remote Orka instance over HTTPS. Used by voice-live
 * so a Discuss/Standup session running on THIS server can attach a clip
 * that lives on the user's MacBook (or any other registered Orka host).
 * Timeout bounded so a stale host doesn't hang the WS open.
 */
export async function fetchRemoteClip(host: string, id: string): Promise<ClipRow | null> {
  const safeHost = host.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(safeHost)) return null
  try {
    const res = await fetch(`${safeHost}/api/english/clips/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null) as { clip?: Partial<ClipRow> & { hasAudio?: boolean } } | null
    const c = data?.clip
    if (!c || !c.id) return null
    return {
      id: c.id,
      name: c.name || `clip ${c.id}`,
      filename: 'audio.mp3',
      mimeType: c.mimeType || 'audio/mpeg',
      bytes: c.bytes || 0,
      durationSec: c.durationSec ?? null,
      createdAt: c.createdAt || new Date().toISOString(),
      status: 'ready',
      transcript: c.transcript || '',
      segments: c.segments,
      source: c.source,
    }
  } catch {
    return null
  }
}

async function readIndex(): Promise<ClipIndex> {
  await fs.ensureDir(CLIPS_DIR)
  if (!(await fs.pathExists(INDEX_PATH))) return { clips: [] }
  try {
    return (await fs.readJson(INDEX_PATH)) as ClipIndex
  } catch {
    return { clips: [] }
  }
}

async function writeIndex(idx: ClipIndex): Promise<void> {
  await fs.ensureDir(CLIPS_DIR)
  await fs.writeJson(INDEX_PATH, idx, { spaces: 2 })
}

function clipFolder(id: string): string {
  return path.join(CLIPS_DIR, id)
}

function clipAudioPath(clip: ClipRow): string {
  return path.join(clipFolder(clip.id), clip.filename)
}

function publicClip(c: ClipRow): Omit<ClipRow, 'filename'> & { hasAudio: boolean } {
  const { filename, ...rest } = c
  return { ...rest, hasAudio: !!filename }
}

async function probeDurationSec(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execa('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ])
    const n = parseFloat(stdout.trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

async function convertToWav(input: string, output: string): Promise<void> {
  await execa('ffmpeg', [
    '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', output,
  ])
}

/**
 * Transcode to a playback-friendly mp3. MediaRecorder-produced webm files
 * don't carry a Duration element in the Segment Info block, so the HTML5
 * <audio> element can't render a usable seek bar for them — the progress
 * bar sits at 100% from the start and the user can't rewind. mp3 always
 * has a valid duration and is universally supported by audio elements,
 * so we transcode once at transcribe time and serve the mp3.
 */
async function convertToMp3(input: string, output: string): Promise<void> {
  await execa('ffmpeg', [
    '-i', input,
    '-codec:a', 'libmp3lame',
    '-q:a', '4',
    '-ac', '1',
    '-y',
    output,
  ])
}

/**
 * Call whisper-server directly to get segment-level timestamps (verbose_json).
 * The utility's .transcribe() method hardcodes no_timestamps=true, so we go
 * around it to keep the segments payload. Returns both the stitched text and
 * the per-segment timing used for live highlighting.
 */
async function transcribeWithSegments(wav: Buffer, language: string): Promise<{ text: string; segments: ClipSegment[] }> {
  const whisper = await getWhisperServer()
  await whisper.ready
  const form = new FormData()
  const view = new Uint8Array(wav.byteLength)
  view.set(wav)
  form.append('file', new Blob([view], { type: 'audio/wav' }), 'chunk.wav')
  form.append('language', language)
  form.append('response_format', 'verbose_json')
  form.append('suppress_nst', 'true')
  const resp = await fetch(whisper.url + '/inference', { method: 'POST', body: form as any })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => resp.statusText)
    throw new Error(`whisper-server ${resp.status}: ${detail.slice(0, 200)}`)
  }
  const parsed = await resp.json().catch(() => null) as
    | { text?: string; segments?: Array<{ start?: number; end?: number; text?: string }> }
    | null
  if (!parsed) return { text: '', segments: [] }
  const segments: ClipSegment[] = (parsed.segments || [])
    .map((s) => ({
      start: Number(s?.start) || 0,
      end: Number(s?.end) || 0,
      text: String(s?.text || '').trim(),
    }))
    .filter((s) => s.text.length > 0)
  const stitched = (parsed.text || segments.map((s) => s.text).join(' ')).trim()
  return { text: stitched, segments }
}

async function transcribeClipInBackground(clip: ClipRow): Promise<void> {
  const audio = clipAudioPath(clip)
  const wavPath = path.join(clipFolder(clip.id), 'audio.wav')
  const mp3Path = path.join(clipFolder(clip.id), 'audio.mp3')
  try {
    await convertToWav(audio, wavPath)
    const wav = await fs.readFile(wavPath)
    // WAV always has an accurate duration; MediaRecorder webm files often
    // don't have one in the container header (Chrome streams Cues at end
    // of writing which is missing when the recorder was just stopped),
    // so ffprobe on the source returns a bogus value. Probe the WAV instead.
    const wavDuration = await probeDurationSec(wavPath)

    const { text, segments } = await transcribeWithSegments(wav, 'auto')

    // Transcode to mp3 for playback (see convertToMp3 comment).
    const originalPath = audio
    const originalWasMp3 = clip.filename === 'audio.mp3'
    if (!originalWasMp3) {
      await convertToMp3(originalPath, mp3Path)
    }

    const idx = await readIndex()
    const row = idx.clips.find((c) => c.id === clip.id)
    if (row) {
      row.status = 'ready'
      row.transcript = text
      row.segments = segments
      if (wavDuration !== null) row.durationSec = wavDuration
      if (!originalWasMp3) {
        row.filename = 'audio.mp3'
        row.mimeType = 'audio/mpeg'
        try {
          const mp3Stat = await fs.stat(mp3Path)
          row.bytes = mp3Stat.size
        } catch { /* drop */ }
      }
      await writeIndex(idx)
    }

    // Swap complete — safe to delete the original source file.
    if (!originalWasMp3) {
      try { await fs.remove(originalPath) } catch { /* drop */ }
    }
    logger.info(`[english-clips] transcribed ${clip.id} (${text.length} chars, ${segments.length} segments, ${wavDuration?.toFixed(1)}s)`)
  } catch (err: any) {
    logger.error(`[english-clips] transcribe failed for ${clip.id}:`, err)
    const idx = await readIndex()
    const row = idx.clips.find((c) => c.id === clip.id)
    if (row) {
      row.status = 'failed'
      row.error = err?.message || 'transcription failed'
      await writeIndex(idx)
    }
  } finally {
    try { await fs.remove(wavPath) } catch { /* drop */ }
  }
}

/**
 * Return only the transcript text between [startSec, endSec] based on the
 * clip's whisper segments. Falls back to the whole transcript when the
 * range isn't specified or the clip has no segments. Used by vocab-mine
 * and cloze to scope exercises to a slice of the audio.
 */
function sliceTranscript(clip: ClipRow, startQ: unknown, endQ: unknown): string {
  const start = parseFinite(startQ)
  const end = parseFinite(endQ)
  if (start === null && end === null) return clip.transcript || ''
  const segs = clip.segments || []
  if (segs.length === 0) return clip.transcript || ''
  const lo = start ?? 0
  const hi = end ?? Number.POSITIVE_INFINITY
  const picked = segs.filter((s) => s.end > lo && s.start < hi).map((s) => s.text).join(' ').trim()
  return picked || clip.transcript || ''
}

function parseFinite(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

function extFromMime(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('mp3') || m.includes('mpeg')) return 'mp3'
  if (m.includes('wav')) return 'wav'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('webm')) return 'webm'
  if (m.includes('m4a') || m.includes('mp4') || m.includes('aac')) return 'm4a'
  if (m.includes('flac')) return 'flac'
  return 'bin'
}

function normalizeAudioMime(mime: string): string {
  const m = mime.toLowerCase().trim()
  if (!m || m === 'application/octet-stream') return 'audio/mpeg'
  if (m.startsWith('audio/')) return m
  if (m.includes('webm')) return 'audio/webm'
  if (m.includes('ogg')) return 'audio/ogg'
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'audio/mp4'
  if (m.includes('wav')) return 'audio/wav'
  if (m.includes('mpeg') || m.includes('mp3')) return 'audio/mpeg'
  if (m.includes('flac')) return 'audio/flac'
  return m
}

// ---------- Clip CRUD ----------

englishRouter.get('/clips', async (_req, res) => {
  try {
    const idx = await readIndex()
    const sorted = [...idx.clips].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    res.json({ clips: sorted.map(publicClip) })
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'failed to list clips' })
  }
})

englishRouter.get('/clips/:id', async (req, res) => {
  try {
    const idx = await readIndex()
    const clip = idx.clips.find((c) => c.id === req.params.id)
    if (!clip) { res.status(404).json({ error: 'clip not found' }); return }
    res.json({ clip: publicClip(clip) })
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'failed to load clip' })
  }
})

englishRouter.get('/clips/:id/audio', async (req, res) => {
  try {
    const idx = await readIndex()
    const clip = idx.clips.find((c) => c.id === req.params.id)
    if (!clip) { res.status(404).json({ error: 'clip not found' }); return }
    const audio = clipAudioPath(clip)
    if (!(await fs.pathExists(audio))) { res.status(410).json({ error: 'audio missing' }); return }
    res.setHeader('Content-Type', clip.mimeType || 'audio/mpeg')
    res.setHeader('Accept-Ranges', 'bytes')
    const range = req.headers.range
    const stat = await fs.stat(audio)
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-')
      const start = startStr ? parseInt(startStr, 10) : 0
      const end = endStr ? parseInt(endStr, 10) : stat.size - 1
      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
      res.setHeader('Content-Length', String(end - start + 1))
      createReadStream(audio, { start, end }).pipe(res)
    } else {
      res.setHeader('Content-Length', String(stat.size))
      createReadStream(audio).pipe(res)
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'failed to stream audio' })
  }
})

englishRouter.post('/clips', async (req: Request, res: Response) => {
  try {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'upload must be raw audio bytes' })
      return
    }
    const buf: Buffer = req.body
    if (buf.length === 0) { res.status(400).json({ error: 'empty upload' }); return }
    if (buf.length > MAX_AUDIO_BYTES) {
      res.status(413).json({ error: `audio exceeds ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)}MB limit` })
      return
    }

    const name = String(req.query.name || '').trim() || `clip-${new Date().toISOString().slice(0, 10)}`
    const rawType = String(req.headers['content-type'] || 'audio/mpeg').split(';')[0].trim()
    const mimeType = normalizeAudioMime(rawType)
    const id = randomUUID()
    const ext = extFromMime(mimeType)
    const filename = `audio.${ext}`

    await fs.ensureDir(clipFolder(id))
    const audio = path.join(clipFolder(id), filename)
    await fs.writeFile(audio, buf)

    const durationSec = await probeDurationSec(audio)
    const clip: ClipRow = {
      id, name, filename, mimeType, bytes: buf.length, durationSec,
      createdAt: new Date().toISOString(),
      status: 'transcribing', transcript: '',
      source: 'upload',
    }

    const idx = await readIndex()
    idx.clips.push(clip)
    await writeIndex(idx)

    void transcribeClipInBackground(clip)

    res.status(201).json({ clip: publicClip(clip) })
  } catch (err: any) {
    logger.error('[english-clips] upload failed:', err)
    res.status(500).json({ error: err.message || 'upload failed' })
  }
})

englishRouter.delete('/clips/:id', async (req, res) => {
  try {
    const idx = await readIndex()
    const i = idx.clips.findIndex((c) => c.id === req.params.id)
    if (i === -1) { res.status(404).json({ error: 'clip not found' }); return }
    idx.clips.splice(i, 1)
    await writeIndex(idx)
    try { await fs.remove(clipFolder(req.params.id)) } catch { /* drop */ }
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'failed to delete clip' })
  }
})

englishRouter.post('/clips/:id/retranscribe', async (req, res) => {
  try {
    const idx = await readIndex()
    const clip = idx.clips.find((c) => c.id === req.params.id)
    if (!clip) { res.status(404).json({ error: 'clip not found' }); return }
    clip.status = 'transcribing'
    clip.error = undefined
    await writeIndex(idx)
    void transcribeClipInBackground(clip)
    res.json({ clip: publicClip(clip) })
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'failed to re-transcribe' })
  }
})

// ---------- Vocabulary mining ----------

interface VocabCard {
  term: string
  partOfSpeech: string
  definition: string
  example: string
  sourceLine: string
}

englishRouter.post('/vocab-mine/:id', async (req, res) => {
  try {
    const idx = await readIndex()
    const clip = idx.clips.find((c) => c.id === req.params.id)
    if (!clip) { res.status(404).json({ error: 'clip not found' }); return }
    if (!clip.transcript) { res.status(400).json({ error: 'transcript not ready yet' }); return }

    const text = sliceTranscript(clip, req.query.startSec, req.query.endSec)
    if (!text) { res.status(400).json({ error: 'no transcript in that range' }); return }

    const prompt = `You are an English vocabulary coach for a Spanish speaker. From the transcript below, extract up to 10 useful vocabulary items: phrasal verbs, idioms, collocations, less-common connectors, business/work jargon. Skip trivial words the user already knows at intermediate level.

Return ONLY a JSON object with this exact shape (no code fences, no commentary):

{
  "cards": [
    {
      "term": "the term or phrase as it appears in English",
      "partOfSpeech": "noun | verb | phrasal verb | idiom | collocation | connector",
      "definition": "short definition in Spanish",
      "example": "a short English sentence (not from the transcript) that uses the term",
      "sourceLine": "the exact substring from the transcript where this appeared"
    }
  ]
}

Rules:
- Max 10 cards, ordered most-useful first.
- "sourceLine" must be a verbatim substring from the transcript.
- "definition" in Spanish; "example" and "term" in English.
- If the transcript is too short or has nothing worth teaching, return {"cards": []}.
- JSON ONLY. No markdown. No preamble.`

    const { stdout } = await execa('claude', ['-p', prompt, '--model', 'sonnet', '--no-session-persistence'], {
      timeout: 60000,
      env: { ...process.env, CLAUDECODE: '' },
      extendEnv: false,
      input: text,
    })

    let raw = stdout.trim()
    if (raw.startsWith('```json')) raw = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '')
    else if (raw.startsWith('```')) raw = raw.replace(/^```\s*/, '').replace(/\s*```$/, '')

    let parsed: any
    try { parsed = JSON.parse(raw) }
    catch { res.status(502).json({ error: 'model returned non-JSON', raw }); return }

    const cards: VocabCard[] = (Array.isArray(parsed?.cards) ? parsed.cards : [])
      .slice(0, 10)
      .map((c: any) => ({
        term: String(c?.term || ''),
        partOfSpeech: String(c?.partOfSpeech || ''),
        definition: String(c?.definition || ''),
        example: String(c?.example || ''),
        sourceLine: String(c?.sourceLine || ''),
      }))
      .filter((c: VocabCard) => c.term && c.definition)

    res.json({ cards })
  } catch (err: any) {
    logger.error('[english] vocab-mine failed:', err)
    res.status(500).json({ error: err.message || 'vocab mining failed' })
  }
})

// ---------- Cloze (fill in the blank) ----------

interface ClozeBlank {
  idx: number
  answer: string
  hint: string
}

interface ClozeResult {
  text: string
  blanks: ClozeBlank[]
}

englishRouter.post('/cloze/:id', async (req, res) => {
  try {
    const idx = await readIndex()
    const clip = idx.clips.find((c) => c.id === req.params.id)
    if (!clip) { res.status(404).json({ error: 'clip not found' }); return }
    if (!clip.transcript) { res.status(400).json({ error: 'transcript not ready yet' }); return }

    const text = sliceTranscript(clip, req.query.startSec, req.query.endSec)
    if (!text) { res.status(400).json({ error: 'no transcript in that range' }); return }

    const prompt = `You are an English listening coach. The transcript below is from a recording the student just listened to. Build a cloze exercise: pick up to 10 words/short phrases worth testing (phrasal verbs, connectors, collocations, prepositions, articles that native speakers get right without thinking). Replace each with a blank placeholder in the text.

Return ONLY a JSON object (no code fences, no commentary) with this shape:

{
  "text": "the full transcript with chosen words replaced by {{0}}, {{1}}, {{2}}, ... in order",
  "blanks": [
    { "idx": 0, "answer": "the exact word or short phrase that was removed", "hint": "very short hint in Spanish (max 5 words)" }
  ]
}

Rules:
- "text" preserves the rest of the transcript unchanged.
- Placeholders are exactly {{N}} with N starting at 0, no spaces inside braces.
- Indices in "blanks" match placeholders.
- Max 10 blanks. Pick quality over quantity.
- Keep each blanked span to 1-3 words.
- JSON ONLY.`

    const { stdout } = await execa('claude', ['-p', prompt, '--model', 'sonnet', '--no-session-persistence'], {
      timeout: 60000,
      env: { ...process.env, CLAUDECODE: '' },
      extendEnv: false,
      input: text,
    })

    let raw = stdout.trim()
    if (raw.startsWith('```json')) raw = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '')
    else if (raw.startsWith('```')) raw = raw.replace(/^```\s*/, '').replace(/\s*```$/, '')

    let parsed: any
    try { parsed = JSON.parse(raw) }
    catch { res.status(502).json({ error: 'model returned non-JSON', raw }); return }

    const result: ClozeResult = {
      text: String(parsed?.text || ''),
      blanks: (Array.isArray(parsed?.blanks) ? parsed.blanks : []).map((b: any, i: number) => ({
        idx: typeof b?.idx === 'number' ? b.idx : i,
        answer: String(b?.answer || ''),
        hint: String(b?.hint || ''),
      })).filter((b: ClozeBlank) => b.answer),
    }
    res.json(result)
  } catch (err: any) {
    logger.error('[english] cloze failed:', err)
    res.status(500).json({ error: err.message || 'cloze generation failed' })
  }
})

// ---------- Shadow diff (user's recording vs original clip) ----------

englishRouter.post('/shadow-diff', async (req: Request, res: Response) => {
  try {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'upload must be raw audio bytes' })
      return
    }
    const original = String(req.query.original || '')
    if (!original.trim()) { res.status(400).json({ error: 'original query param required' }); return }

    const tmpDir = path.join(os.tmpdir(), 'orka-english-shadow')
    await fs.ensureDir(tmpDir)
    const id = randomUUID()
    const rawPath = path.join(tmpDir, `${id}.raw`)
    const wavPath = path.join(tmpDir, `${id}.wav`)
    try {
      await fs.writeFile(rawPath, req.body)
      await convertToWav(rawPath, wavPath)
      const wav = await fs.readFile(wavPath)
      const whisper = await getWhisperServer()
      const userText = await whisper.transcribe(wav, { language: 'en' })

      const diff = tokenDiff(original, userText)
      res.json({ userText, diff, score: diff.score })
    } finally {
      try { await fs.remove(rawPath) } catch { /* drop */ }
      try { await fs.remove(wavPath) } catch { /* drop */ }
    }
  } catch (err: any) {
    logger.error('[english] shadow-diff failed:', err)
    res.status(500).json({ error: err.message || 'shadow diff failed' })
  }
})

interface DiffToken {
  original: string | null
  spoken: string | null
  status: 'match' | 'substituted' | 'missed' | 'extra'
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim()
}

function tokenDiff(original: string, spoken: string): { tokens: DiffToken[]; score: number } {
  const a = normalize(original).split(' ').filter(Boolean)
  const b = normalize(spoken).split(' ').filter(Boolean)
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  const tokens: DiffToken[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      tokens.unshift({ original: a[i - 1], spoken: b[j - 1], status: 'match' })
      i--; j--
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      tokens.unshift({ original: a[i - 1], spoken: b[j - 1], status: 'substituted' })
      i--; j--
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      tokens.unshift({ original: a[i - 1], spoken: null, status: 'missed' })
      i--
    } else {
      tokens.unshift({ original: null, spoken: b[j - 1], status: 'extra' })
      j--
    }
  }
  const matches = tokens.filter((t) => t.status === 'match').length
  const score = m === 0 ? 0 : Math.round((matches / m) * 100)
  return { tokens, score }
}

// ---------- Summary grading (user's spoken summary vs original segment) ----------

englishRouter.post('/summary-grade', async (req: Request, res: Response) => {
  try {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'upload must be raw audio bytes' })
      return
    }
    const sourceText = String(req.query.source || '')
    if (!sourceText.trim()) { res.status(400).json({ error: 'source query param required' }); return }

    const tmpDir = path.join(os.tmpdir(), 'orka-english-summary')
    await fs.ensureDir(tmpDir)
    const id = randomUUID()
    const rawPath = path.join(tmpDir, `${id}.raw`)
    const wavPath = path.join(tmpDir, `${id}.wav`)
    try {
      await fs.writeFile(rawPath, req.body)
      await convertToWav(rawPath, wavPath)
      const wav = await fs.readFile(wavPath)
      const whisper = await getWhisperServer()
      const userSummary = await whisper.transcribe(wav, { language: 'en' })

      const prompt = `You are grading a user's spoken summary of an audio clip they just listened to. You are given (via stdin) first the ORIGINAL transcript and then the user's SUMMARY, separated by a line of ---. Evaluate on two axes:

1. Comprehension: did the summary capture the main points?
2. English quality: grammar, naturalness, vocabulary for a Spanish speaker practicing English.

Return ONLY a JSON object (no code fences, no commentary) with this shape:

{
  "comprehensionScore": 0-100,
  "comprehensionNote": "one short sentence in Spanish on what was captured vs missed",
  "languageScore": 0-100,
  "languageNote": "one short sentence in Spanish on how the English sounded",
  "topCorrections": [
    { "quote": "verbatim from summary", "suggestion": "better version", "explanation": "one short sentence in Spanish" }
  ]
}

Rules:
- topCorrections: max 3, ordered most-impactful first. Empty array if summary was clean.
- JSON ONLY.`

      const stdinText = `ORIGINAL:\n${sourceText.trim()}\n---\nSUMMARY:\n${userSummary.trim()}`
      const { stdout } = await execa('claude', ['-p', prompt, '--model', 'sonnet', '--no-session-persistence'], {
        timeout: 60000,
        env: { ...process.env, CLAUDECODE: '' },
        extendEnv: false,
        input: stdinText,
      })
      let raw = stdout.trim()
      if (raw.startsWith('```json')) raw = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '')
      else if (raw.startsWith('```')) raw = raw.replace(/^```\s*/, '').replace(/\s*```$/, '')

      let parsed: any
      try { parsed = JSON.parse(raw) }
      catch { res.status(502).json({ error: 'model returned non-JSON', raw, userSummary }); return }

      res.json({
        userSummary,
        comprehensionScore: Math.max(0, Math.min(100, Number(parsed?.comprehensionScore) || 0)),
        comprehensionNote: String(parsed?.comprehensionNote || ''),
        languageScore: Math.max(0, Math.min(100, Number(parsed?.languageScore) || 0)),
        languageNote: String(parsed?.languageNote || ''),
        topCorrections: (Array.isArray(parsed?.topCorrections) ? parsed.topCorrections : [])
          .slice(0, 3)
          .map((c: any) => ({
            quote: String(c?.quote || ''),
            suggestion: String(c?.suggestion || ''),
            explanation: String(c?.explanation || ''),
          })),
      })
    } finally {
      try { await fs.remove(rawPath) } catch { /* drop */ }
      try { await fs.remove(wavPath) } catch { /* drop */ }
    }
  } catch (err: any) {
    logger.error('[english] summary-grade failed:', err)
    res.status(500).json({ error: err.message || 'summary grade failed' })
  }
})
