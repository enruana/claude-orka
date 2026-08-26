import { logger } from './logger'
import { synthesizeMultilingual, SPANISH_VOICES } from './kokoro-multilingual'

/**
 * Kokoro-82M TTS singleton for the voice pipeline.
 *
 * Loads the model once at first use (~9s cold start, then cached across
 * the process lifetime) so subsequent synthesis calls only pay
 * inference cost. Kokoro's own onnxruntime-node backend does the CPU
 * inference — no external process, no GPU required. RTF ~0.5-0.7 on a
 * modest server CPU, faster on M-series / GPU-enabled hardware.
 *
 * Model download is ~86 MB (q8 quantized) into the HuggingFace hub
 * cache dir (~/.cache/huggingface) on first call. Subsequent process
 * starts reuse the on-disk cache.
 */

// Kokoro's package is ESM-only and pulls in onnxruntime-node which is
// heavy; keep the import lazy behind getKokoro() so the server boots
// without paying the load cost until someone actually opens a voice
// session.
type KokoroTTSInstance = {
  voices: Record<string, unknown>
  generate: (text: string, opts?: { voice?: string }) => Promise<{
    audio: Float32Array
    sampling_rate: number
  }>
}

const MODEL_ID = 'onnx-community/Kokoro-82M-ONNX'
const DTYPE: 'q8' | 'q4' | 'fp16' | 'fp32' = 'q8'

let instance: KokoroTTSInstance | null = null
let loadingPromise: Promise<KokoroTTSInstance> | null = null

/** Load-or-return the shared Kokoro instance. Concurrent callers await
 *  the same loading promise instead of racing multiple downloads. */
export async function getKokoro(): Promise<KokoroTTSInstance> {
  if (instance) return instance
  if (loadingPromise) return loadingPromise
  loadingPromise = (async () => {
    const t0 = Date.now()
    logger.info(`[kokoro] loading ${MODEL_ID} (dtype=${DTYPE})…`)
    const { KokoroTTS } = await import('kokoro-js')
    instance = (await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: DTYPE,
      device: 'cpu',
    })) as unknown as KokoroTTSInstance
    logger.info(`[kokoro] loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${Object.keys(instance.voices || {}).length} voices`)
    return instance
  })()
  try {
    return await loadingPromise
  } finally {
    // Keep instance memoized regardless; drop the promise only on failure
    if (!instance) loadingPromise = null
  }
}

/** List available voice ids (English + a few multilingual). */
export async function listKokoroVoices(): Promise<string[]> {
  const k = await getKokoro()
  return Object.keys(k.voices || {})
}

/**
 * Synthesize `text` to a 16-bit PCM WAV (bytes ready to send over WS).
 * Kokoro outputs Float32 samples at 24 kHz; we convert to int16 and
 * downsample to 16 kHz — matches the audio format the browser widget's
 * playback path expects (aligning with the STT sample rate keeps the
 * end-to-end pipeline single-rate).
 */
export interface SynthOptions {
  voice?: string
  /** Output sample rate. Default 24000 (Kokoro native, no resampling). */
  outSampleRate?: 24000 | 16000
  /** BCP-47-ish language tag. 'en' (default) goes through kokoro-js;
   *  anything else routes to the multilingual path. */
  language?: string
}

/**
 * Voices offered per language, best-first.
 *
 * English comes from kokoro-js's built-in table (Kokoro-82M-ONNX).
 * Spanish comes from the v1.0 checkpoint via kokoro-multilingual —
 * kokoro-js has no Spanish voices at all, see that module's header.
 */
export const VOICES_BY_LANGUAGE: Record<string, readonly string[]> = {
  en: ['af_heart', 'af_bella', 'am_michael', 'bf_emma'],
  es: SPANISH_VOICES,
}

/** The voice used when a session switches to `language` without
 *  naming one explicitly. */
export function defaultVoiceForLanguage(language: string): string {
  return VOICES_BY_LANGUAGE[language]?.[0] || VOICES_BY_LANGUAGE.en[0]
}

/** Languages the TTS side can actually speak. */
export function isSupportedTtsLanguage(language: string): boolean {
  return Object.prototype.hasOwnProperty.call(VOICES_BY_LANGUAGE, language)
}

export async function synthesizePcm16(
  text: string,
  opts: SynthOptions = {}
): Promise<{ pcm: Buffer; sampleRate: number; audioMs: number; synthMs: number }> {
  const trimmed = text.trim()
  if (!trimmed) return { pcm: Buffer.alloc(0), sampleRate: opts.outSampleRate || 24000, audioMs: 0, synthMs: 0 }

  const language = opts.language || 'en'
  const t0 = Date.now()

  let audio: Float32Array
  let sourceRate: number
  if (language === 'en') {
    const k = await getKokoro()
    const voice = opts.voice || Object.keys(k.voices || {})[0]
    const out = await k.generate(trimmed, { voice })
    audio = out.audio
    sourceRate = out.sampling_rate // 24000 for Kokoro
  } else {
    const voice = opts.voice || defaultVoiceForLanguage(language)
    const out = await synthesizeMultilingual(trimmed, language, voice)
    audio = out.audio
    sourceRate = out.sampleRate
  }
  const synthMs = Date.now() - t0

  const targetRate = opts.outSampleRate || sourceRate
  const samples = targetRate === sourceRate
    ? audio
    : resampleLinear(audio, sourceRate, targetRate)

  const pcm = float32ToInt16LE(samples)
  const audioMs = Math.floor((samples.length / targetRate) * 1000)
  return { pcm, sampleRate: targetRate, audioMs, synthMs }
}

/** Fast linear-interpolation resampler. Not audiophile-grade, but
 *  perfectly fine for speech and avoids adding a native dep. */
function resampleLinear(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return input
  const ratio = srcRate / dstRate
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio
    const idx0 = Math.floor(srcIdx)
    const idx1 = Math.min(idx0 + 1, input.length - 1)
    const frac = srcIdx - idx0
    out[i] = input[idx0] * (1 - frac) + input[idx1] * frac
  }
  return out
}

/** Convert Float32 [-1, 1] samples to signed 16-bit little-endian PCM. */
function float32ToInt16LE(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    // Symmetric mapping — avoids the traditional +32767/-32768 asymmetry
    // that shows up as a DC offset on some hardware.
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7FFF, i * 2)
  }
  return buf
}
