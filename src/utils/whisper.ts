import path from 'path'
import fs from 'fs-extra'
import { spawn, ChildProcess } from 'child_process'
import net from 'net'
import { getPackageNodeModulesPath } from './paths'
import { logger } from './logger'

/**
 * Shared whisper model resolution.
 *
 * We prefer `small` (244MB, ~4-6x real-time on CPU) because base was
 * dropping accents and rephrasing during live meeting captures. base
 * remains the fallback so users who already ran `orka prepare` before
 * the upgrade keep working. tiny is a last-resort fallback for tightly
 * constrained boxes.
 */
export const WHISPER_MODEL_PREFERENCE: readonly string[] = ['small', 'base', 'tiny']
export const WHISPER_PREFERRED_MODEL = WHISPER_MODEL_PREFERENCE[0]

/** Absolute path to the whisper.cpp folder shipped inside nodejs-whisper. */
export function getWhisperCppPath(): string {
  const modPath = getPackageNodeModulesPath('nodejs-whisper')
  if (!modPath) {
    return path.join(process.cwd(), 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp')
  }
  return path.join(modPath, 'cpp', 'whisper.cpp')
}

/** Full path to a specific model's .bin file (may not exist). */
export function getWhisperModelPath(name: string): string {
  return path.join(getWhisperCppPath(), 'models', `ggml-${name}.bin`)
}

/**
 * Return the first whisper model actually downloaded on disk, following
 * WHISPER_MODEL_PREFERENCE. Returns null if none are available.
 */
export async function resolveAvailableWhisperModel(): Promise<{ name: string; path: string } | null> {
  for (const name of WHISPER_MODEL_PREFERENCE) {
    const p = getWhisperModelPath(name)
    if (await fs.pathExists(p)) return { name, path: p }
  }
  return null
}

// ---------------------------------------------------------------------------
// Persistent whisper-server
//
// whisper.cpp ships an HTTP server binary that loads the model ONCE and
// serves inference requests via POST /inference. That's a huge win over
// spawning whisper-cli per chunk — every chunk was paying ~200-500ms to
// load `small` off disk, on top of ~300-800ms of inference. With the
// persistent server, only the first request pays load time; subsequent
// requests are inference-only. On this box that takes the total chunk
// latency from ~700-1300ms down to ~300-500ms.
//
// Design:
//   - Single global instance keyed by model file path (all live sessions
//     share it — that's fine, whisper-server is thread-safe internally).
//   - Lazy: only spawned when the first live session asks for it.
//   - Picks a free localhost port at spawn time.
//   - `ready` promise resolves when the model finishes loading.
//   - `--suppress-nst` on so `[Música]` / `[Music]` tokens are dropped
//     natively before they ever hit our pipe — cheaper than the regex
//     filter we ship as fallback.
// ---------------------------------------------------------------------------

interface WhisperServerHandle {
  readonly url: string          // http://127.0.0.1:PORT
  readonly modelName: string
  readonly modelPath: string
  readonly ready: Promise<void>
  transcribe(wav: Buffer, opts?: TranscribeOptions): Promise<string>
  stop(): void
}

interface TranscribeOptions {
  language?: string
  prompt?: string
}

interface ServerState {
  modelPath: string
  proc: ChildProcess
  port: number
  ready: Promise<void>
  readyResolved: boolean
  stopped: boolean
}

let currentServer: ServerState | null = null

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address && typeof address === 'object') {
        const port = address.port
        srv.close(() => resolve(port))
      } else {
        srv.close()
        reject(new Error('failed to obtain a free port'))
      }
    })
  })
}

/**
 * Spawn whisper-server for the given model. Returns a promise that
 * resolves once the server has loaded the model and is accepting
 * requests. The child process is killed if the Node process exits.
 */
async function startWhisperServer(modelPath: string, modelName: string): Promise<ServerState> {
  const whisperPath = getWhisperCppPath()
  const bin = path.join(whisperPath, 'build', 'bin', 'whisper-server')

  if (!await fs.pathExists(bin)) {
    throw new Error(
      `whisper-server binary not found at ${bin}. Rebuild whisper.cpp with the server target enabled.`
    )
  }

  const port = await findFreePort()
  // Deliberately DO NOT pass `--no-fallback`. Whisper's temperature
  // fallback ladder (0.0 → 0.2 → 0.4 → …) is what lets it recover on
  // hard-to-transcribe segments — silences, mumbles, accents, chunk
  // boundaries. Without it, tricky sub-second slices come back empty
  // or with 1-2 word fragments and we lose big chunks of the audio.
  // The batch endpoint (whisper-cli defaults) has this on and produces
  // materially better transcripts.
  const args = [
    '-m', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-t', '4',                    // threads
    '-sns',                       // suppress non-speech tokens
  ]

  logger.info(`[whisper-server] starting on port ${port} with model ${modelName}`)
  const proc = spawn(bin, args, {
    cwd: whisperPath,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const state: ServerState = {
    modelPath,
    proc,
    port,
    ready: Promise.resolve(),
    readyResolved: false,
    stopped: false,
  }

  // Resolved once the HTTP endpoint responds. whisper-server does NOT
  // print a "listening" line — the last thing it prints is the compute
  // buffer sizes — so matching stderr text is unreliable across
  // versions. Instead we poll `GET /` every 200ms and consider the
  // server ready as soon as we get any HTTP response. We STILL listen
  // to the child's stderr for the "failed to load model" cases so we
  // can fail fast without waiting the full timeout.
  state.ready = new Promise<void>((resolve, reject) => {
    let settled = false
    const settleReject = (err: Error) => {
      if (settled) return
      settled = true
      state.readyResolved = true
      reject(err)
    }
    const settleResolve = () => {
      if (settled) return
      settled = true
      state.readyResolved = true
      logger.info(`[whisper-server] ready on port ${state.port}`)
      resolve()
    }

    const totalTimeout = setTimeout(() => {
      settleReject(new Error('whisper-server did not become ready within 60s'))
    }, 60000)

    // Fail-fast stderr watcher — model-load errors are the common
    // "spawn succeeds but is unusable" mode.
    const onData = (buf: Buffer) => {
      const text = buf.toString('utf8')
      if (!settled && /failed to (?:load|open) model/i.test(text)) {
        clearTimeout(totalTimeout)
        settleReject(new Error('whisper-server failed to load model: ' + text.slice(0, 200)))
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)

    proc.once('exit', (code, signal) => {
      state.stopped = true
      logger.warn(`[whisper-server] exited code=${code} signal=${signal}`)
      clearTimeout(totalTimeout)
      settleReject(new Error(`whisper-server exited before ready (code=${code}, signal=${signal})`))
    })

    proc.once('error', (err) => {
      logger.error(`[whisper-server] spawn error`, err)
      clearTimeout(totalTimeout)
      settleReject(err)
    })

    // Poll GET / until we get any HTTP response. This is the reliable
    // readiness signal — the server binds the socket after the model
    // has been loaded into memory.
    const poll = async () => {
      while (!settled) {
        try {
          const ctrl = new AbortController()
          const to = setTimeout(() => ctrl.abort(), 800)
          const r = await fetch(`http://127.0.0.1:${state.port}/`, { signal: ctrl.signal })
          clearTimeout(to)
          if (r.status >= 200 && r.status < 600) {
            clearTimeout(totalTimeout)
            settleResolve()
            return
          }
        } catch {
          // not yet listening or timing out — keep polling
        }
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    poll()
  })

  return state
}

/**
 * Return the shared whisper-server handle, spawning it on first call.
 * Callers should await `handle.ready` before calling `transcribe`.
 * If the model on disk changed since the last call (e.g. user just
 * downloaded `small` after running with `base`), the running server is
 * killed and a new one starts with the new model.
 */
export async function getWhisperServer(): Promise<WhisperServerHandle> {
  const resolved = await resolveAvailableWhisperModel()
  if (!resolved) {
    throw new Error(
      `No whisper model available (checked: ${WHISPER_MODEL_PREFERENCE.join(', ')}). ` +
      `Run 'orka prepare' to download '${WHISPER_PREFERRED_MODEL}'.`
    )
  }

  // Restart if the preferred model on disk changed.
  if (currentServer && (currentServer.stopped || currentServer.modelPath !== resolved.path)) {
    try { currentServer.proc.kill('SIGTERM') } catch {}
    currentServer = null
  }

  if (!currentServer) {
    try {
      currentServer = await startWhisperServer(resolved.path, resolved.name)
    } catch (err) {
      // Bubble up — caller decides whether to fall back to whisper-cli.
      throw err
    }
  }

  const state = currentServer
  const url = `http://127.0.0.1:${state.port}`

  return {
    url,
    modelName: resolved.name,
    modelPath: resolved.path,
    ready: state.ready,
    async transcribe(wav: Buffer, opts?: TranscribeOptions): Promise<string> {
      await state.ready
      // whisper-server accepts multipart/form-data with:
      //   file:              the audio buffer (WAV)
      //   language:          e.g. 'es' / 'en' / 'auto'
      //   prompt:            initial-prompt conditioning text
      //   response_format:   'json' | 'text' | ...
      //   no_timestamps:     'true'
      //   temperature:       '0.0'
      //   suppress_nst:      redundant with -sns launch flag, but cheap
      const form = new FormData()
      // Node 20+ has a global Blob; feed it a Uint8Array view over the
      // same memory. Copying via `new Uint8Array(wav)` avoids the
      // ArrayBuffer / SharedArrayBuffer TS union that .buffer returns.
      const view = new Uint8Array(wav.byteLength)
      view.set(wav)
      form.append('file', new Blob([view], { type: 'audio/wav' }), 'chunk.wav')
      form.append('language', opts?.language || 'auto')
      form.append('response_format', 'json')
      form.append('no_timestamps', 'true')
      // Let temperature use whisper.cpp defaults (0.0 with 0.2 fallback
      // increment). Pinning temperature=0.0 without an increment
      // silently disables the fallback — the same bug as passing
      // --no-fallback at launch. That's why live output was terse.
      form.append('suppress_nst', 'true')
      const trimmedPrompt = (opts?.prompt || '').trim()
      if (trimmedPrompt) form.append('prompt', trimmedPrompt)

      const resp = await fetch(url + '/inference', {
        method: 'POST',
        body: form as any,
      })
      if (!resp.ok) {
        const detail = await resp.text().catch(() => resp.statusText)
        throw new Error(`whisper-server ${resp.status}: ${detail.slice(0, 200)}`)
      }
      // whisper-server response_format=json returns `{ "text": "..." }`,
      // but some versions ship without a text field on very short /
      // silent buffers — fall back to raw text if json parse fails.
      const raw = await resp.text()
      try {
        const parsed = JSON.parse(raw) as { text?: string }
        return (parsed.text || '').trim()
      } catch {
        return raw.trim()
      }
    },
    stop() {
      if (state === currentServer) currentServer = null
      try { state.proc.kill('SIGTERM') } catch {}
    },
  }
}

// Kill the whisper-server child on Node process exit so we don't
// leave orphans behind on `orka stop` / Ctrl-C.
const _teardown = () => {
  if (currentServer) {
    try { currentServer.proc.kill('SIGTERM') } catch {}
    currentServer = null
  }
}
process.once('exit', _teardown)
process.once('SIGINT', () => { _teardown(); process.exit(130) })
process.once('SIGTERM', () => { _teardown(); process.exit(143) })
