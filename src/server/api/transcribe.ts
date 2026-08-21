import { Router, Request, Response } from 'express'
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
import { transcribeUtterancePcm16 } from './transcribe-live'

export const transcribeRouter = Router()

// Kept as an alias so existing telemetry doesn't break. Actual model
// selection happens per-request via resolveAvailableWhisperModel() so a
// user can drop a new model file in without restarting the server.
const getWhisperPath = getWhisperCppPath

// Temp directory for audio files
const getTempDir = () => path.join(os.tmpdir(), 'orka-whisper')

/**
 * Convert audio to WAV format using ffmpeg
 */
async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  await execa('ffmpeg', [
    '-i', inputPath,
    '-ar', '16000',      // 16kHz sample rate (required by whisper)
    '-ac', '1',          // mono
    '-c:a', 'pcm_s16le', // 16-bit PCM
    '-y',                // overwrite output
    outputPath
  ])
}

// In-memory job store for transcription results
interface TranscribeJob {
  id: string
  status: 'processing' | 'completed' | 'error'
  text?: string
  duration?: number
  model?: string
  language?: string
  error?: string
  createdAt: number
}

const jobs = new Map<string, TranscribeJob>()

// Clean up old jobs after 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id)
  }
}, 60000)

/**
 * POST /api/transcribe
 * Upload audio and start transcription job.
 * Returns immediately with { jobId } - poll GET /api/transcribe/job/:id for result.
 */
transcribeRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  let tempFilePath: string | null = null
  let wavFilePath: string | null = null

  try {
    // Body is pre-buffered by express.raw() middleware
    logger.info(`Transcribe request: content-type=${req.headers['content-type']}, body type=${typeof req.body}, isBuffer=${Buffer.isBuffer(req.body)}, body length=${req.body?.length || 0}`)

    let audioBuffer: Buffer

    if (Buffer.isBuffer(req.body)) {
      audioBuffer = req.body
    } else if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      // express.json() may have parsed it - fall back to reading stream
      logger.warn('Body was not a Buffer, attempting stream read')
      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => resolve())
        req.on('error', reject)
        // If stream is already consumed, end fires immediately
        setTimeout(() => resolve(), 3000)
      })
      audioBuffer = Buffer.concat(chunks)
      logger.info(`Stream read got ${audioBuffer.length} bytes`)
    } else {
      audioBuffer = Buffer.from(req.body || '')
    }

    if (!audioBuffer || audioBuffer.length < 100) {
      logger.warn(`Audio body too small: ${audioBuffer?.length || 0} bytes`)
      res.status(400).json({ error: `No audio data provided (received ${audioBuffer?.length || 0} bytes)` })
      return
    }

    // Save to temp file
    const tempDir = getTempDir()
    await fs.ensureDir(tempDir)

    // Determine file extension from content-type
    const contentType = req.headers['content-type'] || 'audio/webm'
    const ct = contentType.toLowerCase()
    const ext = ct.includes('mp4') || ct.includes('m4a') ? 'mp4'
      : ct.includes('aac') ? 'aac'
      : ct.includes('wav') ? 'wav'
      : ct.includes('ogg') ? 'ogg'
      : 'webm'

    const timestamp = Date.now()
    tempFilePath = path.join(tempDir, `audio-${timestamp}.${ext}`)
    // Output path MUST differ from the input: when the upload is already
    // WAV (mobile sends 16kHz mono WAV) `ext` is 'wav', so a plain
    // `audio-TS.wav` output would equal the input and ffmpeg refuses to
    // edit a file in place ("FFmpeg cannot edit existing files in-place").
    wavFilePath = path.join(tempDir, `audio-${timestamp}-16k.wav`)

    await fs.writeFile(tempFilePath, audioBuffer)
    logger.info(`Saved audio file: ${tempFilePath} (${audioBuffer.length} bytes)`)

    // Get language preference from query param (es, en, or auto)
    const language = (req.query.language as string) || 'auto'
    const validLanguages = ['es', 'en', 'auto']
    const lang = validLanguages.includes(language) ? language : 'auto'

    // Create job and respond immediately
    const jobId = `job-${timestamp}-${Math.random().toString(36).slice(2, 8)}`
    const job: TranscribeJob = { id: jobId, status: 'processing', createdAt: Date.now() }
    jobs.set(jobId, job)

    // Respond immediately with jobId
    res.json({ jobId })

    // Process transcription in background
    processTranscription(jobId, tempFilePath, wavFilePath, lang).catch((err) => {
      logger.error('Background transcription error:', err)
    })

  } catch (error: unknown) {
    const err = error as Error
    logger.error('Transcription upload error:', err)

    // Clean up temp files on error
    if (tempFilePath) await fs.remove(tempFilePath).catch(() => {})
    if (wavFilePath) await fs.remove(wavFilePath).catch(() => {})

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Upload failed',
        message: err.message
      })
    }
  }
})

/**
 * Background transcription processing
 */
async function processTranscription(
  jobId: string,
  tempFilePath: string,
  wavFilePath: string,
  lang: string
): Promise<void> {
  const startTime = Date.now()
  const job = jobs.get(jobId)
  if (!job) return

  try {
    // Convert to WAV format
    logger.info('Converting to WAV format...')
    await convertToWav(tempFilePath, wavFilePath)

    // Get whisper paths
    const whisperPath = getWhisperPath()
    const whisperBin = path.join(whisperPath, 'build', 'bin', 'whisper-cli')

    if (!await fs.pathExists(whisperBin)) {
      throw new Error(`Whisper binary not found at ${whisperBin}`)
    }

    const resolved = await resolveAvailableWhisperModel()
    if (!resolved) {
      throw new Error(
        `No whisper model found (checked: ${WHISPER_MODEL_PREFERENCE.join(', ')}). ` +
        `Run 'orka prepare' to download the '${WHISPER_PREFERRED_MODEL}' model.`
      )
    }
    const modelPath = resolved.path
    const activeModel = resolved.name

    // Transcribe with Whisper CLI directly
    logger.info(`Starting transcription with model: ${activeModel}, language: ${lang}`)

    const { stdout, stderr } = await execa(whisperBin, [
      '-m', modelPath,
      '-f', wavFilePath,
      '-l', lang,          // Language: es, en, or auto
      '--no-timestamps',   // No timestamps for dictation mode
      '-otxt',             // Output as plain text
      '--no-prints',       // Suppress progress output
    ], {
      cwd: whisperPath,
      timeout: 600000, // 10 minute timeout for long recordings
    })

    // The text output goes to stdout when using -otxt
    // But whisper might also write to a .txt file
    let text = stdout.trim()

    // If stdout is empty, try reading the .txt file
    if (!text) {
      const txtFile = wavFilePath.replace('.wav', '.txt')
      if (await fs.pathExists(txtFile)) {
        text = (await fs.readFile(txtFile, 'utf-8')).trim()
        await fs.remove(txtFile).catch(() => {})
      }
    }

    // Clean up any remaining whisper output files
    const baseName = wavFilePath.replace('.wav', '')
    for (const ext of ['.txt', '.vtt', '.srt', '.csv']) {
      const outFile = baseName + ext
      if (await fs.pathExists(outFile)) {
        await fs.remove(outFile).catch(() => {})
      }
    }

    if (!text) {
      logger.warn('No transcription text returned. stderr:', stderr)
      throw new Error('No speech detected')
    }

    const duration = Date.now() - startTime
    logger.info(`Transcription completed in ${duration}ms: "${text.substring(0, 50)}..."`)

    // Update job with result
    job.status = 'completed'
    job.text = text.trim()
    job.duration = duration
    job.model = activeModel
    job.language = lang

  } catch (error: unknown) {
    const err = error as Error
    logger.error('Transcription processing error:', err)
    job.status = 'error'
    job.error = err.message
  } finally {
    // Clean up temp files
    if (tempFilePath) await fs.remove(tempFilePath).catch(() => {})
    if (wavFilePath) await fs.remove(wavFilePath).catch(() => {})
  }
}

/**
 * GET /api/transcribe/job/:id
 * Poll for transcription job result
 */
transcribeRouter.get('/job/:id', async (req: Request, res: Response): Promise<void> => {
  const job = jobs.get(req.params.id as string)

  if (!job) {
    res.status(404).json({ error: 'Job not found' })
    return
  }

  if (job.status === 'processing') {
    res.json({ status: 'processing' })
    return
  }

  if (job.status === 'error') {
    // Clean up job after returning error
    jobs.delete(job.id)
    res.json({ status: 'error', error: job.error })
    return
  }

  // Completed - return result and clean up
  jobs.delete(job.id)
  res.json({
    status: 'completed',
    text: job.text,
    duration: job.duration,
    model: job.model,
    language: job.language
  })
})

/**
 * GET /api/transcribe/status
 * Check if Whisper is available and ready
 */
transcribeRouter.get('/status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const whisperPath = getWhisperPath()
    const whisperBin = path.join(whisperPath, 'build', 'bin', 'whisper-cli')
    const binaryExists = await fs.pathExists(whisperBin)
    const resolved = await resolveAvailableWhisperModel()

    if (binaryExists && resolved) {
      const stats = await fs.stat(resolved.path)
      const sizeMB = Math.round(stats.size / 1024 / 1024)
      const preferred = resolved.name === WHISPER_PREFERRED_MODEL
      res.json({
        available: true,
        model: resolved.name,
        preferredModel: WHISPER_PREFERRED_MODEL,
        upgradeAvailable: !preferred,
        modelSize: `${sizeMB}MB`,
        message: preferred
          ? `Whisper ready (${resolved.name})`
          : `Whisper ready (${resolved.name}) — a better model (${WHISPER_PREFERRED_MODEL}) can be downloaded with 'orka prepare'`,
      })
    } else {
      res.json({
        available: false,
        binaryExists,
        modelExists: !!resolved,
        message: !binaryExists
          ? 'Whisper binary not found. Run: cd node_modules/nodejs-whisper/cpp/whisper.cpp && make'
          : `No whisper model found (checked: ${WHISPER_MODEL_PREFERENCE.join(', ')}). Run 'orka prepare' to download '${WHISPER_PREFERRED_MODEL}'.`,
      })
    }
  } catch (error: unknown) {
    const err = error as Error
    res.json({
      available: false,
      error: err.message
    })
  }
})

// ============================================================
// DIRECT (low-latency) transcription
// ============================================================
//
// The job-based POST / flow above spawns a fresh `whisper-cli` per
// request, which reloads the ~500MB model from disk every single time,
// and the client then polls on a 2s timer — so a 3-second dictation
// routinely takes 6-10s end to end.
//
// The voice agent doesn't pay that cost: it goes through
// `transcribeUtterancePcm16()`, which talks to the PERSISTENT
// whisper-server (model already resident) and only falls back to a
// CLI spawn if that server can't start. This route gives the same
// pipeline to every other caller (session Quick Actions, comment
// dialog, …): decode → PCM16 → shared transcriber → respond inline.
//
// Wire shape is deliberately dead simple — one request, one answer,
// no jobId, no polling:
//   POST /api/transcribe/direct?language=es   body: raw audio bytes
//   → 200 { text, durationMs, backend, language }

/**
 * If the upload is ALREADY a PCM16 mono @ 16 kHz WAV, return its sample
 * data directly instead of round-tripping through ffmpeg. The mobile
 * terminal's recorder resamples client-side and sends exactly this, so
 * the common Quick-Action path skips a process spawn and a disk write
 * entirely. Returns null when the buffer isn't a conforming WAV, in
 * which case the caller falls back to ffmpeg.
 */
function pcm16FromWavIfConforming(buf: Buffer): Buffer | null {
  // Minimum: 12-byte RIFF header + 24-byte fmt chunk + 8-byte data header
  if (buf.length < 44) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null

  // Walk the chunk list — `fmt ` and `data` are not guaranteed to sit at
  // fixed offsets (some encoders insert LIST/fact chunks first).
  let offset = 12
  let format = -1, channels = -1, sampleRate = -1, bitsPerSample = -1
  let dataStart = -1, dataLen = -1

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8

    if (id === 'fmt ' && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body)
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      bitsPerSample = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataStart = body
      // Some writers leave an over-long or zero size on streamed files;
      // clamp to what actually arrived.
      dataLen = Math.min(size, buf.length - body)
      break
    }
    // Chunks are word-aligned: odd sizes carry a pad byte.
    offset = body + size + (size % 2)
  }

  if (format !== 1 || channels !== 1 || sampleRate !== 16000 || bitsPerSample !== 16) return null
  if (dataStart < 0 || dataLen <= 0) return null
  return buf.subarray(dataStart, dataStart + dataLen)
}

/**
 * Decode an arbitrary browser-recorded audio blob (webm/opus, mp4/aac,
 * ogg, wav …) into raw PCM16 mono @ 16 kHz — the only format whisper
 * accepts. ffmpeg reads a temp file (MediaRecorder mp4 is not reliably
 * streamable over a pipe) and writes the samples to stdout, so we never
 * touch the disk for the decoded side.
 */
async function decodeToPcm16(audioBuffer: Buffer, contentType: string): Promise<Buffer> {
  const ct = (contentType || '').toLowerCase()
  const ext = ct.includes('mp4') || ct.includes('m4a') ? 'mp4'
    : ct.includes('aac') ? 'aac'
    : ct.includes('wav') ? 'wav'
    : ct.includes('ogg') ? 'ogg'
    : 'webm'

  const tempDir = getTempDir()
  await fs.ensureDir(tempDir)
  const inPath = path.join(tempDir, `direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)

  try {
    await fs.writeFile(inPath, audioBuffer)
    try {
      const { stdout } = await execa(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error',
          '-i', inPath,
          '-f', 's16le',     // raw PCM16 LE — what transcribeUtterancePcm16 wants
          '-ar', '16000',    // whisper's native rate
          '-ac', '1',        // mono
          'pipe:1',
        ],
        { encoding: null as any, maxBuffer: 200 * 1024 * 1024, timeout: 120000 }
      )
      return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as any)
    } catch (err: any) {
      // Don't leak the whole ffmpeg invocation + stderr dump into the
      // API response — the client renders `message` verbatim to the user.
      logger.warn(`[transcribe-direct] ffmpeg decode failed: ${err?.stderr || err?.message || err}`)
      throw new Error(
        err?.code === 'ENOENT'
          ? 'ffmpeg not found on this machine. Run "orka prepare" to install it.'
          : 'Could not decode the recorded audio.'
      )
    }
  } finally {
    await fs.remove(inPath).catch(() => {})
  }
}

/**
 * POST /api/transcribe/direct?language=es|en|auto
 *
 * Synchronous transcription over the shared whisper-server. Returns the
 * text in the same response — no job polling. Use this for short
 * dictation (Quick Actions, comments); the job flow is still there for
 * long uploads where a 10-minute request would time out.
 */
transcribeRouter.post('/direct', async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now()
  try {
    const audioBuffer: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '')
    if (!audioBuffer || audioBuffer.length < 100) {
      res.status(400).json({ error: `No audio data provided (received ${audioBuffer?.length || 0} bytes)` })
      return
    }

    const language = (req.query.language as string) || 'auto'
    const lang = ['es', 'en', 'auto'].includes(language) ? language : 'auto'

    const decodeStart = Date.now()
    const direct = pcm16FromWavIfConforming(audioBuffer)
    const pcm = direct ?? await decodeToPcm16(audioBuffer, req.headers['content-type'] || 'audio/webm')
    const decodeMs = Date.now() - decodeStart

    if (pcm.length < 3200) {
      // < 100 ms of audio — nothing worth sending to whisper.
      res.json({ text: '', durationMs: Date.now() - startTime, language: lang })
      return
    }

    const inferStart = Date.now()
    const text = (await transcribeUtterancePcm16(pcm, lang)).trim()
    const inferMs = Date.now() - inferStart

    const audioMs = Math.round((pcm.length / 2 / 16000) * 1000)
    logger.info(
      `[transcribe-direct] audio=${audioMs}ms decode=${decodeMs}ms(${direct ? 'passthrough' : 'ffmpeg'}) infer=${inferMs}ms ` +
      `total=${Date.now() - startTime}ms chars=${text.length}`
    )

    res.json({
      text,
      durationMs: Date.now() - startTime,
      decodeMs,
      inferMs,
      audioMs,
      language: lang,
    })
  } catch (error: unknown) {
    const err = error as Error
    logger.error('[transcribe-direct] failed:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Transcription failed', message: err.message })
    }
  }
})

/**
 * POST /api/transcribe/warmup
 *
 * Fire-and-forget: make sure the persistent whisper-server is up and
 * has the model resident. Clients call this the moment a user opens a
 * voice input (before they've even finished speaking), so the first
 * real transcription doesn't pay the ~2-5s model-load cost.
 */
transcribeRouter.post('/warmup', async (_req: Request, res: Response): Promise<void> => {
  try {
    const handle = await getWhisperServer()
    // Don't block the response on `ready` — the point is to kick the
    // spawn off early. Report whether it's already usable.
    const alreadyReady = await Promise.race([
      handle.ready.then(() => true).catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 250)),
    ])
    res.json({ ok: true, ready: alreadyReady, model: handle.modelName })
  } catch (error: unknown) {
    const err = error as Error
    // Warmup is best-effort — a failure here just means the next
    // transcription falls back to the CLI path.
    logger.debug(`[transcribe-warmup] ${err.message}`)
    res.json({ ok: false, ready: false, message: err.message })
  }
})
