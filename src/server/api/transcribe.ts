import { Router, Request, Response } from 'express'
import execa from 'execa'
import path from 'path'
import fs from 'fs-extra'
import os from 'os'
import { logger } from '../../utils'
import { getPackageNodeModulesPath } from '../../utils/paths'

export const transcribeRouter = Router()

// Model to use - base is a good balance of speed and quality
// Using multilingual model for multi-language support
const WHISPER_MODEL = 'base'

// Path to whisper.cpp installation (inside nodejs-whisper)
const getWhisperPath = () => {
  const whisperModulePath = getPackageNodeModulesPath('nodejs-whisper')
  if (!whisperModulePath) {
    // Fallback to cwd for backwards compatibility
    return path.join(process.cwd(), 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp')
  }
  return path.join(whisperModulePath, 'cpp', 'whisper.cpp')
}

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

  // Increase timeout for large uploads
  req.setTimeout(300000)

  try {
    // Read raw body as audio
    const chunks: Buffer[] = []

    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => resolve())
      req.on('error', reject)
    })

    if (chunks.length === 0) {
      res.status(400).json({ error: 'No audio data provided' })
      return
    }

    const audioBuffer = Buffer.concat(chunks)

    // Save to temp file
    const tempDir = getTempDir()
    await fs.ensureDir(tempDir)

    // Determine file extension from content-type
    const contentType = req.headers['content-type'] || 'audio/webm'
    const ext = contentType.includes('mp4') ? 'mp4'
      : contentType.includes('wav') ? 'wav'
      : contentType.includes('ogg') ? 'ogg'
      : 'webm'

    const timestamp = Date.now()
    tempFilePath = path.join(tempDir, `audio-${timestamp}.${ext}`)
    wavFilePath = path.join(tempDir, `audio-${timestamp}.wav`)

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
    const modelPath = path.join(whisperPath, 'models', `ggml-${WHISPER_MODEL}.bin`)

    // Check if whisper binary exists
    if (!await fs.pathExists(whisperBin)) {
      throw new Error(`Whisper binary not found at ${whisperBin}`)
    }

    // Check if model exists
    if (!await fs.pathExists(modelPath)) {
      throw new Error(`Whisper model not found at ${modelPath}. Run the model download script first.`)
    }

    // Transcribe with Whisper CLI directly
    logger.info(`Starting transcription with model: ${WHISPER_MODEL}, language: ${lang}`)

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
    job.model = WHISPER_MODEL
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
    const modelPath = path.join(whisperPath, 'models', `ggml-${WHISPER_MODEL}.bin`)

    const binaryExists = await fs.pathExists(whisperBin)
    const modelExists = await fs.pathExists(modelPath)

    if (binaryExists && modelExists) {
      const stats = await fs.stat(modelPath)
      const sizeMB = Math.round(stats.size / 1024 / 1024)

      res.json({
        available: true,
        model: WHISPER_MODEL,
        modelSize: `${sizeMB}MB`,
        message: 'Whisper ready'
      })
    } else {
      res.json({
        available: false,
        binaryExists,
        modelExists,
        message: !binaryExists
          ? 'Whisper binary not found. Run: cd node_modules/nodejs-whisper/cpp/whisper.cpp && make'
          : 'Whisper model not found. Run: cd node_modules/nodejs-whisper/cpp/whisper.cpp && bash ./models/download-ggml-model.sh tiny'
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
