export type AgentActivity = 'working' | 'waiting' | 'idle'

export interface AgentActivitySignals {
  agentActivity?: AgentActivity
  agentActivityAt?: string
  lastStopAt?: string
  lastToolName?: string
  waitingForInput?: boolean
}

/** Post-Stop grace window: keep rendering 'working' for a short while
 *  after the last Stop so an active conversation doesn't flash gray
 *  between turns. See board-task-close for the rationale — the user
 *  picks 'yes' to the grace window in the design questions. */
const POST_STOP_GRACE_MS = 15_000

/** After this much silence with an unchanged 'working' state we stop
 *  trusting it — the CLI probably crashed without a Stop. */
const WORKING_STALE_MS = 90_000

/** Derive the visual state from persisted activity + the grace rules
 *  the UI applies before rendering. Exported so places that need a
 *  richer label ("Trabajando en Write") can reuse the same logic. */
export function resolveActivity(sig: AgentActivitySignals, now: number = Date.now()): {
  state: AgentActivity | null
  label: string
  detail?: string
} {
  const stopAt = sig.lastStopAt ? Date.parse(sig.lastStopAt) : 0
  const activityAt = sig.agentActivityAt ? Date.parse(sig.agentActivityAt) : 0

  if (sig.agentActivity === 'waiting' || sig.waitingForInput) {
    return { state: 'waiting', label: 'Esperando input', detail: 'Claude pidió permiso o una decisión' }
  }

  if (sig.agentActivity === 'working') {
    if (activityAt && now - activityAt > WORKING_STALE_MS) {
      return { state: null, label: 'Sin actividad', detail: `Último evento ${humanAgo(now - activityAt)}` }
    }
    return {
      state: 'working',
      label: sig.lastToolName ? `Trabajando (${sig.lastToolName})` : 'Trabajando',
      detail: sig.lastToolName ? `Último tool: ${sig.lastToolName}` : undefined,
    }
  }

  if (sig.agentActivity === 'idle') {
    if (stopAt && now - stopAt < POST_STOP_GRACE_MS) {
      return { state: 'working', label: 'Trabajando (conversación activa)', detail: `Último turno ${humanAgo(now - stopAt)}` }
    }
    return { state: null, label: 'Idle', detail: activityAt ? `Último evento ${humanAgo(now - activityAt)}` : undefined }
  }

  return { state: null, label: 'Sin señal' }
}

function humanAgo(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `hace ${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `hace ${m}m`
  const h = Math.round(m / 60)
  return `hace ${h}h`
}

interface Props {
  signals: AgentActivitySignals
  className?: string
  size?: number
  title?: string
}

/**
 * Small colored dot indicator. Uses inline styles so it can drop into
 * launcher / kanban / stream deck without depending on any of their
 * CSS. Verde pulsante = working, ámbar pulsante = waiting, nothing
 * rendered when idle so cards stay clean.
 */
export function AgentActivityDot({ signals, className, size = 8, title }: Props) {
  const res = resolveActivity(signals)
  if (!res.state) return null
  const color = res.state === 'working' ? '#a6e3a1' : '#fab387'
  return (
    <span
      className={`orka-activity-dot ${res.state} ${className || ''}`}
      title={title || `${res.label}${res.detail ? ' — ' + res.detail : ''}`}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '999px',
        background: color,
        boxShadow: `0 0 0 2px rgba(30, 30, 46, 0.9), 0 0 ${size * 1.5}px ${color}`,
        animation: 'orka-activity-pulse 1.4s ease-in-out infinite',
      }}
    />
  )
}
