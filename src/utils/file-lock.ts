import fs from 'fs-extra'
import { logger } from './logger'

/**
 * Cross-process advisory lock built on an exclusive-create lockfile.
 *
 * ## Why this exists
 *
 * Every mutation of `state.json` is a read-modify-write: read the whole
 * document, change one array, write the whole document back. The write
 * itself is atomic (temp file + rename), so nobody ever sees torn
 * bytes — but two writers that both READ before either WROTE will each
 * save a document built from the stale copy, and the second rename
 * silently discards the first one's change.
 *
 * That was survivable while only the server mutated state. With
 * `orka comment` a terminal agent and an open browser tab write to the
 * same file from different PROCESSES, so an in-process mutex can't help.
 * Measured before this lock: 20 concurrent comment adds, 1 survivor.
 *
 * `fs.open(path, 'wx')` is the primitive — O_CREAT|O_EXCL is atomic on
 * every POSIX filesystem and on Windows, so exactly one contender
 * creates the file and the rest get EEXIST.
 *
 * ## Staleness
 *
 * A process killed mid-write leaves the lockfile behind and would block
 * the project forever. Locks older than `staleMs` are therefore stolen.
 * The window is set well above any legitimate hold time (a read + a
 * write of a file measured in kilobytes) so a live holder is never
 * robbed under normal load.
 */

export interface FileLockOptions {
  /** Give up and throw after this long waiting to acquire. */
  timeoutMs?: number
  /** Treat a lock older than this as abandoned and steal it. */
  staleMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_STALE_MS = 30_000
/** Poll interval while waiting. Short enough that an uncontended-ish
 *  handoff feels instant, long enough not to spin the CPU. */
const RETRY_MS = 25

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Run `fn` while holding an exclusive lock on `lockPath`.
 *
 * The lock is released even if `fn` throws — the caller's error
 * propagates unchanged, but a failed mutation must never wedge the
 * project.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const deadline = Date.now() + timeoutMs

  let fd: number | undefined
  for (;;) {
    try {
      fd = await fs.open(lockPath, 'wx')
      break
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err

      // Someone holds it. Steal only if it looks abandoned.
      try {
        const st = await fs.stat(lockPath)
        const age = Date.now() - st.mtimeMs
        if (age > staleMs) {
          logger.warn(`[file-lock] stealing stale lock ${lockPath} (${Math.round(age / 1000)}s old)`)
          await fs.remove(lockPath).catch(() => {})
          continue
        }
      } catch {
        // Vanished between EEXIST and stat — the holder just released.
        continue
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for lock ${lockPath}. ` +
          `Another Orka process may be busy; retry, or delete the file if nothing is running.`
        )
      }
      await sleep(RETRY_MS)
    }
  }

  try {
    // Contents are purely diagnostic — the lock's existence is what
    // matters — but a wedged lock is much easier to explain with the
    // owning pid in it.
    await fs.write(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    return await fn()
  } finally {
    await fs.close(fd).catch(() => {})
    await fs.remove(lockPath).catch(() => {})
  }
}
