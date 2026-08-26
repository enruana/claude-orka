import { Router } from 'express'
import fs from 'fs-extra'
import os from 'os'
import execa from 'execa'
import { logger, TmuxCommands } from '../../utils'
import { getGlobalStateManager } from '../../core/GlobalStateManager'
import { StateManager, getOrkaVersion } from '../../core/StateManager'
import { BoardManager } from '../../core/BoardManager'
import { getAgentManager } from '../../agent/AgentManager'
import {
  getWhisperServer,
  getWhisperServerStatus,
  stopWhisperServer,
} from '../../utils/whisper'

export const systemRouter = Router()

/**
 * Live host metrics for the launcher's system widget. Kept intentionally
 * lightweight (no third-party dependency): CPU usage is computed from
 * `os.cpus()` deltas between calls, memory from `os.totalmem/freemem`,
 * and disk from a single `df` shell-out. All numbers are point-in-time
 * plus a `sampledAt` timestamp; the client polls this endpoint and
 * animates transitions.
 */

// Previous CPU sample, kept module-scoped so consecutive polls compute
// a delta over the wall-clock gap between requests instead of over the
// process lifetime average (which drifts toward a meaningless constant).
interface CpuSample {
  idle: number
  total: number
  at: number
}
let lastCpuSample: CpuSample | null = null

function sampleCpu(): CpuSample {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const c of cpus) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total, at: Date.now() }
}

/** Percentage 0–100 of CPU used since the previous sample. On the first
 *  call (no prior sample) we take a 100ms snapshot inline so the first
 *  response still carries a real reading instead of `0`. */
async function readCpuUsagePercent(): Promise<number> {
  let prev = lastCpuSample
  if (!prev) {
    prev = sampleCpu()
    await new Promise((r) => setTimeout(r, 100))
  }
  const now = sampleCpu()
  lastCpuSample = now
  const totalDiff = now.total - prev.total
  const idleDiff = now.idle - prev.idle
  if (totalDiff <= 0) return 0
  const usage = 100 * (1 - idleDiff / totalDiff)
  return Math.max(0, Math.min(100, Number(usage.toFixed(1))))
}

interface DiskEntry {
  mount: string
  filesystem: string
  totalBytes: number
  usedBytes: number
  freeBytes: number
  usedPercent: number
}

/**
 * Parse `df -PBK` output into per-mount records. Uses POSIX mode (`-P`)
 * so each entry is guaranteed to fit one line even for long filesystem
 * names, and 1KB blocks so numbers stay small and multiplied cheaply.
 *
 * Filters:
 *  - only real filesystems (skip tmpfs, devtmpfs, squashfs, overlay
 *    from container runtimes)
 *  - only sensible mounts (skip /snap/*, /boot/efi which the user
 *    doesn't care about at a glance)
 */
async function readDisks(): Promise<DiskEntry[]> {
  try {
    const { stdout } = await execa('df', ['-PBK'], { timeout: 3000 })
    const lines = stdout.trim().split('\n').slice(1) // drop header
    const disks: DiskEntry[] = []
    for (const line of lines) {
      const parts = line.split(/\s+/)
      if (parts.length < 6) continue
      const filesystem = parts[0]
      const total = parseInt(parts[1].replace(/K$/, ''), 10) * 1024
      const used = parseInt(parts[2].replace(/K$/, ''), 10) * 1024
      const free = parseInt(parts[3].replace(/K$/, ''), 10) * 1024
      const mount = parts[parts.length - 1]

      if (!Number.isFinite(total) || total <= 0) continue

      // Skip pseudo-filesystems and clutter mounts.
      if (/^(tmpfs|devtmpfs|overlay|squashfs|efivarfs|proc|sysfs|cgroup)/.test(filesystem)) continue
      if (/^\/snap\//.test(mount)) continue
      if (mount === '/boot/efi' || mount === '/boot') continue

      disks.push({
        mount,
        filesystem,
        totalBytes: total,
        usedBytes: used,
        freeBytes: free,
        usedPercent: Number(((used / total) * 100).toFixed(1)),
      })
    }
    // Root first, then others by mount path — deterministic client-side
    // ordering, no jitter from row shuffling across polls.
    disks.sort((a, b) => {
      if (a.mount === '/') return -1
      if (b.mount === '/') return 1
      return a.mount.localeCompare(b.mount)
    })
    return disks
  } catch (err: any) {
    logger.debug(`system: df failed: ${err?.message || err}`)
    return []
  }
}

interface CpuInfo {
  usagePercent: number
  cores: number
  model: string
  loadAvg: [number, number, number]
}

interface MemoryInfo {
  totalBytes: number
  freeBytes: number
  usedBytes: number
  usedPercent: number
}

export interface SystemMetrics {
  hostname: string
  platform: NodeJS.Platform
  arch: string
  /** Host uptime — how long the MACHINE has been up. */
  uptimeSeconds: number
  /** Orka version, read from package.json at runtime. */
  version: string
  /**
   * When this server PROCESS started (ISO). Distinct from
   * `uptimeSeconds`, and the more useful of the two while developing:
   * after a rebuild, this is what tells you whether the code answering
   * you is the code you just built, or a server still running from
   * before. The version alone can't say — it only moves on `npm version`.
   */
  serverStartedAt: string
  cpu: CpuInfo
  memory: MemoryInfo
  disks: DiskEntry[]
  sampledAt: string
}

/**
 * GET /api/system/metrics
 * Snapshot of host CPU / memory / disk usage. Called by the launcher's
 * system widget on a poll interval — response is small (a few hundred
 * bytes) and computed synchronously except for the disk shell-out.
 */
// ============================================================
// PROCESS CONTROL — kill / terminate
// ============================================================

/** Signals we accept via the kill endpoint. Restricted to the two the
 *  user is likely to need (graceful vs force); anything else 400s. */
const ALLOWED_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'TERM', 'KILL'])

function normalizeSignal(input: unknown): NodeJS.Signals {
  const raw = String(input || 'TERM').toUpperCase()
  if (!ALLOWED_SIGNALS.has(raw)) return 'SIGTERM'
  return (raw.startsWith('SIG') ? raw : `SIG${raw}`) as NodeJS.Signals
}

/**
 * POST /api/system/processes/:pid/kill?signal=TERM|KILL
 *
 * Send a signal to a process on the host. Runs under the orka server's
 * uid, so it can only signal processes it owns (or every process when
 * the server was launched as root — the client is warned in the UI
 * either way).
 *
 * Guards:
 *  - pid must parse to an integer > 1 (never touch init).
 *  - Refuse to signal the orka server itself (`process.pid`) — a
 *    kill on ourselves would black-hole the confirmation response and
 *    leave the UI wondering what happened.
 *  - Refuse pid 0 (means "process group" to `process.kill`, not what
 *    the user clicked in the list).
 *
 * Response payload is deliberately small: sent signal + boolean. The
 * client re-polls the process list to reflect the effect.
 */
systemRouter.post('/processes/:pid/kill', async (req, res) => {
  try {
    const pid = parseInt(req.params.pid, 10)
    if (!Number.isFinite(pid) || pid <= 1) {
      res.status(400).json({ error: 'Invalid pid' })
      return
    }
    if (pid === process.pid) {
      res.status(400).json({ error: 'Refusing to kill the Orka server itself' })
      return
    }
    const signal = normalizeSignal(req.query.signal || req.body?.signal)

    // process.kill throws EPERM (not owner), ESRCH (already gone),
    // EINVAL (bad signal). Translate to a friendly message.
    try {
      process.kill(pid, signal)
    } catch (err: any) {
      const code = err?.code || 'UNKNOWN'
      if (code === 'ESRCH') {
        res.status(404).json({ error: 'Process not found (already exited)', code })
        return
      }
      if (code === 'EPERM') {
        res.status(403).json({ error: `Permission denied — Orka runs as ${os.userInfo().username}, cannot signal that process`, code })
        return
      }
      throw err
    }

    logger.info(`system: sent ${signal} to pid ${pid}`)
    res.json({ ok: true, pid, signal })
  } catch (error: any) {
    logger.error('Failed to kill process:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============================================================
// DETAILS — expanded views for each metric tile
// ============================================================

/**
 * Read top processes sorted by the given ps column (`-pcpu` or `-rss`).
 * Uses `ps -eo` with an explicit column list so parsing is stable across
 * distros — the header order changes when you rely on defaults.
 * Values are converted to typed numbers; `args` is truncated to keep the
 * payload compact (some invocations carry huge classpaths or JSON blobs).
 */
interface ProcessInfo {
  pid: number
  user: string
  cpuPercent: number
  memPercent: number
  rssBytes: number
  comm: string
  args: string
}

async function readTopProcesses(sortBy: 'pcpu' | 'rss', limit: number = 20): Promise<ProcessInfo[]> {
  try {
    // Delimiter trick: `comm` and `args` may contain spaces, so we ask
    // ps for `comm` and everything after it as `args`. We split the
    // first 6 columns by whitespace and take the rest as args.
    const { stdout } = await execa(
      'ps',
      ['-eo', 'pid,user,pcpu,pmem,rss,comm,args', `--sort=-${sortBy}`, '--no-headers'],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }
    )
    const lines = stdout.split('\n').filter(Boolean).slice(0, limit)
    const out: ProcessInfo[] = []
    for (const line of lines) {
      // Trim leading spaces (right-aligned pid column pads with spaces)
      const parts = line.trimStart().split(/\s+/)
      if (parts.length < 7) continue
      const [pid, user, pcpu, pmem, rss, comm, ...rest] = parts
      const argsStr = rest.join(' ')
      out.push({
        pid: parseInt(pid, 10),
        user: user,
        cpuPercent: parseFloat(pcpu) || 0,
        memPercent: parseFloat(pmem) || 0,
        rssBytes: (parseInt(rss, 10) || 0) * 1024,
        comm: comm,
        args: argsStr.length > 220 ? argsStr.slice(0, 220) + '…' : argsStr,
      })
    }
    return out
  } catch (err: any) {
    logger.debug(`system: readTopProcesses(${sortBy}) failed: ${err?.message || err}`)
    return []
  }
}

// Track previous /proc/stat per-core sample so we can compute per-core %.
// Same delta trick as the aggregate `readCpuUsagePercent`, but for each
// CPU line in /proc/stat individually. Linux-only; on other platforms we
// silently return an empty array.
interface PerCoreSample {
  perCore: Array<{ idle: number; total: number }>
  at: number
}
let lastPerCoreSample: PerCoreSample | null = null

async function readPerCoreUsage(): Promise<Array<{ core: number; usagePercent: number; speedMHz: number }>> {
  if (os.platform() !== 'linux') {
    return os.cpus().map((c, i) => ({ core: i, usagePercent: 0, speedMHz: c.speed }))
  }
  const parseSample = (text: string): Array<{ idle: number; total: number }> => {
    const rows: Array<{ idle: number; total: number }> = []
    for (const line of text.split('\n')) {
      // "cpu0 user nice sys idle iowait irq softirq steal guest guest_nice"
      const m = line.match(/^cpu(\d+)\s+(.+)$/)
      if (!m) continue
      const nums = m[2].trim().split(/\s+/).map((n) => parseInt(n, 10))
      if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) continue
      const idle = (nums[3] || 0) + (nums[4] || 0) // idle + iowait
      const total = nums.reduce((a, b) => a + b, 0)
      rows.push({ idle, total })
    }
    return rows
  }

  try {
    let prev = lastPerCoreSample
    const cur = parseSample(await fs.readFile('/proc/stat', 'utf-8'))
    if (!prev) {
      // First read: sample twice, 100ms apart, to give a real value.
      await new Promise((r) => setTimeout(r, 100))
      const cur2 = parseSample(await fs.readFile('/proc/stat', 'utf-8'))
      prev = { perCore: cur, at: Date.now() }
      lastPerCoreSample = { perCore: cur2, at: Date.now() }
      return cur2.map((row, i) => {
        const p = prev!.perCore[i]
        if (!p) return { core: i, usagePercent: 0, speedMHz: os.cpus()[i]?.speed || 0 }
        const totalDiff = row.total - p.total
        const idleDiff = row.idle - p.idle
        const pct = totalDiff > 0 ? 100 * (1 - idleDiff / totalDiff) : 0
        return {
          core: i,
          usagePercent: Number(Math.max(0, Math.min(100, pct)).toFixed(1)),
          speedMHz: os.cpus()[i]?.speed || 0,
        }
      })
    }
    lastPerCoreSample = { perCore: cur, at: Date.now() }
    return cur.map((row, i) => {
      const p = prev!.perCore[i]
      if (!p) return { core: i, usagePercent: 0, speedMHz: os.cpus()[i]?.speed || 0 }
      const totalDiff = row.total - p.total
      const idleDiff = row.idle - p.idle
      const pct = totalDiff > 0 ? 100 * (1 - idleDiff / totalDiff) : 0
      return {
        core: i,
        usagePercent: Number(Math.max(0, Math.min(100, pct)).toFixed(1)),
        speedMHz: os.cpus()[i]?.speed || 0,
      }
    })
  } catch (err: any) {
    logger.debug(`system: readPerCoreUsage failed: ${err?.message || err}`)
    return []
  }
}

/**
 * Parse memory info for different platforms:
 * - Linux: `/proc/meminfo` for richer breakdown
 * - macOS: `vm_stat` for accurate memory metrics (not fooled by caching)
 * - Other: null (fallback to os.totalmem/os.freemem)
 */
interface MemoryDetail {
  totalBytes: number
  freeBytes: number
  availableBytes: number
  usedBytes: number
  buffersBytes: number
  cachedBytes: number
  swapTotalBytes: number
  swapFreeBytes: number
  swapUsedBytes: number
}

async function readMemoryDetailMac(): Promise<MemoryDetail | null> {
  try {
    // vm_stat output (page size varies: 4KB on Intel, 16KB on Apple Silicon):
    // "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
    // "Pages free:                    1234567"
    // "Pages active:                  2345678"
    // "Pages inactive:                3456789"
    // "Pages speculative:             456789"
    // "Pages wired down:              567890"
    const { stdout } = await execa('vm_stat', [], { timeout: 2000 })

    let pageSize = 4096 // Default fallback
    const lines = stdout.split('\n')

    // Extract page size from first line if present
    const pageMatch = lines[0]?.match(/page size of (\d+) bytes/)
    if (pageMatch) {
      pageSize = parseInt(pageMatch[1], 10)
    }

    const map: Record<string, number> = {}

    for (const line of lines) {
      const m = line.match(/^Pages\s+(\w+):\s+(\d+)/)
      if (m) {
        const key = m[1]
        const pages = parseInt(m[2], 10)
        map[key] = pages * pageSize
      }
    }

    // On macOS:
    // - free: Pages free
    // - active: Pages active (in use)
    // - inactive: Pages inactive (can be reclaimed, counts as available)
    // - speculative: Pages speculative (can be reclaimed, counts as available)
    // - wired: Pages wired down (cannot be paged out)
    const freeMem = map.free || 0
    const inactiveMem = map.inactive || 0
    const speculativeMem = map.speculative || 0

    const total = os.totalmem()

    // Available memory on macOS = free + inactive + speculative
    // (these pages can be quickly reclaimed)
    const availableMem = freeMem + inactiveMem + speculativeMem

    return {
      totalBytes: total,
      freeBytes: freeMem,
      availableBytes: Math.min(availableMem, total),
      usedBytes: Math.max(0, total - availableMem),
      buffersBytes: 0, // Not applicable on macOS
      cachedBytes: inactiveMem + speculativeMem, // Cached/reclaimable
      swapTotalBytes: 0, // We could read this but it's rarely relevant on modern Macs
      swapFreeBytes: 0,
      swapUsedBytes: 0,
    }
  } catch (err: any) {
    logger.debug(`system: readMemoryDetailMac (vm_stat) failed: ${err?.message || err}`)
    return null
  }
}

async function readMemoryDetail(): Promise<MemoryDetail | null> {
  const platform = os.platform()

  if (platform === 'darwin') {
    return await readMemoryDetailMac()
  }

  if (platform !== 'linux') {
    return null
  }

  try {
    const text = await fs.readFile('/proc/meminfo', 'utf-8')
    const map: Record<string, number> = {}
    for (const line of text.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/)
      if (m) map[m[1]] = parseInt(m[2], 10) * 1024 // kB → bytes
    }
    const total = map.MemTotal || 0
    const free = map.MemFree || 0
    const available = map.MemAvailable ?? Math.max(0, total - (map.Buffers || 0) - (map.Cached || 0))
    return {
      totalBytes: total,
      freeBytes: free,
      availableBytes: available,
      usedBytes: Math.max(0, total - available),
      buffersBytes: map.Buffers || 0,
      cachedBytes: map.Cached || 0,
      swapTotalBytes: map.SwapTotal || 0,
      swapFreeBytes: map.SwapFree || 0,
      swapUsedBytes: Math.max(0, (map.SwapTotal || 0) - (map.SwapFree || 0)),
    }
  } catch (err: any) {
    logger.debug(`system: readMemoryDetail (Linux) failed: ${err?.message || err}`)
    return null
  }
}

/**
 * GET /api/system/details?category=cpu|memory|disk
 *
 * Expanded metrics for the launcher widget tile the user tapped. Each
 * category returns just the fields relevant to it — the small overview
 * endpoint (`/metrics`) is still the source for the always-visible
 * summary, so this can be lazier / heavier.
 */
systemRouter.get('/details', async (req, res) => {
  try {
    const category = String(req.query.category || 'cpu')

    if (category === 'cpu') {
      const [perCore, processes] = await Promise.all([
        readPerCoreUsage(),
        readTopProcesses('pcpu', 25),
      ])
      const cpus = os.cpus()
      const load = os.loadavg() as [number, number, number]
      res.json({
        cores: cpus.length,
        model: cpus[0]?.model || 'unknown',
        loadAvg: [
          Number(load[0].toFixed(2)),
          Number(load[1].toFixed(2)),
          Number(load[2].toFixed(2)),
        ],
        perCore,
        processes,
      })
      return
    }

    if (category === 'memory') {
      const [detail, processes] = await Promise.all([
        readMemoryDetail(),
        readTopProcesses('rss', 25),
      ])
      // Fallback for non-Linux platforms: fill from os module.
      const total = os.totalmem()
      const free = os.freemem()
      const fallback: MemoryDetail = {
        totalBytes: total,
        freeBytes: free,
        availableBytes: free,
        usedBytes: total - free,
        buffersBytes: 0,
        cachedBytes: 0,
        swapTotalBytes: 0,
        swapFreeBytes: 0,
        swapUsedBytes: 0,
      }
      res.json({
        detail: detail || fallback,
        processes,
      })
      return
    }

    if (category === 'disk') {
      const disks = await readDisks()
      res.json({ disks })
      return
    }

    res.status(400).json({ error: `Unknown category: ${category}` })
  } catch (error: any) {
    logger.error('Failed to sample system details:', error)
    res.status(500).json({ error: error.message })
  }
})

systemRouter.get('/metrics', async (_req, res) => {
  try {
    const [usagePercent, memDetail, disks, version] = await Promise.all([
      readCpuUsagePercent(),
      readMemoryDetail(),
      readDisks(),
      // Cached after the first read inside getOrkaVersion(), so this
      // costs nothing on the 3s poll.
      getOrkaVersion(),
    ])

    const cpus = os.cpus()
    const load = os.loadavg() as [number, number, number]

    // Use platform-specific memory detail if available; fallback to os module
    let total: number
    let free: number
    let used: number
    let usedPercent: number

    if (memDetail) {
      total = memDetail.totalBytes
      free = memDetail.availableBytes
      used = memDetail.usedBytes
      usedPercent = Number(((used / total) * 100).toFixed(1))
    } else {
      total = os.totalmem()
      free = os.freemem()
      used = total - free
      usedPercent = Number(((used / total) * 100).toFixed(1))
    }

    const payload: SystemMetrics = {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptimeSeconds: os.uptime(),
      version,
      // Derived rather than stamped at import: correct no matter when
      // this module was first loaded.
      serverStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      cpu: {
        usagePercent,
        cores: cpus.length,
        model: cpus[0]?.model || 'unknown',
        loadAvg: [
          Number(load[0].toFixed(2)),
          Number(load[1].toFixed(2)),
          Number(load[2].toFixed(2)),
        ],
      },
      memory: {
        totalBytes: total,
        freeBytes: free,
        usedBytes: used,
        usedPercent,
      },
      disks,
      sampledAt: new Date().toISOString(),
    }
    res.json(payload)
  } catch (error: any) {
    logger.error('Failed to sample system metrics:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============================================================
// ORKA SERVICES — enumerate + control
// ============================================================
//
// The /status page in the web UI needs a single feed of every long-lived
// process the orka server manages: the persistent whisper-server, the
// hook server (agent bridge), each agent daemon, the ttyd instances
// backing every session, and the shared system terminal. Users get a
// row per service with live CPU / RAM plus the ability to stop things
// that are safe to stop (whisper, agents) without breaking anything
// else.

export type ServiceCategory =
  | 'transcription'
  | 'hooks'
  | 'agents'
  | 'terminals'
  | 'other'

export type ServiceAction = 'stop' | 'start' | 'restart'

export interface ServiceInfo {
  id: string
  category: ServiceCategory
  name: string
  description: string
  status: 'running' | 'ready' | 'stopped' | 'unknown'
  pid?: number
  port?: number
  cpuPercent?: number
  rssBytes?: number
  memPercent?: number
  startedAt?: number
  actions: ServiceAction[]
  /** Free-form context — model name for whisper, project path for a
   *  ttyd, agent name, etc. Rendered as key/value under the row. */
  metadata?: Record<string, string | number | undefined>
}

interface PsRow {
  pid: number
  cpuPercent: number
  memPercent: number
  rssBytes: number
}

/**
 * Batched `ps` lookup — one shell-out for every pid the caller cares
 * about. Empty input returns an empty map without invoking `ps`.
 * Missing rows (process already gone) simply don't appear in the map.
 */
async function readPsForPids(pids: number[]): Promise<Map<number, PsRow>> {
  const map = new Map<number, PsRow>()
  const unique = Array.from(new Set(pids.filter((p) => Number.isFinite(p) && p > 1)))
  if (unique.length === 0) return map
  try {
    const { stdout } = await execa(
      'ps',
      ['-p', unique.join(','), '-o', 'pid,%cpu,%mem,rss', '--no-headers'],
      { timeout: 3000 }
    )
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 4) continue
      const pid = parseInt(parts[0], 10)
      if (!Number.isFinite(pid)) continue
      map.set(pid, {
        pid,
        cpuPercent: parseFloat(parts[1]) || 0,
        memPercent: parseFloat(parts[2]) || 0,
        rssBytes: (parseInt(parts[3], 10) || 0) * 1024,
      })
    }
  } catch (err: any) {
    logger.debug(`system: ps for services failed: ${err?.message || err}`)
  }
  return map
}

/**
 * Ask a specific service to do an action. Returns the concrete outcome
 * for the caller to display. All operations are idempotent: stop-when-
 * stopped and start-when-running both succeed as no-ops.
 */
// --------------------------------------------------------------------------
// Tmux session correlation — every live tmux session gets tagged with what
// it belongs to (a project's Claude session, a board master, a board task,
// the shared system terminal) so the /status UI can show useful context.
// --------------------------------------------------------------------------

interface TmuxCorrelation {
  kind: 'session' | 'board-master' | 'board-task' | 'system-terminal' | 'unknown'
  projectPath?: string
  projectName?: string
  sessionName?: string
  sessionId?: string
  boardId?: string
  taskKey?: string
  ttydPort?: number
  ttydPid?: number
}

/**
 * Build a name → correlation map by walking every registered project's
 * state + board tasks + master handles + the shared system terminal.
 * Cost is dominated by the state.json reads (one per project) — cheap.
 */
async function buildTmuxCorrelationMap(): Promise<Map<string, TmuxCorrelation>> {
  const map = new Map<string, TmuxCorrelation>()
  const globalState = await getGlobalStateManager()

  // System terminal — fixed name.
  const sysTerm = globalState.getSystemTerminal()
  if (sysTerm) {
    map.set(sysTerm.tmuxSessionId, {
      kind: 'system-terminal',
      ttydPort: sysTerm.ttydPort,
      ttydPid: sysTerm.ttydPid,
    })
  }

  // Every registered project: its state.sessions[] + its board tasks.
  const projects = globalState.getProjects()
  for (const proj of projects) {
    let projectSessions: any[] = []
    try {
      const stateMgr = new StateManager(proj.path)
      const st = await stateMgr.getState()
      projectSessions = st.sessions || []
    } catch (err: any) {
      logger.debug(`status: failed to read state for ${proj.path}: ${err?.message || err}`)
    }
    for (const s of projectSessions) {
      if (!s.tmuxSessionId) continue
      map.set(s.tmuxSessionId, {
        kind: 'session',
        projectPath: proj.path,
        projectName: proj.name,
        sessionName: s.name || s.id,
        sessionId: s.id,
        ttydPort: s.ttydPort,
        ttydPid: s.ttydPid,
      })
    }

    // Board tasks + masters — one per board.
    try {
      const bm = new BoardManager(proj.path)
      if (bm.isInitialized()) {
        const boards = await bm.listBoards()
        for (const b of boards) {
          // Master tmux name is deterministic (BoardTerminals.masterTmuxName).
          const masterName = `orka-board-master-${b.id}`
          if (!map.has(masterName)) {
            map.set(masterName, {
              kind: 'board-master',
              projectPath: proj.path,
              projectName: proj.name,
              boardId: b.id,
            })
          }
          const tasks = await bm.listTasks(b.id)
          for (const t of tasks) {
            if (!t.terminalTmuxSessionId) continue
            map.set(t.terminalTmuxSessionId, {
              kind: 'board-task',
              projectPath: proj.path,
              projectName: proj.name,
              boardId: b.id,
              taskKey: t.key,
              ttydPort: t.ttydPort,
              ttydPid: t.ttydPid,
            })
          }
        }
      }
    } catch (err: any) {
      logger.debug(`status: failed to read boards for ${proj.path}: ${err?.message || err}`)
    }
  }

  return map
}

async function performServiceAction(id: string, action: ServiceAction): Promise<{ ok: true; note?: string }> {
  if (id === 'whisper') {
    if (action === 'stop') {
      stopWhisperServer()
      return { ok: true, note: 'whisper-server terminated' }
    }
    if (action === 'start' || action === 'restart') {
      if (action === 'restart') stopWhisperServer()
      // Kick off the spawn; don't await ready — the /status page will
      // pick up the transition on its next poll.
      void getWhisperServer().catch((err: Error) => {
        logger.error(`whisper start failed: ${err.message}`)
      })
      return { ok: true, note: 'whisper-server starting' }
    }
  }
  if (id.startsWith('agent:')) {
    const agentId = id.slice('agent:'.length)
    const mgr = await getAgentManager()
    if (action === 'stop') {
      await mgr.stopAgent(agentId)
      return { ok: true, note: `agent ${agentId} stopped` }
    }
    if (action === 'start') {
      await mgr.startAgent(agentId)
      return { ok: true, note: `agent ${agentId} started` }
    }
    if (action === 'restart') {
      await mgr.stopAgent(agentId)
      await mgr.startAgent(agentId)
      return { ok: true, note: `agent ${agentId} restarted` }
    }
  }
  if (id.startsWith('tmux:')) {
    // Destructive: killing the tmux session tears down the terminal and
    // loses any unsaved shell state inside it. Only `stop` is offered on
    // the client; there's nothing to "start" (that's what session
    // resume / board task start does).
    const tmuxName = id.slice('tmux:'.length)
    if (action === 'stop') {
      try {
        await execa('tmux', ['kill-session', '-t', tmuxName])
        return { ok: true, note: `killed tmux session ${tmuxName}` }
      } catch (err: any) {
        // "can't find session" — already gone. Treat as success.
        if (/can't find session|no server running/i.test(err?.stderr || err?.message || '')) {
          return { ok: true, note: `tmux session ${tmuxName} was already gone` }
        }
        throw err
      }
    }
  }
  throw new Error(`Unsupported action "${action}" on service "${id}"`)
}

/**
 * Build the full service list for the /status page. Any per-service
 * failure (e.g. agent manager not booted) is swallowed so a single sick
 * subsystem doesn't hide the rest.
 */
async function enumerateServices(): Promise<ServiceInfo[]> {
  const services: ServiceInfo[] = []
  const pidsWanted: number[] = []

  // -- Transcription: persistent whisper-server ---------------------
  try {
    const whisper = await getWhisperServerStatus()
    const modelName = whisper.modelName || whisper.availableModel?.name || 'not downloaded'
    if (whisper.running) {
      services.push({
        id: 'whisper',
        category: 'transcription',
        name: 'Whisper server',
        description: `Persistent whisper.cpp inference server (model: ${modelName}).`,
        status: whisper.ready ? 'ready' : 'running',
        pid: whisper.pid,
        port: whisper.port,
        startedAt: whisper.startedAt,
        actions: ['stop', 'restart'],
        metadata: {
          model: modelName,
          modelPath: whisper.modelPath,
        },
      })
      if (whisper.pid) pidsWanted.push(whisper.pid)
    } else {
      services.push({
        id: 'whisper',
        category: 'transcription',
        name: 'Whisper server',
        description: whisper.availableModel
          ? `Not running. Model ready: ${whisper.availableModel.name}. Start pre-warms it (~500MB RAM).`
          : `Not running. No model downloaded — run "orka prepare" to fetch one.`,
        status: 'stopped',
        actions: whisper.availableModel ? ['start'] : [],
        metadata: {
          model: modelName,
        },
      })
    }
  } catch (err: any) {
    logger.debug(`enumerateServices whisper failed: ${err?.message || err}`)
  }

  // -- Hooks: HTTP endpoint that Claude Code posts to ---------------
  try {
    const mgr = await getAgentManager()
    // hookServer is created inside AgentManager; when it's running the
    // manager knows. We don't own its pid separately — the whole orka
    // node process hosts it.
    const hooksRunning = (mgr as any).hookServer?.isRunning?.() === true
    services.push({
      id: 'hooks',
      category: 'hooks',
      name: 'Hook server',
      description: 'HTTP endpoint receiving Claude Code hook payloads for the agent daemons. Runs in-process on port 9999.',
      status: hooksRunning ? 'running' : 'stopped',
      port: hooksRunning ? 9999 : undefined,
      // No stop/start — the manager owns lifecycle and killing this
      // breaks every active agent. Read-only.
      actions: [],
    })
  } catch (err: any) {
    logger.debug(`enumerateServices hooks failed: ${err?.message || err}`)
  }

  // -- Agents: one row per registered agent -------------------------
  try {
    const mgr = await getAgentManager()
    const agents = mgr.getAgents()
    for (const agent of agents) {
      const running = agent.status === 'active'
      services.push({
        id: `agent:${agent.id}`,
        category: 'agents',
        name: `Agent · ${agent.name}`,
        description: agent.connection?.projectPath
          ? `Autonomous agent daemon for ${agent.connection.projectPath}.`
          : 'Autonomous agent daemon.',
        status: running ? 'running' : 'stopped',
        actions: running ? ['stop', 'restart'] : ['start'],
        metadata: {
          agentId: agent.id,
          project: agent.connection?.projectPath,
        },
      })
    }
  } catch (err: any) {
    logger.debug(`enumerateServices agents failed: ${err?.message || err}`)
  }

  // -- Terminals: system terminal + per-project ttyds ---------------
  try {
    const globalState = await getGlobalStateManager()
    const sysTerm = globalState.getSystemTerminal()
    if (sysTerm) {
      services.push({
        id: 'system-terminal',
        category: 'terminals',
        name: 'System terminal',
        description: 'Shared shell terminal available from the dashboard.',
        status: 'running',
        pid: sysTerm.ttydPid,
        port: sysTerm.ttydPort,
        actions: [],
        metadata: {
          tmuxSession: sysTerm.tmuxSessionId,
        },
      })
      if (sysTerm.ttydPid) pidsWanted.push(sysTerm.ttydPid)
    }
  } catch (err: any) {
    logger.debug(`enumerateServices system-terminal failed: ${err?.message || err}`)
  }

  // -- Tmux sessions ------------------------------------------------
  //
  // One row per live tmux session with:
  //  - correlation to project / board / task / system-terminal
  //  - ttyd port (if we have one on file) so the row deep-links to the
  //    /terminal/<port> viewer
  //  - CPU% and RSS aggregated across every pane in that session
  //
  // The ttyd pids we already tracked above may also appear as their
  // own rows only when they belong to a "system-level" thing (system
  // terminal); per-tmux ttyd metrics are surfaced under the tmux row so
  // the user isn't looking at two rows that measure the same terminal.
  const tmuxSessionPidMap: Map<string, number[]> = new Map()
  try {
    const [tmuxSessions, tmuxPidsPerSession, correlations] = await Promise.all([
      TmuxCommands.listSessionsDetailed(),
      TmuxCommands.listPanePidsBySession(),
      buildTmuxCorrelationMap(),
    ])
    for (const tsess of tmuxSessions) {
      const paneIds = tmuxPidsPerSession.get(tsess.name) || []
      tmuxSessionPidMap.set(tsess.name, paneIds)
      for (const pid of paneIds) pidsWanted.push(pid)

      const corr = correlations.get(tsess.name) || { kind: 'unknown' as const }
      const startedAtMs = tsess.createdAt > 0 ? tsess.createdAt * 1000 : undefined

      // Compose a friendly name based on what this tmux session is.
      let displayName: string
      let description: string
      const metadata: Record<string, string | number | undefined> = {
        tmux: tsess.name,
        attached: tsess.attached ? 'yes' : 'no',
        windows: tsess.windows,
        panes: paneIds.length,
      }
      if (corr.projectName) metadata.project = corr.projectName
      if (corr.projectPath) metadata.path = corr.projectPath
      if (corr.sessionName) metadata.session = corr.sessionName
      if (corr.boardId) metadata.board = corr.boardId
      if (corr.taskKey) metadata.task = corr.taskKey

      if (corr.kind === 'system-terminal') {
        displayName = 'System terminal (tmux)'
        description = 'Backing tmux session for the shared dashboard shell.'
      } else if (corr.kind === 'session') {
        displayName = `${corr.projectName || 'session'} · ${corr.sessionName || corr.sessionId || tsess.name}`
        description = `Claude Code session inside ${corr.projectName || 'unknown project'}.`
      } else if (corr.kind === 'board-master') {
        displayName = `Board master · ${corr.boardId}`
        description = `Master orchestrator terminal for board ${corr.boardId}.`
      } else if (corr.kind === 'board-task') {
        displayName = `Board task · ${corr.taskKey || tsess.name}`
        description = `Task terminal for ${corr.taskKey || 'unknown task'} on board ${corr.boardId || 'unknown'}.`
      } else {
        displayName = tsess.name
        description = 'Live tmux session not tracked by Orka state — likely stale or user-created.'
      }

      services.push({
        id: `tmux:${tsess.name}`,
        category: 'terminals',
        name: displayName,
        description,
        status: 'running',
        port: corr.ttydPort,
        startedAt: startedAtMs,
        // Killing a tmux session is destructive. We expose stop but the
        // UI double-guards it with a confirm. No start/restart — those
        // are session-resume / task-start flows that live elsewhere.
        actions: ['stop'],
        metadata,
      })
    }
  } catch (err: any) {
    logger.debug(`enumerateServices tmux failed: ${err?.message || err}`)
  }

  // -- Backfill live CPU / RAM from a single ps call ----------------
  const psInfo = await readPsForPids(pidsWanted)
  for (const svc of services) {
    // Tmux sessions: sum across every pane pid we recorded.
    if (svc.id.startsWith('tmux:')) {
      const tmuxName = svc.id.slice('tmux:'.length)
      const paneIds = tmuxSessionPidMap.get(tmuxName) || []
      let cpuSum = 0, memSum = 0, rssSum = 0, seen = 0
      for (const pid of paneIds) {
        const row = psInfo.get(pid)
        if (!row) continue
        cpuSum += row.cpuPercent
        memSum += row.memPercent
        rssSum += row.rssBytes
        seen++
      }
      if (seen > 0) {
        svc.cpuPercent = Number(cpuSum.toFixed(1))
        svc.memPercent = Number(memSum.toFixed(1))
        svc.rssBytes = rssSum
      }
      continue
    }
    if (svc.pid == null) continue
    const row = psInfo.get(svc.pid)
    if (row) {
      svc.cpuPercent = row.cpuPercent
      svc.memPercent = row.memPercent
      svc.rssBytes = row.rssBytes
    } else if (svc.status === 'running' || svc.status === 'ready') {
      // We think it's running but ps didn't return anything — the
      // process is gone. Downgrade to 'unknown' so the UI can flag it.
      svc.status = 'unknown'
    }
  }

  // Sort: category → status (running first) → name.
  const catOrder: Record<ServiceCategory, number> = {
    transcription: 0, hooks: 1, agents: 2, terminals: 3, other: 4,
  }
  const statusRank = (s: ServiceInfo['status']): number =>
    s === 'ready' ? 0 : s === 'running' ? 1 : s === 'unknown' ? 2 : 3
  services.sort((a, b) => {
    if (a.category !== b.category) return catOrder[a.category] - catOrder[b.category]
    const sr = statusRank(a.status) - statusRank(b.status)
    if (sr !== 0) return sr
    return a.name.localeCompare(b.name)
  })

  return services
}

/**
 * GET /api/system/services
 * The web UI polls this every ~3s from /status.
 */
systemRouter.get('/services', async (_req, res) => {
  try {
    const services = await enumerateServices()
    res.json({ services, sampledAt: new Date().toISOString() })
  } catch (error: any) {
    logger.error('Failed to enumerate services:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/system/services/:id/:action
 * `:action` ∈ { stop, start, restart } — supported per-service (see
 * ServiceInfo.actions on the corresponding GET row).
 */
systemRouter.post('/services/:id/:action', async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id)
    const action = req.params.action as ServiceAction
    if (action !== 'stop' && action !== 'start' && action !== 'restart') {
      res.status(400).json({ error: `Unsupported action: ${action}` })
      return
    }
    const result = await performServiceAction(id, action)
    logger.info(`system-services: ${id} ${action} → ${result.note || 'ok'}`)
    res.json(result)
  } catch (error: any) {
    logger.error(`Failed service action ${req.params.id}/${req.params.action}:`, error)
    res.status(500).json({ error: error.message })
  }
})
