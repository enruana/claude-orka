import { useState } from 'react'
import { Mic, X } from 'lucide-react'
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
        <div className="voice-term-panel">
          <div className="voice-term-header">
            <Mic size={12} />
            <span className="voice-term-title">Voice · {label}</span>
            <button className="voice-term-close" onClick={() => setOpen(false)} title="Close">
              <X size={13} />
            </button>
          </div>
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
