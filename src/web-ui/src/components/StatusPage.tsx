import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  X,
  RefreshCw,
  Play,
  Square,
  RotateCcw,
  Cpu,
  MemoryStick,
  Mic2,
  Radio,
  Bot,
  Terminal,
  Circle,
  ExternalLink,
} from 'lucide-react'
import {
  api,
  type SystemMetrics,
  type ServiceInfo,
  type ServiceCategory,
  type ServiceAction,
} from '../api/client'
import '../styles/status.css'

/**
 * `/status` — Orka's system dashboard.
 *
 * Top: host metrics (CPU / RAM / disk) with the same 3-second poll the
 * launcher's SystemWidget uses.
 *
 * Middle: catalog of Orka-managed services (whisper server, hook
 * server, agent daemons, ttyd instances, system terminal) with live
 * CPU / RAM and inline stop / start / restart actions.
 *
 * Fetching two independent endpoints keeps the widget cheap for the
 * launcher (metrics only) while the /status page pulls both.
 */

const POLL_INTERVAL_MS = 3000

// ---------- Formatting helpers --------------------------------------------

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(0)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(0)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(1)} GB`
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

function formatSince(msSinceEpoch?: number): string {
  if (!msSinceEpoch) return '—'
  const secs = Math.floor((Date.now() - msSinceEpoch) / 1000)
  return formatUptime(secs)
}

function usageColor(pct: number): string {
  if (pct >= 90) return '#f38ba8'
  if (pct >= 75) return '#f9e2af'
  return '#a6e3a1'
}

// ---------- Category presentation -----------------------------------------

interface CategoryPresentation {
  label: string
  icon: React.ReactNode
  hint: string
}

const CATEGORY_META: Record<ServiceCategory, CategoryPresentation> = {
  transcription: {
    label: 'Transcription',
    icon: <Mic2 size={16} />,
    hint: 'Whisper inference used by the Chrome side panel live-transcription. Stop to reclaim ~500MB RAM when you\'re not recording.',
  },
  hooks: {
    label: 'Hooks',
    icon: <Radio size={16} />,
    hint: 'HTTP endpoint that receives Claude Code hook payloads. Core infra — read-only here.',
  },
  agents: {
    label: 'Agents',
    icon: <Bot size={16} />,
    hint: 'Autonomous daemons watching a project. Stop when the project is idle.',
  },
  terminals: {
    label: 'Terminals',
    icon: <Terminal size={16} />,
    hint: 'ttyd instances backing session terminals. Killing one drops that terminal — use with care.',
  },
  other: {
    label: 'Other',
    icon: <Circle size={16} />,
    hint: '',
  },
}

// ---------- Component ------------------------------------------------------

export function StatusPage() {
  const navigate = useNavigate()

  const [metrics, setMetrics] = useState<SystemMetrics | null>(null)
  const [services, setServices] = useState<ServiceInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [lastFetchAt, setLastFetchAt] = useState<number>(0)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ id: string; note: string; kind: 'ok' | 'err' } | null>(null)
  const inflightRef = useRef(false)

  const load = useCallback(async () => {
    if (inflightRef.current) return
    inflightRef.current = true
    try {
      const [m, s] = await Promise.all([
        api.getSystemMetrics(),
        api.getSystemServices(),
      ])
      setMetrics(m)
      setServices(s.services)
      setError(null)
      setLastFetchAt(Date.now())
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch status')
    } finally {
      inflightRef.current = false
    }
  }, [])

  useEffect(() => {
    void load()
    const id = window.setInterval(load, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [load])

  const runAction = useCallback(async (svcId: string, action: ServiceAction) => {
    // Destructive actions get a confirm — tmux kill loses shell state,
    // agent stop drops the daemon that may be mid-decision. Whisper
    // stop is safe so it slips through.
    if (action === 'stop' && (svcId.startsWith('tmux:') || svcId.startsWith('agent:'))) {
      const label = svcId.startsWith('tmux:')
        ? `Kill tmux session "${svcId.slice('tmux:'.length)}"? This closes the terminal — any unsaved shell state will be lost.`
        : `Stop agent "${svcId.slice('agent:'.length)}"? Its daemon will exit and stop responding to Claude Code hooks.`
      if (!window.confirm(label)) return
    }

    const key = `${svcId}:${action}`
    setPendingAction(key)
    try {
      const r = await api.runServiceAction(svcId, action)
      setFlash({ id: svcId, note: r.note || 'done', kind: 'ok' })
      // Kick a fresh poll so the row updates without waiting for the tick.
      setTimeout(() => void load(), 400)
    } catch (err: any) {
      setFlash({ id: svcId, note: err?.message || 'action failed', kind: 'err' })
    } finally {
      setPendingAction(null)
      setTimeout(() => setFlash((f) => (f && f.id === svcId ? null : f)), 2500)
    }
  }, [load])

  // Group services by category preserving the server-side order (they
  // arrived pre-sorted).
  const grouped = new Map<ServiceCategory, ServiceInfo[]>()
  for (const s of services) {
    const list = grouped.get(s.category) || []
    list.push(s)
    grouped.set(s.category, list)
  }

  const primaryDisk = metrics?.disks.find((d) => d.mount === '/') || metrics?.disks[0]

  return (
    <div className="status-page">
      <header className="status-header">
        <button
          className="orka-close-btn"
          onClick={() => navigate(-1)}
          title="Close (Esc)"
          aria-label="Close"
        >
          <X size={16} />
        </button>
        <h1>System status</h1>
        <div className="status-header-meta">
          {metrics && (
            <span title={`${metrics.hostname} · ${metrics.platform}/${metrics.arch}`}>
              {metrics.hostname} · up {formatUptime(metrics.uptimeSeconds)}
            </span>
          )}
          <button
            className="status-refresh"
            onClick={load}
            title="Refresh now"
            disabled={inflightRef.current}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {error && (
        <div className="status-error">
          Couldn't fetch status: {error}
        </div>
      )}

      {/* -------- Host metrics ------------------------------------- */}

      <section className="status-metrics">
        {!metrics ? (
          <div className="status-metrics-loading">Loading host metrics…</div>
        ) : (
          <>
            <MetricTile
              icon={<Cpu size={14} />}
              label="CPU"
              value={`${metrics.cpu.usagePercent.toFixed(0)}%`}
              subLine={`${metrics.cpu.cores}c · load ${metrics.cpu.loadAvg[0].toFixed(2)}`}
              percent={metrics.cpu.usagePercent}
            />
            <MetricTile
              icon={<MemoryStick size={14} />}
              label="RAM"
              value={`${metrics.memory.usedPercent.toFixed(0)}%`}
              subLine={`${formatBytes(metrics.memory.usedBytes)} / ${formatBytes(metrics.memory.totalBytes)}`}
              percent={metrics.memory.usedPercent}
            />
            {primaryDisk && (
              <MetricTile
                icon={<MemoryStick size={14} />}
                label={`Disk (${primaryDisk.mount})`}
                value={`${primaryDisk.usedPercent.toFixed(0)}%`}
                subLine={`${formatBytes(primaryDisk.freeBytes)} free`}
                percent={primaryDisk.usedPercent}
              />
            )}
          </>
        )}
      </section>

      {/* -------- Services list ------------------------------------ */}

      <section className="status-services">
        {Array.from(grouped.entries()).map(([category, svcs]) => (
          <div key={category} className="status-category">
            <div className="status-category-head">
              <span className="status-category-icon">{CATEGORY_META[category].icon}</span>
              <span className="status-category-label">{CATEGORY_META[category].label}</span>
              <span className="status-category-count">{svcs.length}</span>
            </div>
            {CATEGORY_META[category].hint && (
              <p className="status-category-hint">{CATEGORY_META[category].hint}</p>
            )}
            <ul className="status-service-list">
              {svcs.map((svc) => (
                <ServiceRow
                  key={svc.id}
                  service={svc}
                  pending={pendingAction}
                  flash={flash && flash.id === svc.id ? flash : null}
                  onAction={runAction}
                />
              ))}
            </ul>
          </div>
        ))}
        {services.length === 0 && !error && (
          <div className="status-empty">No services running.</div>
        )}
      </section>

      <footer className="status-footer">
        {lastFetchAt > 0 && (
          <>Sampled {formatSinceReadable(lastFetchAt)} · polling every {POLL_INTERVAL_MS / 1000}s</>
        )}
      </footer>
    </div>
  )
}

// ---------- Sub-components -------------------------------------------------

function MetricTile({
  icon, label, value, subLine, percent,
}: {
  icon: React.ReactNode
  label: string
  value: string
  subLine: string
  percent: number
}) {
  const color = usageColor(percent)
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div className="status-metric-tile">
      <div className="status-metric-head">
        <span className="status-metric-icon">{icon}</span>
        <span className="status-metric-label">{label}</span>
        <span className="status-metric-value" style={{ color }}>{value}</span>
      </div>
      <div className="status-metric-bar">
        <div className="status-metric-bar-fill" style={{ width: `${clamped}%`, background: color }} />
      </div>
      <div className="status-metric-sub">{subLine}</div>
    </div>
  )
}

function StatusPill({ status }: { status: ServiceInfo['status'] }) {
  return <span className={`status-pill status-pill-${status}`}>{status}</span>
}

function ActionButton({
  action, disabled, onClick,
}: { action: ServiceAction; disabled: boolean; onClick: () => void }) {
  const icons: Record<ServiceAction, React.ReactNode> = {
    stop: <Square size={12} />,
    start: <Play size={12} />,
    restart: <RotateCcw size={12} />,
  }
  const labels: Record<ServiceAction, string> = {
    stop: 'Stop', start: 'Start', restart: 'Restart',
  }
  return (
    <button
      className={`status-action status-action-${action}`}
      onClick={onClick}
      disabled={disabled}
      title={labels[action]}
    >
      {icons[action]}
      <span>{labels[action]}</span>
    </button>
  )
}

function ServiceRow({
  service, pending, flash, onAction,
}: {
  service: ServiceInfo
  pending: string | null
  flash: { note: string; kind: 'ok' | 'err' } | null
  onAction: (id: string, action: ServiceAction) => void
}) {
  const metadataEntries = Object.entries(service.metadata || {})
    .filter(([, v]) => v !== undefined && v !== '' && v !== null)

  return (
    <li className={`status-service status-service-${service.status}`}>
      <div className="status-service-main">
        <div className="status-service-title-row">
          <span className="status-service-name">{service.name}</span>
          <StatusPill status={service.status} />
        </div>
        <p className="status-service-desc">{service.description}</p>
        {metadataEntries.length > 0 && (
          <dl className="status-service-meta">
            {metadataEntries.map(([k, v]) => (
              <div key={k} className="status-service-meta-row">
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div className="status-service-metrics">
        {typeof service.cpuPercent === 'number' && (
          <div className="status-service-metric">
            <span className="status-service-metric-label">CPU</span>
            <span className="status-service-metric-value">{service.cpuPercent.toFixed(1)}%</span>
          </div>
        )}
        {typeof service.rssBytes === 'number' && (
          <div className="status-service-metric">
            <span className="status-service-metric-label">RSS</span>
            <span className="status-service-metric-value">{formatBytes(service.rssBytes)}</span>
          </div>
        )}
        {typeof service.port === 'number' && (
          <div className="status-service-metric">
            <span className="status-service-metric-label">Port</span>
            <span className="status-service-metric-value">{service.port}</span>
          </div>
        )}
        {typeof service.pid === 'number' && (
          <div className="status-service-metric">
            <span className="status-service-metric-label">PID</span>
            <span className="status-service-metric-value">{service.pid}</span>
          </div>
        )}
        {service.startedAt && (
          <div className="status-service-metric">
            <span className="status-service-metric-label">Up</span>
            <span className="status-service-metric-value">{formatSince(service.startedAt)}</span>
          </div>
        )}
      </div>
      <div className="status-service-actions">
        {service.port && (
          <a
            className="status-action status-action-open"
            href={`/terminal/${service.port}?desktop=1`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open the terminal in a new tab"
          >
            <ExternalLink size={12} />
            <span>Open</span>
          </a>
        )}
        {service.actions.length === 0 && !service.port && !flash && (
          <span className="status-service-noop">read-only</span>
        )}
        {service.actions.map((a) => (
          <ActionButton
            key={a}
            action={a}
            disabled={pending === `${service.id}:${a}`}
            onClick={() => onAction(service.id, a)}
          />
        ))}
        {flash && (
          <span className={`status-service-flash ${flash.kind}`}>
            {flash.note}
          </span>
        )}
      </div>
    </li>
  )
}

function formatSinceReadable(msSinceEpoch: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - msSinceEpoch) / 1000))
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  return `${mins}m ago`
}
