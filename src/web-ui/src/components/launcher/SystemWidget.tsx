import { useEffect, useRef, useState } from 'react'
import { Cpu, MemoryStick, HardDrive } from 'lucide-react'
import { api, SystemMetrics } from '../../api/client'
import { SystemDetailsModal } from './SystemDetailsModal'

/**
 * iOS-style system widget for the launcher home screen.
 *
 * Polls `/api/system/metrics` every 3 seconds and renders three metric
 * tiles (CPU, RAM, primary disk) inside a rounded frosted-glass card
 * that matches the folder icons visually. Uses a small history buffer
 * (last 32 samples) to draw a mini sparkline of CPU usage — enough to
 * hint at spikes without demanding another polling layer.
 *
 * Fetches are best-effort: errors set an inline "unavailable" state on
 * the affected tile, keep the widget mounted, and retry on the next
 * tick. The widget never blocks or hides the launcher grid.
 */

const POLL_INTERVAL_MS = 3000
const HISTORY_LEN = 32
const SPARKLINE_WIDTH = 60
const SPARKLINE_HEIGHT = 20

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(0)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(0)} MB`
  const gb = mb / 1024
  if (gb < 1024) return `${gb.toFixed(1)} GB`
  const tb = gb / 1024
  return `${tb.toFixed(2)} TB`
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** Warm accent when a metric is above 80% — mirrors the folder waiting
 *  indicator's amber so the launcher palette stays coherent. */
function usageColor(pct: number): string {
  if (pct >= 90) return '#f38ba8'
  if (pct >= 75) return '#f9e2af'
  return '#a6e3a1'
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) {
    return <svg width={SPARKLINE_WIDTH} height={SPARKLINE_HEIGHT} aria-hidden="true" />
  }
  const step = SPARKLINE_WIDTH / (HISTORY_LEN - 1)
  const points = values.map((v, i) => {
    const x = i * step
    // Invert Y so higher usage = higher on-chart. Reserve 1px of top
    // padding so a 100% value doesn't clip against the SVG edge.
    const y = SPARKLINE_HEIGHT - 1 - (Math.max(0, Math.min(100, v)) / 100) * (SPARKLINE_HEIGHT - 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  return (
    <svg width={SPARKLINE_WIDTH} height={SPARKLINE_HEIGHT} className="system-widget-spark" aria-hidden="true">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
        opacity={0.85}
      />
    </svg>
  )
}

function Bar({ percent, color }: { percent: number; color: string }) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div className="system-widget-bar">
      <div
        className="system-widget-bar-fill"
        style={{ width: `${clamped}%`, background: color }}
      />
    </div>
  )
}

export function SystemWidget() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cpuHistoryRef = useRef<number[]>([])
  // Force re-render when we mutate the ref (sparkline redraw).
  const [, forceTick] = useState(0)
  const [detail, setDetail] = useState<'cpu' | 'memory' | 'disk' | null>(null)

  useEffect(() => {
    let alive = true
    let inFlight = false

    const load = async () => {
      // Skip overlapping polls if a previous request is still resolving —
      // most likely during a stalled network. Prevents pileups on slow
      // links that would otherwise stack responses on top of each other.
      if (inFlight) return
      inFlight = true
      try {
        const data = await api.getSystemMetrics()
        if (!alive) return
        setMetrics(data)
        setError(null)
        const hist = cpuHistoryRef.current
        hist.push(data.cpu.usagePercent)
        if (hist.length > HISTORY_LEN) hist.shift()
        forceTick((t) => (t + 1) % 1_000_000)
      } catch (err: any) {
        if (!alive) return
        setError(err?.message || 'Unavailable')
      } finally {
        inFlight = false
      }
    }
    void load()
    const id = window.setInterval(load, POLL_INTERVAL_MS)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  if (!metrics && error) {
    return (
      <div className="system-widget system-widget-error" role="status">
        System metrics unavailable
      </div>
    )
  }
  if (!metrics) {
    return (
      <div className="system-widget system-widget-loading" role="status">
        <div className="system-widget-spinner" />
      </div>
    )
  }

  // Take the primary disk (mount === '/' or first entry) for the tile.
  // Users with unusual mount layouts see whatever the server sorted first.
  const primaryDisk = metrics.disks.find((d) => d.mount === '/') || metrics.disks[0]

  const cpuColor = usageColor(metrics.cpu.usagePercent)
  const memColor = usageColor(metrics.memory.usedPercent)
  const diskColor = primaryDisk ? usageColor(primaryDisk.usedPercent) : '#a6e3a1'

  return (
    <div className="system-widget" role="group" aria-label="System status">
      <div className="system-widget-header">
        <span className="system-widget-title">System</span>
        <span className="system-widget-host" title={`${metrics.hostname} · ${metrics.platform}/${metrics.arch} · up ${formatUptime(metrics.uptimeSeconds)}`}>
          {metrics.hostname} · up {formatUptime(metrics.uptimeSeconds)}
        </span>
      </div>

      <div className="system-widget-tiles">
        <button
          type="button"
          className="system-widget-tile"
          onClick={() => setDetail('cpu')}
          aria-label="Show CPU details"
        >
          <div className="system-widget-tile-head">
            <Cpu size={14} />
            <span>CPU</span>
            <span className="system-widget-tile-value" style={{ color: cpuColor }}>
              {metrics.cpu.usagePercent.toFixed(0)}%
            </span>
          </div>
          <Bar percent={metrics.cpu.usagePercent} color={cpuColor} />
          <div className="system-widget-tile-sub">
            <Sparkline values={cpuHistoryRef.current} color={cpuColor} />
            <span className="system-widget-tile-detail" title={metrics.cpu.model}>
              {metrics.cpu.cores}c · load {metrics.cpu.loadAvg[0].toFixed(2)}
            </span>
          </div>
        </button>

        <button
          type="button"
          className="system-widget-tile"
          onClick={() => setDetail('memory')}
          aria-label="Show memory details"
        >
          <div className="system-widget-tile-head">
            <MemoryStick size={14} />
            <span>RAM</span>
            <span className="system-widget-tile-value" style={{ color: memColor }}>
              {metrics.memory.usedPercent.toFixed(0)}%
            </span>
          </div>
          <Bar percent={metrics.memory.usedPercent} color={memColor} />
          <div className="system-widget-tile-sub">
            <span className="system-widget-tile-detail">
              {formatBytes(metrics.memory.usedBytes)} / {formatBytes(metrics.memory.totalBytes)}
            </span>
          </div>
        </button>

        {primaryDisk && (
          <button
            type="button"
            className="system-widget-tile"
            onClick={() => setDetail('disk')}
            aria-label="Show storage details"
          >
            <div className="system-widget-tile-head">
              <HardDrive size={14} />
              <span>Disk</span>
              <span className="system-widget-tile-value" style={{ color: diskColor }}>
                {primaryDisk.usedPercent.toFixed(0)}%
              </span>
            </div>
            <Bar percent={primaryDisk.usedPercent} color={diskColor} />
            <div className="system-widget-tile-sub">
              <span className="system-widget-tile-detail" title={`${primaryDisk.filesystem} on ${primaryDisk.mount}`}>
                {formatBytes(primaryDisk.freeBytes)} free · {primaryDisk.mount}
              </span>
            </div>
          </button>
        )}
      </div>

      {detail && <SystemDetailsModal category={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}
