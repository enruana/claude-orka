import { Router, Request, Response } from 'express'
import { nodewhisper } from 'nodejs-whisper'
import path from 'path'
import fs from 'fs-extra'
import os from 'os'
import { logger } from '../../utils'

export const transcribeRouter = Router()

// Model to use - tiny is fastest, base is better quality
const WHISPER_MODEL = 'tiny.en'

// Temp directory for audio files
const getTempDir = () => path.join(os.tmpdir(), 'orka-whisper')

// Type for whisper result
interface WhisperSegment {
  speech?: string
  text?: string
}

/**
 * POST /api/transcribe
 * Transcribe audio to text using Whisper
 *
 * Body: raw audio data with Content-Type header
 * Returns: { text: string, duration?: number }
 */
transcribeRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now()
  let tempFilePath: string | null = null

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

    tempFilePath = path.join(tempDir, `audio-${Date.now()}.${ext}`)
    await fs.writeFile(tempFilePath, audioBuffer)

    logger.info(`Saved audio file: ${tempFilePath} (${audioBuffer.length} bytes)`)

    // Transcribe with Whisper
    logger.info(`Starting transcription with model: ${WHISPER_MODEL}`)

    const result = await nodewhisper(tempFilePath, {
      modelName: WHISPER_MODEL,
      autoDownloadModelName: WHISPER_MODEL,
      removeWavFileAfterTranscription: true,
      withCuda: false,
      whisperOptions: {
        outputInText: true,
        outputInVtt: false,
        outputInSrt: false,
        outputInCsv: false,
        translateToEnglish: false,
        wordTimestamps: false,
        splitOnWord: true,
      }
    })

    // Extract text from result
    let text = ''
    if (typeof result === 'string') {
      text = result.trim()
    } else if (Array.isArray(result)) {
      text = (result as WhisperSegment[]).map((r: WhisperSegment) => r.speech || r.text || '').join(' ').trim()
    } else if (result && typeof result === 'object') {
      const obj = result as Record<string, unknown>
      text = String(obj.text || obj.speech || '')
    }

    const duration = Date.now() - startTime
    logger.info(`Transcription completed in ${duration}ms: "${text.substring(0, 50)}..."`)

    // Clean up temp file
    if (tempFilePath) {
      await fs.remove(tempFilePath).catch(() => {})
    }

    res.json({
      text: text.trim(),
      duration,
      model: WHISPER_MODEL
    })

  } catch (error: unknown) {
    const err = error as Error
    logger.error('Transcription error:', err)

    // Clean up temp file on error
    if (tempFilePath) {
      await fs.remove(tempFilePath).catch(() => {})
    }

    res.status(500).json({
      error: 'Transcription failed',
      message: err.message
    })
  }
})

/**
 * GET /api/transcribe/status
 * Check if Whisper is available and ready
 */
transcribeRouter.get('/status', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Check if whisper model exists or can be downloaded
    const modelsDir = path.join(os.homedir(), '.cache', 'whisper')
    const modelExists = await fs.pathExists(path.join(modelsDir, `ggml-${WHISPER_MODEL}.bin`))

    res.json({
      available: true,
      model: WHISPER_MODEL,
      modelDownloaded: modelExists,
      message: modelExists
        ? 'Whisper ready'
        : 'Whisper model will be downloaded on first use'
    })
  } catch (error: unknown) {
    const err = error as Error
    res.json({
      available: false,
      error: err.message
    })
  }
})
