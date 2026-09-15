import { useCallback, useRef, useState } from 'react'
import { Mic, X, Minus, Maximize2, GripHorizontal } from 'lucide-react'
import './VoiceTerminalButton.css'

/**
 * "Talk to this terminal" — a mic button plus the voice agent docked
 * over whatever terminal it sits next to.
 *
 * Every terminal surface in the product needs this (session views, the
 * board task and master drawers, the editor panel, the launcher modals,
 * the system terminal), and they share nothing but the terminal itself.
 * Putting the button and the panel here keeps the eight call sites down
 * to one line each, and means the voice agent's URL contract lives in
 * exactly one place.
 *
 * A terminal is addressed by pane id when the caller has one and by
 * tmux session name otherwise — the server resolves the latter to its
 * active pane, so no call site has to grow bookkeeping it doesn't
 * otherwise need.
 */
export interface VoiceTerminalButtonProps {
  /** tmux pane id, when the caller knows it. */
  paneId?: string
  /** tmux session name — used when there's no pane id. */
  tmuxSession?: string
  /** What the agent should call this terminal out loud. */
  label: string
  /** ttyd port, so the agent's viewer can show the terminal live. */
  ttydPort?: number
  /** Base64 project path, for the voice session's own context. */
  projectB64?: string
  sessionId?: string
  /** Visual weight: `icon` matches toolbars, `floating` is a FAB for
   *  surfaces with no toolbar to sit in. */
  variant?: 'icon' | 'floating'
  className?: string
  title?: string
}

export function VoiceTerminalButton({
  paneId,
  tmuxSession,
  label,
  ttydPort,
  projectB64,
  sessionId,
  variant = 'icon',
  className,
  title,
}: VoiceTerminalButtonProps) {
  const [open, setOpen] = useState(false)
  const [minimized, setMinimized] = useState(false)
  // Offset from the panel's docked corner, in px. Null until dragged,
  // so it keeps its sensible default position until the user moves it.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  /**
   * Drag by the header.
   *
   * Pointer events are captured on the header rather than tracked on
   * the window so the drag survives the pointer crossing the iframe —
   * without capture, the terminal underneath swallows the move events
   * and the panel sticks to the cursor's last position outside it.
   */
  const onDragStart = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const el = panelRef.current
    if (!el) return
    e.preventDefault()
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: pos?.x ?? 0,
      baseY: pos?.y ?? 0,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [pos])

  const onDragMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setPos({ x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) })
  }, [])

  const onDragEnd = useCallback((e: React.PointerEvent) => {
    dragRef.current = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* already released */ }
  }, [])

  // Nothing to talk to — better to render nothing than a button that
  // opens an agent pointed at a terminal that doesn't exist.
  if (!paneId && !tmuxSession) return null

  const buildUrl = () => {
    const params = new URLSearchParams({ embedded: '1', terminalLabel: label })
    if (paneId) params.set('terminal', paneId)
    if (tmuxSession) params.set('tmuxSession', tmuxSession)
    if (ttydPort) params.set('ttydPort', String(ttydPort))
    if (projectB64) params.set('project', projectB64)
    if (sessionId) params.set('session', sessionId)
    return `/voice-agent?${params.toString()}`
  }

  return (
    <>
      <button
        className={
          className ??
          (variant === 'floating' ? 'voice-term-fab' : `icon-button ${open ? 'active' : ''}`)
        }
        onClick={() => setOpen(v => !v)}
        title={title ?? (open ? 'Close voice agent' : 'Talk to this terminal')}
        aria-label="Talk to this terminal"
      >
        <Mic size={variant === 'floating' ? 18 : 14} />
      </button>

      {open && (
        <div
          ref={panelRef}
          className={`voice-term-panel${minimized ? ' minimized' : ''}`}
          style={pos ? { transform: `translate(${pos.x}px, ${pos.y}px)` } : undefined}
        >
          <div
            className="voice-term-header"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
          >
            <GripHorizontal size={12} className="voice-term-grip" />
            <span className="voice-term-title">Voice · {label}</span>
            <button
              className="voice-term-close"
              onClick={() => setMinimized(m => !m)}
              title={minimized ? 'Expand' : 'Minimize'}
            >
              {minimized ? <Maximize2 size={12} /> : <Minus size={13} />}
            </button>
            <button className="voice-term-close" onClick={() => setOpen(false)} title="Close">
              <X size={13} />
            </button>
          </div>
          {/* The iframe stays MOUNTED while minimized — unmounting it
              would drop the WebSocket and end the conversation, which is
              not what "minimize" means. */}
          <iframe
            className="voice-term-frame"
            title={`Voice agent — ${label}`}
            allow="microphone; clipboard-read; clipboard-write"
            src={buildUrl()}
          />
        </div>
      )}
    </>
  )
}
