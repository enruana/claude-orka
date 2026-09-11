import { useState, useEffect, useCallback, useRef } from 'react'
import { TerminalSquare, X, Plus, Loader2, ChevronDown } from 'lucide-react'
import { api, EditorTerminal } from '../../api/client'

/**
 * The editor's terminal panel, shared by both editor shells.
 *
 * There are two of them — the full-page editor and the one embedded in
 * a session's Code tab — and they render different chrome around the
 * same Monaco. The terminal belongs to both, so it lives here as a hook
 * plus a presentational panel rather than being written twice.
 */

const HEIGHT_KEY = 'orka.editor.terminalHeight'

export interface EditorTerminalsControl {
  open: boolean
  terminals: EditorTerminal[]
  active: string | null
  starting: boolean
  error: string | null
  height: number
  setOpen: (open: boolean) => void
  setActive: (cwd: string) => void
  clearError: () => void
  /** Open (or focus) a shell at `cwd`; defaults to the project root. */
  openAt: (cwd?: string) => Promise<void>
  /** End the shell for good — ttyd and its tmux session. */
  kill: (cwd: string) => Promise<void>
  toggle: () => Promise<void>
  onResizeStart: (e: React.MouseEvent) => void
}

export function useEditorTerminals(projectPath: string): EditorTerminalsControl {
  const [open, setOpen] = useState(false)
  const [terminals, setTerminals] = useState<EditorTerminal[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState(() => {
    const n = parseInt(localStorage.getItem(HEIGHT_KEY) || '', 10)
    return Number.isFinite(n) ? Math.min(Math.max(n, 120), 700) : 280
  })

  const openAt = useCallback(async (cwd?: string) => {
    setOpen(true)
    setError(null)
    // Reattaching is the server's job — asking twice for the same
    // directory returns the same shell — so no need to guess here.
    const known = cwd ? terminals.find(t => t.cwd === cwd) : null
    if (known) { setActive(known.cwd); return }
    setStarting(true)
    try {
      const term = await api.getEditorTerminal(projectPath, cwd)
      setTerminals(prev => prev.some(t => t.cwd === term.cwd) ? prev : [...prev, term])
      setActive(term.cwd)
    } catch (err: any) {
      setError(err?.message || 'Could not start the terminal')
    } finally {
      setStarting(false)
    }
  }, [projectPath, terminals])

  const toggle = useCallback(async () => {
    if (open) { setOpen(false); return }
    if (terminals.length > 0) { setOpen(true); return }
    await openAt()
  }, [open, terminals.length, openAt])

  const kill = useCallback(async (cwd: string) => {
    try {
      await api.stopEditorTerminal(cwd)
    } catch (err: any) {
      setError(err?.message || 'Could not stop the terminal')
    }
    setTerminals(prev => {
      const next = prev.filter(t => t.cwd !== cwd)
      setActive(cur => (cur === cwd ? (next[0]?.cwd ?? null) : cur))
      if (next.length === 0) setOpen(false)
      return next
    })
  }, [])

  // Adopt shells that outlived a previous visit, so their tabs are there
  // to resume — or to kill — instead of being orphaned.
  useEffect(() => {
    let cancelled = false
    api.listEditorTerminals(projectPath)
      .then(list => {
        if (cancelled || list.length === 0) return
        setTerminals(list)
        setActive(cur => cur ?? list[0].cwd)
      })
      .catch(() => { /* older server without the route; nothing to adopt */ })
    return () => { cancelled = true }
  }, [projectPath])

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    const startY = e.clientY
    const startHeight = height
    const onMove = (ev: MouseEvent) => {
      // Dragging UP grows the panel, hence the inverted delta.
      setHeight(Math.min(Math.max(startHeight - (ev.clientY - startY), 120), 700))
    }
    const onUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setHeight(h => { localStorage.setItem(HEIGHT_KEY, String(h)); return h })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [height])

  const clearError = useCallback(() => setError(null), [])

  return {
    open, terminals, active, starting, error, height,
    setOpen, setActive, clearError, openAt, kill, toggle, onResizeStart,
  }
}

/** Ctrl+` — the shortcut every editor uses for this. */
export function useTerminalShortcut(toggle: () => Promise<void>) {
  const ref = useRef(toggle)
  useEffect(() => { ref.current = toggle }, [toggle])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault()
        void ref.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function EditorTerminalPanel({
  ctl,
  projectPath,
  projectName,
}: {
  ctl: EditorTerminalsControl
  projectPath: string
  projectName: string
}) {
  if (!ctl.open) return null

  return (
    <>
      <div className="terminal-resize-handle" onMouseDown={ctl.onResizeStart} />
      <div className="editor-terminal-panel" style={{ height: ctl.height }}>
        <div className="editor-terminal-header">
          <TerminalSquare size={13} />
          <div className="editor-terminal-tabs">
            {ctl.terminals.map(t => {
              const rel = t.cwd === projectPath
                ? projectName
                : t.cwd.slice(projectPath.length).replace(/^\//, '')
              return (
                <div
                  key={t.cwd}
                  className={`editor-terminal-tab ${ctl.active === t.cwd ? 'active' : ''}`}
                  onClick={() => ctl.setActive(t.cwd)}
                  title={t.cwd}
                >
                  <span className="editor-terminal-tab-name">{rel}</span>
                  <button
                    className="editor-terminal-kill"
                    onClick={(e) => { e.stopPropagation(); void ctl.kill(t.cwd) }}
                    title={`Kill this shell — ${t.cwd}`}
                    aria-label={`Kill terminal at ${rel}`}
                  >
                    <X size={12} />
                  </button>
                </div>
              )
            })}
            <button
              className="editor-terminal-new"
              onClick={() => void ctl.openAt()}
              title="New terminal at the project root"
              aria-label="New terminal"
            >
              <Plus size={13} />
            </button>
          </div>
          <button
            className="editor-terminal-close"
            onClick={() => ctl.setOpen(false)}
            title="Hide the panel (shells keep running)"
          >
            <ChevronDown size={15} />
          </button>
        </div>
        <div className="editor-terminal-body">
          {ctl.error && (
            <div className="editor-terminal-banner error">
              {ctl.error}
              <button onClick={ctl.clearError}><X size={12} /></button>
            </div>
          )}
          {/* Every terminal stays mounted and hidden rather than
              unmounted: remounting the iframe drops the ttyd websocket
              and the shell redraws from scratch. */}
          {ctl.terminals.map(t => (
            <iframe
              key={t.cwd}
              className="editor-terminal-frame"
              style={{ display: ctl.active === t.cwd ? 'block' : 'none' }}
              src={`/terminal/${t.port}?desktop=1`}
              title={`Terminal — ${t.cwd}`}
            />
          ))}
          {ctl.starting && (
            <div className="editor-terminal-message">
              <Loader2 size={16} className="editor-terminal-spin" />
              <span>Starting terminal…</span>
            </div>
          )}
          {!ctl.starting && ctl.terminals.length === 0 && !ctl.error && (
            <div className="editor-terminal-message">No terminals open.</div>
          )}
        </div>
      </div>
    </>
  )
}
