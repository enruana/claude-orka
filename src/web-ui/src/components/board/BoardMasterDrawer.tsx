import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  RefreshCw,
  X,
} from 'lucide-react'

/**
 * Bottom-anchored drawer that embeds the Board's master terminal.
 *
 * Two rendering modes based on viewport width:
 *
 * - **Desktop (>768px)**: drawer with drag-to-resize handle, iframe uses
 *   the desktop terminal layout (`?desktop=1`). The drawer sits at the
 *   bottom of the board page; toggling grows/shrinks it in-place.
 *
 * - **Mobile (≤768px)**: the collapsed pill still shows at the bottom of
 *   the board page, but tapping it opens a *fullscreen modal* instead
 *   of expanding inline. The modal iframes the mobile terminal page
 *   (custom virtual keyboard, quick actions, OSC 52 clipboard) —
 *   without those the drawer at ~180px was unusable on a phone.
 *
 * The parent owns `expanded` so the state can be persisted per-board.
 */
interface Props {
  expanded: boolean
  onToggle: () => void
  port: number | null
  lastSyncedAt?: string
  syncing?: boolean
  /** Identifier stamped on the iframe as `data-orka-session-id` so shared
   *  widgets like CommentWidget can target the master specifically when
   *  a task modal isn't in the foreground. */
  sessionId?: string
}

const MIN_H = 180
const MAX_H_FRAC = 0.7
const EXIT_MS = 200

function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(max-width: 768px)').matches
}

export function BoardMasterDrawer({ expanded, onToggle, port, lastSyncedAt, syncing, sessionId }: Props) {
  const [height, setHeight] = useState<number>(() => {
    const raw = localStorage.getItem('orka-board-master-height')
    const n = raw ? Number(raw) : 320
    return Number.isFinite(n) && n >= MIN_H ? n : 320
  })
  const [isMobile, setIsMobile] = useState(isMobileViewport())
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  useEffect(() => {
    localStorage.setItem('orka-board-master-height', String(height))
  }, [height])

  // Track viewport width so a rotation / DevTools resize switches the
  // rendering mode without a reload.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const onChange = () => setIsMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: e.clientY, startH: height }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const dy = dragRef.current.startY - e.clientY
    const next = Math.max(MIN_H, Math.min(window.innerHeight * MAX_H_FRAC, dragRef.current.startH + dy))
    setHeight(next)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }

  // Two-phase close for the mobile modal so the exit animation plays
  // before we tell the parent to collapse. Same pattern as BoardTaskModal.
  const [exiting, setExiting] = useState(false)
  const exitTimerRef = useRef<number | null>(null)
  const startClose = useCallback(() => {
    if (exiting) return
    setExiting(true)
    exitTimerRef.current = window.setTimeout(() => {
      setExiting(false)
      onToggle()
    }, EXIT_MS)
  }, [exiting, onToggle])

  useEffect(() => () => {
    if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current)
  }, [])

  useEffect(() => {
    if (!isMobile || !expanded) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') startClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMobile, expanded, startClose])

  // The status pill shown regardless of mode. Same layout as before.
  const pill = (
    <button className="board-master-toggle" onClick={onToggle}>
      <span className="board-master-title">
        <RefreshCw size={12} className={syncing ? 'spinning' : ''} />
        Master Terminal
      </span>
      <span className="board-master-status">
        {port ? (
          <span className="board-master-dot running" title="Running" />
        ) : (
          <span className="board-master-dot idle" title="Not running" />
        )}
        <span className="board-master-lastsync">
          {lastSyncedAt ? `last sync ${new Date(lastSyncedAt).toLocaleString()}` : 'never synced'}
        </span>
      </span>
      <span className="board-master-caret">
        {expanded && !isMobile ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </span>
    </button>
  )

  // Mobile: pill stays as a collapsed bar at the bottom. When expanded,
  // a separate fullscreen modal renders on top of the board page —
  // taking the whole viewport and iframe'ing the *mobile* terminal
  // page so the custom keyboard and quick actions come along for free.
  if (isMobile) {
    return (
      <>
        <div className="board-master-drawer collapsed">{pill}</div>
        {expanded && port && (
          <div
            className={`board-master-mobile-modal ${exiting ? 'exiting' : 'entering'}`}
            role="dialog"
            aria-modal="true"
          >
            <header className="board-master-mobile-header">
              <button
                className="board-master-mobile-close"
                onClick={startClose}
                aria-label="Close master terminal"
              >
                <X size={16} />
              </button>
              <div className="board-master-mobile-title">
                <RefreshCw size={12} className={syncing ? 'spinning' : ''} />
                <span>Master Terminal</span>
                <span className={`board-master-dot ${port ? 'running' : 'idle'}`} />
              </div>
              <button
                className="board-master-mobile-popout"
                onClick={() => window.open(`/terminal/${port}?desktop=1`, '_blank')}
                aria-label="Open in new tab"
                title="Open in new tab"
              >
                <ExternalLink size={14} />
              </button>
            </header>
            <iframe
              src={`/terminal/${port}`}
              title="Board Master Terminal"
              className="board-master-mobile-iframe terminal-iframe"
              data-orka-session-id={sessionId}
              allow="clipboard-read; clipboard-write; microphone"
            />
          </div>
        )}
      </>
    )
  }

  // Desktop: drag-to-resize drawer with the inline iframe.
  return (
    <div
      className={`board-master-drawer ${expanded ? 'expanded' : 'collapsed'}`}
      style={expanded ? { height } : undefined}
    >
      {expanded && (
        <div
          className="board-master-resize"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      )}
      {pill}
      {expanded && port && (
        <div className="board-master-body">
          <div className="board-master-toolbar">
            <button
              className="board-master-popout"
              onClick={() => window.open(`/terminal/${port}?desktop=1`, '_blank')}
              title="Pop out master terminal"
            >
              <ExternalLink size={12} /> Open in new tab
            </button>
          </div>
          <iframe
            src={`/terminal/${port}?desktop=1`}
            title="Board Master Terminal"
            className="board-master-iframe terminal-iframe"
            data-orka-session-id={sessionId}
            allow="clipboard-read; clipboard-write; microphone"
          />
        </div>
      )}
    </div>
  )
}
