import { useEffect, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Cpu, MemoryStick, HardDrive, XCircle, AlertTriangle } from 'lucide-react'
import {
  api,
  SystemCpuDetails,
  SystemMemoryDetails,
  SystemDiskDetails,
  SystemProcessInfo,
} from '../../api/client'

/**
 * Expanded view for a system-widget tile. Renders as a full-screen
 * sheet on mobile and a centered card on wider viewports — same
 * pattern as the "Copy from Terminal" modal so the launcher feels
 * cohesive. Data is fetched from `/api/system/details?category=X` on
 * open and every `POLL_INTERVAL_MS` while the modal is visible so the
 * user can watch a spike unfold.
 */

const POLL_INTERVAL_MS = 2500

type Category = 'cpu' | 'memory' | 'disk'

interface Props {
  category: Category
  onClose: () => void
}

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

function usageColor(pct: number): string {
  if (pct >= 90) return '#f38ba8'
  if (pct >= 75) return '#f9e2af'
  return '#a6e3a1'
}

// Best-effort human-readable label from a process command line. Handles
// common patterns (interpreter + script, snap wrappers, kernel threads
// in brackets) so the list reads like a task manager instead of a shell
// history.
function humanizeProcess(comm: string, args: string): { title: string; subtitle: string } {
  if (!args) return { title: comm, subtitle: '' }
  // Kernel threads: comm is bracketed already
  if (/^\[.+\]$/.test(comm)) return { title: comm, subtitle: 'kernel thread' }

  const argv = args.split(/\s+/).filter(Boolean)
  const first = argv[0] || comm
  const firstBase = first.split('/').pop() || first
  const rest = argv.slice(1)

  // Interpreter + script: node|python|ruby|... path/to/script.js
  if (/^(node|python\d*|python|ruby|perl|deno|bun|java|dotnet|php)$/.test(firstBase) && rest.length > 0) {
    const script = rest.find((r) => !r.startsWith('-')) || rest[0]
    const scriptBase = script?.split('/').pop() || script || comm
    return { title: `${firstBase} ${scriptBase}`, subtitle: args }
  }

  // Chromium/Firefox with --type= flags
  if (/^(chrome|chromium|firefox|firefox-esr)$/.test(firstBase)) {
    const type = rest.find((r) => r.startsWith('--type='))
    if (type) return { title: `${firstBase} (${type.slice('--type='.length)})`, subtitle: args }
    return { title: firstBase, subtitle: args }
  }

  return { title: firstBase, subtitle: args }
}

function ProcessRow({
  p,
  valueField,
  onKillClick,
}: {
  p: SystemProcessInfo
  valueField: 'cpu' | 'mem'
  onKillClick: (p: SystemProcessInfo) => void
}) {
  const { title, subtitle } = humanizeProcess(p.comm, p.args)
  const value = valueField === 'cpu' ? p.cpuPercent : p.memPercent
  const rightSecondary = valueField === 'cpu'
    ? `RSS ${formatBytes(p.rssBytes)}`
    : `${p.cpuPercent.toFixed(1)}% CPU`
  const color = usageColor(value)

  return (
    <div className="sys-detail-proc-row">
      <div className="sys-detail-proc-info">
        <div className="sys-detail-proc-title" title={p.args || p.comm}>{title}</div>
        <div className="sys-detail-proc-sub">
          <span className="sys-detail-proc-pid">#{p.pid}</span>
          <span>·</span>
          <span>{p.user}</span>
          <span className="sys-detail-proc-args">· {subtitle || p.comm}</span>
        </div>
      </div>
      <div className="sys-detail-proc-value">
        <div className="sys-detail-proc-value-main" style={{ color }}>
          {value.toFixed(1)}%
        </div>
        <div className="sys-detail-proc-value-sub">{rightSecondary}</div>
      </div>
      <button
        type="button"
        className="sys-detail-proc-kill"
        onClick={(e) => {
          // The row itself is not clickable, but the kill button lives
          // inside the modal body which polls every 2.5s — stop the
          // propagation so a mid-request click doesn't get swallowed by
          // the row's hover-state re-render.
          e.stopPropagation()
          onKillClick(p)
        }}
        title={`Kill ${title} (pid ${p.pid})`}
        aria-label={`Kill ${title}`}
      >
        <XCircle size={16} />
      </button>
    </div>
  )
}

function CpuBody({ data, onKillClick }: { data: SystemCpuDetails; onKillClick: (p: SystemProcessInfo) => void }) {
  return (
    <>
      <div className="sys-detail-stat-row">
        <div className="sys-detail-stat">
          <span className="sys-detail-stat-label">Cores</span>
          <span className="sys-detail-stat-value">{data.cores}</span>
        </div>
        <div className="sys-detail-stat">
          <span className="sys-detail-stat-label">Load 1m / 5m / 15m</span>
          <span className="sys-detail-stat-value">
            {data.loadAvg[0].toFixed(2)} · {data.loadAvg[1].toFixed(2)} · {data.loadAvg[2].toFixed(2)}
          </span>
        </div>
      </div>
      <div className="sys-detail-model" title={data.model}>{data.model}</div>

      {data.perCore.length > 0 && (
        <div className="sys-detail-section">
          <div className="sys-detail-section-title">Per-core usage</div>
          <div className="sys-detail-cores">
            {data.perCore.map((c) => (
              <div key={c.core} className="sys-detail-core">
                <div className="sys-detail-core-head">
                  <span className="sys-detail-core-label">c{c.core}</span>
                  <span className="sys-detail-core-value" style={{ color: usageColor(c.usagePercent) }}>
                    {c.usagePercent.toFixed(0)}%
                  </span>
                </div>
                <div className="sys-detail-core-bar">
                  <div
                    className="sys-detail-core-bar-fill"
                    style={{
                      width: `${Math.max(0, Math.min(100, c.usagePercent))}%`,
                      background: usageColor(c.usagePercent),
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sys-detail-section">
        <div className="sys-detail-section-title">Top processes by CPU</div>
        <div className="sys-detail-proc-list">
          {data.processes.map((p) => (
            <ProcessRow key={p.pid} p={p} valueField="cpu" onKillClick={onKillClick} />
          ))}
          {data.processes.length === 0 && (
            <div className="sys-detail-empty">No processes reported.</div>
          )}
        </div>
      </div>
    </>
  )
}

function MemoryBody({ data, onKillClick }: { data: SystemMemoryDetails; onKillClick: (p: SystemProcessInfo) => void }) {
  const d = data.detail
  const usedPercent = d.totalBytes > 0 ? (d.usedBytes / d.totalBytes) * 100 : 0
  const swapPercent = d.swapTotalBytes > 0 ? (d.swapUsedBytes / d.swapTotalBytes) * 100 : 0

  return (
    <>
      <div className="sys-detail-hero">
        <div className="sys-detail-hero-percent" style={{ color: usageColor(usedPercent) }}>
          {usedPercent.toFixed(1)}%
        </div>
        <div className="sys-detail-hero-detail">
          {formatBytes(d.usedBytes)} used of {formatBytes(d.totalBytes)}
        </div>
      </div>

      <div className="sys-detail-stat-row">
        <div className="sys-detail-stat">
          <span className="sys-detail-stat-label">Available</span>
          <span className="sys-detail-stat-value">{formatBytes(d.availableBytes)}</span>
        </div>
        <div className="sys-detail-stat">
          <span className="sys-detail-stat-label">Free</span>
          <span className="sys-detail-stat-value">{formatBytes(d.freeBytes)}</span>
        </div>
        <div className="sys-detail-stat">
          <span className="sys-detail-stat-label">Buffers</span>
          <span className="sys-detail-stat-value">{formatBytes(d.buffersBytes)}</span>
        </div>
        <div className="sys-detail-stat">
          <span className="sys-detail-stat-label">Cached</span>
          <span className="sys-detail-stat-value">{formatBytes(d.cachedBytes)}</span>
        </div>
      </div>

      {d.swapTotalBytes > 0 && (
        <div className="sys-detail-section">
          <div className="sys-detail-section-title">Swap</div>
          <div className="sys-detail-swap">
            <div className="sys-detail-swap-head">
              <span>{formatBytes(d.swapUsedBytes)} / {formatBytes(d.swapTotalBytes)}</span>
              <span style={{ color: usageColor(swapPercent) }}>{swapPercent.toFixed(1)}%</span>
            </div>
            <div className="sys-detail-swap-bar">
              <div
                className="sys-detail-swap-bar-fill"
                style={{ width: `${swapPercent}%`, background: usageColor(swapPercent) }}
              />
            </div>
          </div>
        </div>
      )}

      <div className="sys-detail-section">
        <div className="sys-detail-section-title">Top processes by memory</div>
        <div className="sys-detail-proc-list">
          {data.processes.map((p) => (
            <ProcessRow key={p.pid} p={p} valueField="mem" onKillClick={onKillClick} />
          ))}
          {data.processes.length === 0 && (
            <div className="sys-detail-empty">No processes reported.</div>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * Confirmation dialog before a kill signal is sent. Same visual style
 * as the "Add comment" injected dialog in HTML previews so the launcher
 * palette stays coherent. Offers TERM (graceful) by default with a
 * secondary "Force kill" button that upgrades to SIGKILL.
 */
function KillConfirmDialog({
  target,
  busy,
  onCancel,
  onConfirm,
}: {
  target: SystemProcessInfo
  busy: boolean
  onCancel: () => void
  onConfirm: (force: boolean) => void
}) {
  const { title } = humanizeProcess(target.comm, target.args)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
      if (e.key === 'Enter' && !busy) onConfirm(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel, onConfirm])

  return createPortal(
    <div
      className="sys-detail-confirm-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel() }}
    >
      <div className="sys-detail-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sys-detail-confirm-icon">
          <AlertTriangle size={22} />
        </div>
        <div className="sys-detail-confirm-title">Kill process?</div>
        <div className="sys-detail-confirm-summary">
          <div className="sys-detail-confirm-comm">{title}</div>
          <div className="sys-detail-confirm-meta">
            pid <b>{target.pid}</b> · user {target.user} · RSS {formatBytes(target.rssBytes)}
          </div>
        </div>
        <div className="sys-detail-confirm-warning">
          Sends SIGTERM (graceful). The process gets a chance to clean up before exiting.
        </div>
        <div className="sys-detail-confirm-actions">
          <button
            type="button"
            className="sys-detail-confirm-btn secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="sys-detail-confirm-btn tertiary"
            onClick={() => onConfirm(true)}
            disabled={busy}
            title="Sends SIGKILL — the process cannot catch or ignore it"
          >
            Force kill
          </button>
          <button
            type="button"
            className="sys-detail-confirm-btn primary"
            onClick={() => onConfirm(false)}
            disabled={busy}
          >
            {busy ? 'Killing…' : 'Kill'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function DiskBody({ data }: { data: SystemDiskDetails }) {
  if (data.disks.length === 0) {
    return <div className="sys-detail-empty">No disks reported.</div>
  }
  return (
    <div className="sys-detail-section">
      <div className="sys-detail-section-title">Mounted filesystems</div>
      <div className="sys-detail-disks">
        {data.disks.map((d) => (
          <div key={d.mount} className="sys-detail-disk">
            <div className="sys-detail-disk-head">
              <div className="sys-detail-disk-mount">{d.mount}</div>
              <div className="sys-detail-disk-percent" style={{ color: usageColor(d.usedPercent) }}>
                {d.usedPercent.toFixed(1)}%
              </div>
            </div>
            <div className="sys-detail-disk-bar">
              <div
                className="sys-detail-disk-bar-fill"
                style={{ width: `${d.usedPercent}%`, background: usageColor(d.usedPercent) }}
              />
            </div>
            <div className="sys-detail-disk-detail">
              <span>{formatBytes(d.usedBytes)} used</span>
              <span>·</span>
              <span>{formatBytes(d.freeBytes)} free</span>
              <span>·</span>
              <span>{formatBytes(d.totalBytes)} total</span>
              <span className="sys-detail-disk-fs" title={d.filesystem}>· {d.filesystem}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SystemDetailsModal({ category, onClose }: Props) {
  const [cpuData, setCpuData] = useState<SystemCpuDetails | null>(null)
  const [memData, setMemData] = useState<SystemMemoryDetails | null>(null)
  const [diskData, setDiskData] = useState<SystemDiskDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlightRef = useRef(false)
  // Kill flow: target is the process being confirmed, busy blocks the
  // dialog while the request is in flight, toast surfaces the outcome.
  const [killTarget, setKillTarget] = useState<SystemProcessInfo | null>(null)
  const [killBusy, setKillBusy] = useState(false)
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      try {
        if (category === 'cpu') {
          const data = await api.getSystemDetails('cpu') as SystemCpuDetails
          if (alive) { setCpuData(data); setError(null) }
        } else if (category === 'memory') {
          const data = await api.getSystemDetails('memory') as SystemMemoryDetails
          if (alive) { setMemData(data); setError(null) }
        } else if (category === 'disk') {
          const data = await api.getSystemDetails('disk') as SystemDiskDetails
          if (alive) { setDiskData(data); setError(null) }
        }
      } catch (err: any) {
        if (alive) setError(err?.message || 'Failed to load details')
      } finally {
        inFlightRef.current = false
      }
    }
    void load()
    const id = window.setInterval(load, POLL_INTERVAL_MS)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [category])

  // Esc closes the outer modal (unless the confirm dialog is open,
  // where Esc closes the dialog instead — handled inside it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (killTarget) return
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, killTarget])

  // Auto-dismiss toast so it doesn't stick around after a rapid series
  // of kills.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.kind === 'ok' ? 1800 : 3200)
    return () => clearTimeout(t)
  }, [toast])

  const handleKillClick = useCallback((p: SystemProcessInfo) => {
    setKillTarget(p)
  }, [])

  const handleKillConfirm = useCallback(async (force: boolean) => {
    if (!killTarget) return
    setKillBusy(true)
    const { title: procTitle } = humanizeProcess(killTarget.comm, killTarget.args)
    try {
      const result = await api.killProcess(killTarget.pid, force)
      // Optimistic UI: strip the killed pid from whichever list is on
      // screen so the row disappears immediately. The next poll (2.5s)
      // catches whatever state the process ended up in.
      if (category === 'cpu' && cpuData) {
        setCpuData({ ...cpuData, processes: cpuData.processes.filter(p => p.pid !== killTarget.pid) })
      } else if (category === 'memory' && memData) {
        setMemData({ ...memData, processes: memData.processes.filter(p => p.pid !== killTarget.pid) })
      }
      setToast({ msg: `Sent ${result.signal} to ${procTitle} (pid ${killTarget.pid})`, kind: 'ok' })
      setKillTarget(null)
    } catch (err: any) {
      setToast({ msg: err?.message || 'Failed to kill process', kind: 'err' })
      // Leave the dialog open so the user can retry with force, or cancel.
    } finally {
      setKillBusy(false)
    }
  }, [killTarget, category, cpuData, memData])

  const title =
    category === 'cpu' ? 'CPU'
    : category === 'memory' ? 'Memory'
    : 'Storage'

  const Icon = category === 'cpu' ? Cpu : category === 'memory' ? MemoryStick : HardDrive

  const loaded = (category === 'cpu' && cpuData)
    || (category === 'memory' && memData)
    || (category === 'disk' && diskData)

  return createPortal(
    <div
      className="sys-detail-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !killTarget) onClose() }}
    >
      <div className="sys-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sys-detail-header">
          <div className="sys-detail-title">
            <Icon size={18} />
            <span>{title}</span>
          </div>
          <button className="sys-detail-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="sys-detail-body">
          {!loaded && !error && (
            <div className="sys-detail-loading">
              <div className="sys-detail-spinner" />
              <span>Loading…</span>
            </div>
          )}
          {error && !loaded && (
            <div className="sys-detail-error">{error}</div>
          )}
          {category === 'cpu' && cpuData && <CpuBody data={cpuData} onKillClick={handleKillClick} />}
          {category === 'memory' && memData && <MemoryBody data={memData} onKillClick={handleKillClick} />}
          {category === 'disk' && diskData && <DiskBody data={diskData} />}
        </div>
      </div>

      {killTarget && (
        <KillConfirmDialog
          target={killTarget}
          busy={killBusy}
          onCancel={() => { if (!killBusy) setKillTarget(null) }}
          onConfirm={handleKillConfirm}
        />
      )}

      {toast && (
        <div className={`sys-detail-toast ${toast.kind === 'err' ? 'error' : ''}`}>
          {toast.msg}
        </div>
      )}
    </div>,
    document.body,
  )
}
