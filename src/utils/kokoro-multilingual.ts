import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import { logger } from './logger'

const execFileAsync = promisify(execFile)

/**
 * Spanish (and future non-English) synthesis for the voice agent.
 *
 * Why this exists instead of just passing a voice id to kokoro-js:
 * kokoro-js 1.2.1 — the latest release — hardcodes a table of 28
 * voices, all of them `en-us` or `en-gb`, and rejects anything else in
 * `_validate_voice`. Its phonemizer call is hardcoded too: the voice's
 * first letter picks between "en-us" and "en", nothing more. And the
 * bundled `phonemizer` package ships an English-only espeak-ng wasm
 * (asking it for "es" lists en-* as the only options). So there is no
 * seam in that library for another language.
 *
 * What DOES work, verified end to end: the upstream Kokoro v1.0 ONNX
 * weights ship Spanish voice vectors (ef_dora, em_alex, em_santa), and
 * a system espeak-ng produces the IPA the model was trained on. This
 * module wires those two together directly against
 * @huggingface/transformers — the same forward pass kokoro-js runs,
 * minus its English-only scaffolding.
 *
 * English keeps going through kokoro-js untouched. That path works and
 * the user is happy with it; there is no reason to move it onto a
 * different checkpoint.
 */

// v1.0 is the checkpoint that has the multilingual voice vectors. The
// English path deliberately stays on the older Kokoro-82M-ONNX.
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

/** espeak-ng voice per supported language. `es-419` is Latin American
 *  Spanish — seseo, no /θ/ — which is what the user speaks. */
const ESPEAK_VOICE: Record<string, string> = {
  es: 'es-419',
}

export const SPANISH_VOICES = ['ef_dora', 'em_alex', 'em_santa'] as const

/** Voice vectors are ~500 KB each; keep them next to the rest of the
 *  Orka state instead of re-downloading per process. */
const VOICE_CACHE_DIR = path.join(os.homedir(), '.orka', 'kokoro-voices')

type Loaded = {
  model: (inputs: Record<string, unknown>) => Promise<{ waveform: { data: Float32Array } }>
  tokenizer: (text: string, opts: { truncation: boolean }) => { input_ids: { dims: number[] } }
  Tensor: new (type: string, data: ArrayLike<number>, dims: number[]) => unknown
}

let loaded: Loaded | null = null
let loadingPromise: Promise<Loaded> | null = null

async function getMultilingual(): Promise<Loaded> {
  if (loaded) return loaded
  if (loadingPromise) return loadingPromise
  loadingPromise = (async () => {
    const t0 = Date.now()
    logger.info(`[kokoro-ml] loading ${MODEL_ID} (dtype=q8)…`)
    const { StyleTextToSpeech2Model, AutoTokenizer, Tensor } = await import('@huggingface/transformers')
    const [model, tokenizer] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' }),
      AutoTokenizer.from_pretrained(MODEL_ID),
    ])
    logger.info(`[kokoro-ml] loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    loaded = { model, tokenizer, Tensor } as unknown as Loaded
    return loaded
  })()
  try {
    return await loadingPromise
  } finally {
    if (!loaded) loadingPromise = null
  }
}

let espeakChecked = false
let espeakAvailable = false

/** Is a system espeak-ng present? Cached — the answer can't change
 *  within a process lifetime in any way that matters. */
export async function hasEspeakNg(): Promise<boolean> {
  if (espeakChecked) return espeakAvailable
  espeakChecked = true
  try {
    await execFileAsync('espeak-ng', ['--version'])
    espeakAvailable = true
  } catch {
    espeakAvailable = false
  }
  return espeakAvailable
}

export class EspeakMissingError extends Error {
  constructor() {
    super(
      'espeak-ng is required for Spanish speech but was not found. ' +
      'Install it with `brew install espeak-ng` (macOS) or ' +
      '`sudo apt install espeak-ng` (Linux), then restart the server.'
    )
    this.name = 'EspeakMissingError'
  }
}

/**
 * Text → IPA via espeak-ng.
 *
 * `--ipa=3` gives the phoneme-separated IPA Kokoro was trained on and
 * `-q` suppresses audio output. espeak emits one line per clause; we
 * join them with spaces because the model wants a single sequence.
 */
async function phonemize(text: string, language: string): Promise<string> {
  const voice = ESPEAK_VOICE[language]
  if (!voice) throw new Error(`no espeak voice configured for language "${language}"`)
  if (!(await hasEspeakNg())) throw new EspeakMissingError()
  const { stdout } = await execFileAsync('espeak-ng', ['-v', voice, '--ipa=3', '-q', text])
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const voiceCache = new Map<string, Float32Array>()

/** Fetch (once) and memoize a voice's style vectors. */
async function loadVoice(voiceId: string): Promise<Float32Array> {
  const cached = voiceCache.get(voiceId)
  if (cached) return cached

  const diskPath = path.join(VOICE_CACHE_DIR, `${voiceId}.bin`)
  if (await fs.pathExists(diskPath)) {
    const buf = await fs.readFile(diskPath)
    const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    voiceCache.set(voiceId, vec)
    return vec
  }

  const url = `https://huggingface.co/${MODEL_ID}/resolve/main/voices/${voiceId}.bin`
  logger.info(`[kokoro-ml] downloading voice ${voiceId}…`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`voice "${voiceId}" download failed: HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  await fs.ensureDir(VOICE_CACHE_DIR)
  await fs.writeFile(diskPath, bytes)
  const vec = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  voiceCache.set(voiceId, vec)
  return vec
}

/**
 * Synthesize non-English speech. Returns Float32 samples at Kokoro's
 * native 24 kHz; the caller handles resampling and PCM conversion so
 * this stays symmetrical with the kokoro-js path.
 */
export async function synthesizeMultilingual(
  text: string,
  language: string,
  voiceId: string
): Promise<{ audio: Float32Array; sampleRate: number }> {
  const phonemes = await phonemize(text, language)
  if (!phonemes) return { audio: new Float32Array(0), sampleRate: 24000 }

  const { model, tokenizer, Tensor } = await getMultilingual()
  const { input_ids } = tokenizer(phonemes, { truncation: true })

  // Style vectors are indexed by token count: the model ships one
  // 256-float style per possible sequence length, capped at 509 (the
  // same slice arithmetic kokoro-js uses internally).
  const tokenCount = input_ids.dims[input_ids.dims.length - 1]
  const offset = 256 * Math.min(Math.max(tokenCount - 2, 0), 509)
  const voice = await loadVoice(voiceId)
  const style = voice.slice(offset, offset + 256)

  const { waveform } = await model({
    input_ids,
    style: new Tensor('float32', style, [1, 256]),
    speed: new Tensor('float32', [1], [1]),
  })
  return { audio: waveform.data, sampleRate: 24000 }
}
