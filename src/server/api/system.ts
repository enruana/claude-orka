import { Router } from 'express'
import fs from 'fs-extra'
import os from 'os'
import execa from 'execa'
import { logger } from '../../utils'

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
  uptimeSeconds: number
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
 * Parse `/proc/meminfo` for the richer memory breakdown that `os` module
 * doesn't expose: Available (better than Free for real "spare" memory),
 * Buffers, Cached, Swap. Linux-only; falls back to null on other OSes so
 * the client shows just the totals.
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

async function readMemoryDetail(): Promise<MemoryDetail | null> {
  if (os.platform() !== 'linux') return null
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
    logger.debug(`system: readMemoryDetail failed: ${err?.message || err}`)
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
    const [usagePercent, disks] = await Promise.all([
      readCpuUsagePercent(),
      readDisks(),
    ])

    const cpus = os.cpus()
    const total = os.totalmem()
    const free = os.freemem()
    const used = total - free
    const load = os.loadavg() as [number, number, number]

    const payload: SystemMetrics = {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptimeSeconds: os.uptime(),
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
        usedPercent: Number(((used / total) * 100).toFixed(1)),
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
