import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, X, Check, Trash2, ClipboardList, Mic, ListTodo, MessageSquare, Terminal, Pin, FolderOpen } from 'lucide-react'
import { api, ProjectTask, ProjectPin } from '../api/client'
import { VoiceInputPopover } from './VoiceInputPopover'
import { CommentWidget } from './CommentWidget'
import { CopyFromTerminalModal } from './CopyFromTerminalModal'
import { encodeProjectPath } from './ProjectDashboard'
import './task-widget.css'

type ActivePanel = 'none' | 'menu' | 'tasks' | 'voice' | 'comments' | 'copy-terminal' | 'pins'

interface TaskWidgetProps {
  projectPath: string
  /** Explicit session id — wins over URL extraction. Required when the
   *  widget is mounted from a route that does not carry the canonical
   *  `/projects/:enc/sessions/:id` path (e.g. inside the launcher modal,
   *  which keeps the user on `/launcher` while showing a session). */
  sessionId?: string
  /** When present, redirects terminal-related actions (Copy from Terminal
   *  capture, Cmd+K context) to the board task endpoints instead of the
   *  classic session ones. Board task terminals aren't stored in
   *  `state.json` so the classic capture returns 404 for their key. */
  boardContext?: { boardId: string; taskKey: string }
}

interface FabPosition {
  x: number
  y: number
}

const STORAGE_KEY = 'orka-fab-position'
const FAB_SIZE = 56
const EDGE_MARGIN = 8

function loadPosition(): FabPosition | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return null
}

function savePosition(pos: FabPosition) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pos))
  } catch { /* ignore */ }
}

function clampPosition(x: number, y: number): FabPosition {
  const maxX = window.innerWidth - FAB_SIZE - EDGE_MARGIN
  const maxY = window.innerHeight - FAB_SIZE - EDGE_MARGIN
  return {
    x: Math.max(EDGE_MARGIN, Math.min(x, maxX)),
    y: Math.max(EDGE_MARGIN, Math.min(y, maxY)),
  }
}

function getDefaultPosition(): FabPosition {
  return clampPosition(20, window.innerHeight - FAB_SIZE - 20)
}

function sendToTerminal(text: string) {
  const iframe = document.querySelector('iframe.terminal-iframe') as HTMLIFrameElement | null
  if (iframe?.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'terminal-input', text }, '*')
    setTimeout(() => iframe.focus(), 100)
  }
}

function hasTerminal(): boolean {
  return !!document.querySelector('iframe.terminal-iframe')
}

// Extract sessionId from current URL path: /projects/:encodedPath/sessions/:sessionId
function getSessionIdFromUrl(): string | null {
  const match = window.location.pathname.match(/\/projects\/[^/]+\/sessions\/([^/?#]+)/)
  return match ? match[1] : null
}

export function TaskWidget({ projectPath, sessionId: sessionIdProp, boardContext }: TaskWidgetProps) {
  const [active, setActive] = useState<ActivePanel>('none')
  const [tasks, setTasks] = useState<ProjectTask[]>([])
  const [newTitle, setNewTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [terminalAvailable, setTerminalAvailable] = useState(false)
  const [position, setPosition] = useState<FabPosition>(() => loadPosition() || getDefaultPosition())
  const [dragging, setDragging] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    startPosX: 0,
    startPosY: 0,
    moved: false,
  })

  const pendingCount = tasks.filter(t => !t.completed).length
  const [commentCount, setCommentCount] = useState(0)
  const [pins, setPins] = useState<ProjectPin[]>([])

  // Fetch comment count for badge
  useEffect(() => {
    const fetchCount = async () => {
      try {
        const comments = await api.listComments(projectPath)
        setCommentCount(comments.filter(c => !c.resolved).length)
      } catch { /* ignore */ }
    }
    fetchCount()
    const interval = setInterval(fetchCount, 5000)
    return () => clearInterval(interval)
  }, [projectPath])

  // Fetch pins — populate the pins panel and drive the badge on the FAB
  // speed-dial button. Polling every 5s covers the case where the user
  // pinned in a KB detail panel opened in another tab.
  useEffect(() => {
    const fetchPins = async () => {
      try {
        const list = await api.listPins(projectPath)
        setPins(list)
      } catch { /* ignore — non-critical */ }
    }
    fetchPins()
    const interval = setInterval(fetchPins, 5000)
    return () => clearInterval(interval)
  }, [projectPath])

  const encodedProject = encodeProjectPath(projectPath)

  const handleOpenPin = (pin: ProjectPin) => {
    // Navigate to the Finder rooted at the pinned folder. Same URL shape
    // `handleOpenFile` in KBDetailPanel uses for a folder target, minus
    // the `_blank` window flag — the FAB is inside SessionView so we
    // want the user to stay in the same tab.
    const url = `/projects/${encodedProject}/files?path=${encodeURIComponent(pin.folderPath)}`
    window.open(url, '_blank')
  }

  const handleUnpin = async (entityId: string) => {
    // Optimistic update — remove locally, roll back on error.
    const previous = pins
    setPins(prev => prev.filter(p => p.entityId !== entityId))
    try {
      await api.deletePin(projectPath, entityId)
    } catch {
      setPins(previous)
    }
  }

  // Determine which side popovers should open toward
  const fabCenterX = position.x + FAB_SIZE / 2
  const fabCenterY = position.y + FAB_SIZE / 2
  const opensRight = fabCenterX < window.innerWidth / 2
  const opensUp = fabCenterY > window.innerHeight / 2

  // Keep position clamped on resize
  useEffect(() => {
    const handleResize = () => {
      setPosition(prev => clampPosition(prev.x, prev.y))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // --- Drag handling ---
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Only drag with primary button / single touch
    if (e.button !== 0) return
    // Don't start drag if clicking inside popovers
    if ((e.target as HTMLElement).closest('.task-popover, .voice-modal, .actions-speed-dial')) return

    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startPosX: position.x,
      startPosY: position.y,
      moved: false,
    }

    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [position])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag.active) return

    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY

    // Threshold to distinguish drag from click
    if (!drag.moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return

    drag.moved = true
    if (!dragging) setDragging(true)

    const clamped = clampPosition(drag.startPosX + dx, drag.startPosY + dy)
    setPosition(clamped)
  }, [dragging])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag.active) return

    drag.active = false

    if (drag.moved) {
      // Was a drag - save position, don't toggle menu
      savePosition(clampPosition(position.x, position.y))
      setDragging(false)
    } else {
      // Was a click - toggle menu
      setActive(prev => prev === 'none' ? 'menu' : 'none')
    }

    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }, [position])

  // Check terminal availability periodically
  useEffect(() => {
    const check = () => setTerminalAvailable(hasTerminal())
    check()
    const interval = setInterval(check, 2000)
    return () => clearInterval(interval)
  }, [])

  const fetchTasks = useCallback(async () => {
    try {
      const data = await api.listTasks(projectPath)
      setTasks(data)
    } catch {
      // silently fail
    }
  }, [projectPath])

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  useEffect(() => {
    if (active === 'tasks') {
      fetchTasks()
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [active, fetchTasks])

  // Click outside to close — skipped for copy-terminal which renders via portal
  // and has its own click-outside handler on the overlay. Without this skip,
  // any mousedown inside the portalled modal would close it mid-selection.
  useEffect(() => {
    if (active === 'none' || active === 'copy-terminal') return

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setActive('none')
      }
    }

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [active])

  const openPanel = (panel: ActivePanel) => {
    setActive(prev => prev === panel ? 'none' : panel)
  }

  // Keyboard shortcut: Cmd+Shift+C / Ctrl+Shift+C opens the Copy Terminal modal.
  // Also listens for 'orka-copy-from-terminal' postMessage events forwarded
  // from inside the terminal iframe (where the parent's keydown doesn't fire).
  useEffect(() => {
    if (!terminalAvailable) return

    const toggleCopyTerminal = () => {
      if (active === 'copy-terminal') {
        setActive('none')
        return
      }
      if (active !== 'none' && active !== 'menu') return
      setActive('copy-terminal')
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // Cmd+L / Ctrl+L — open Copy from Terminal modal
      const isShortcut = (e.metaKey || e.ctrlKey) && (e.key === 'l' || e.key === 'L')
      if (!isShortcut) return

      const ae = document.activeElement as HTMLElement | null
      if (ae) {
        const tag = ae.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) return
      }

      e.preventDefault()
      toggleCopyTerminal()
    }

    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'orka-copy-from-terminal') toggleCopyTerminal()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('message', onMessage)
    }
  }, [terminalAvailable, active]) // eslint-disable-line react-hooks/exhaustive-deps

  // Terminal capture — fetches both plain (for clipboard) and ANSI (for
  // display) from the current session's active pane. When `boardContext`
  // is set the capture routes through the Board task endpoint (pane info
  // lives in `.boards/<id>/tasks.json`, not `state.json`); otherwise it
  // falls back to the classic session flow.
  const captureSession = useCallback(async () => {
    if (boardContext) {
      const [plainRes, ansiRes] = await Promise.all([
        api.captureBoardTaskPane(projectPath, boardContext.boardId, boardContext.taskKey, { lines: 400 }),
        api.captureBoardTaskPane(projectPath, boardContext.boardId, boardContext.taskKey, { lines: 400, ansi: true }),
      ])
      return { plain: plainRes.text || '', ansi: ansiRes.text || '' }
    }
    const sessionId = sessionIdProp || getSessionIdFromUrl()
    if (!sessionId) {
      return { plain: '(No active session found in URL)', ansi: '' }
    }
    const [plainRes, ansiRes] = await Promise.all([
      api.captureTerminalPane(projectPath, sessionId, { lines: 400 }),
      api.captureTerminalPane(projectPath, sessionId, { lines: 400, ansi: true }),
    ])
    return { plain: plainRes.text || '', ansi: ansiRes.text || '' }
  }, [projectPath, sessionIdProp, boardContext])

  // --- Task CRUD ---
  const handleAdd = async () => {
    const title = newTitle.trim()
    if (!title || loading) return

    setLoading(true)
    try {
      const task = await api.createTask(projectPath, title)
      setTasks(prev => [...prev, task])
      setNewTitle('')
      inputRef.current?.focus()
    } catch {
      // silently fail
    } finally {
      setLoading(false)
    }
  }

  const handleToggle = async (task: ProjectTask) => {
    const newCompleted = !task.completed
    setTasks(prev =>
      prev.map(t =>
        t.id === task.id
          ? { ...t, completed: newCompleted, completedAt: newCompleted ? new Date().toISOString() : undefined }
          : t
      )
    )
    try {
      await api.updateTask(projectPath, task.id, { completed: newCompleted })
    } catch {
      setTasks(prev =>
        prev.map(t =>
          t.id === task.id ? { ...t, completed: task.completed, completedAt: task.completedAt } : t
        )
      )
    }
  }

  const handleDelete = async (taskId: string) => {
    const prevTasks = tasks
    setTasks(prev => prev.filter(t => t.id !== taskId))
    try {
      await api.deleteTask(projectPath, taskId)
    } catch {
      setTasks(prevTasks)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAdd()
    }
  }

  // Dynamic popover/speed-dial placement styles
  const popoverStyle: React.CSSProperties = {
    ...(opensUp ? { bottom: 64 } : { top: 64 }),
    ...(opensRight ? { left: 0 } : { right: 0 }),
  }

  const speedDialStyle: React.CSSProperties = {
    ...(opensUp ? { bottom: 64 } : { top: 64, flexDirection: 'column-reverse' as const }),
    ...(opensRight ? { left: 4 } : { right: 4, alignItems: 'flex-end' as const }),
  }

  return (
    <div
      className={`actions-fab-container ${dragging ? 'dragging' : ''}`}
      ref={containerRef}
      style={{ left: position.x, top: position.y, bottom: 'auto', right: 'auto' }}
    >

      {/* Speed dial menu */}
      {active === 'menu' && (
        <div className="actions-speed-dial" style={speedDialStyle}>
          {terminalAvailable && (
            <div className="speed-dial-item">
              {opensRight ? (
                <>
                  <button className="speed-dial-btn voice" onClick={() => openPanel('voice')} title="Voice input">
                    <Mic size={20} />
                  </button>
                  <span className="speed-dial-label">Voice</span>
                </>
              ) : (
                <>
                  <span className="speed-dial-label">Voice</span>
                  <button className="speed-dial-btn voice" onClick={() => openPanel('voice')} title="Voice input">
                    <Mic size={20} />
                  </button>
                </>
              )}
            </div>
          )}
          <div className="speed-dial-item">
            {opensRight ? (
              <>
                <button className="speed-dial-btn tasks" onClick={() => openPanel('tasks')} title="Tasks">
                  <ListTodo size={20} />
                  {pendingCount > 0 && <span className="task-count-badge">{pendingCount}</span>}
                </button>
                <span className="speed-dial-label">Tasks</span>
              </>
            ) : (
              <>
                <span className="speed-dial-label">Tasks</span>
                <button className="speed-dial-btn tasks" onClick={() => openPanel('tasks')} title="Tasks">
                  <ListTodo size={20} />
                  {pendingCount > 0 && <span className="task-count-badge">{pendingCount}</span>}
                </button>
              </>
            )}
          </div>
          <div className="speed-dial-item">
            {opensRight ? (
              <>
                <button className="speed-dial-btn comments" onClick={() => openPanel('comments')} title="Comments">
                  <MessageSquare size={20} />
                  {commentCount > 0 && <span className="task-count-badge">{commentCount}</span>}
                </button>
                <span className="speed-dial-label">Comments</span>
              </>
            ) : (
              <>
                <span className="speed-dial-label">Comments</span>
                <button className="speed-dial-btn comments" onClick={() => openPanel('comments')} title="Comments">
                  <MessageSquare size={20} />
                  {commentCount > 0 && <span className="task-count-badge">{commentCount}</span>}
                </button>
              </>
            )}
          </div>
          {terminalAvailable && (
            <div className="speed-dial-item">
              {opensRight ? (
                <>
                  <button className="speed-dial-btn copy-terminal" onClick={() => openPanel('copy-terminal')} title="Copy from Terminal">
                    <Terminal size={20} />
                  </button>
                  <span className="speed-dial-label">Copy Terminal</span>
                </>
              ) : (
                <>
                  <span className="speed-dial-label">Copy Terminal</span>
                  <button className="speed-dial-btn copy-terminal" onClick={() => openPanel('copy-terminal')} title="Copy from Terminal">
                    <Terminal size={20} />
                  </button>
                </>
              )}
            </div>
          )}
          {/* Pinned KB shortcuts. Badge shows the current count so the user
              knows at a glance whether there's anything to jump to. */}
          <div className="speed-dial-item">
            {opensRight ? (
              <>
                <button className="speed-dial-btn pins" onClick={() => openPanel('pins')} title="Pinned shortcuts">
                  <Pin size={20} />
                  {pins.length > 0 && <span className="task-count-badge">{pins.length}</span>}
                </button>
                <span className="speed-dial-label">Pinned</span>
              </>
            ) : (
              <>
                <span className="speed-dial-label">Pinned</span>
                <button className="speed-dial-btn pins" onClick={() => openPanel('pins')} title="Pinned shortcuts">
                  <Pin size={20} />
                  {pins.length > 0 && <span className="task-count-badge">{pins.length}</span>}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Task popover */}
      {active === 'tasks' && (
        <div className="task-popover" style={popoverStyle}>
          <div className="task-popover-header">
            <span className="task-popover-title">Tasks</span>
            <button className="task-popover-close" onClick={() => setActive('none')}>
              <X size={16} />
            </button>
          </div>

          <div className="task-input-row">
            <input
              ref={inputRef}
              className="task-input"
              type="text"
              placeholder="Add a task..."
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className="task-add-btn"
              onClick={handleAdd}
              disabled={!newTitle.trim() || loading}
            >
              <Plus size={16} />
            </button>
          </div>

          <div className="task-list">
            {tasks.length === 0 ? (
              <div className="task-empty">
                <div className="task-empty-icon">
                  <ClipboardList size={32} />
                </div>
                No tasks yet
              </div>
            ) : (
              tasks.map(task => (
                <div key={task.id} className="task-item">
                  <label className="task-checkbox">
                    <input
                      type="checkbox"
                      checked={task.completed}
                      onChange={() => handleToggle(task)}
                    />
                    <span className="task-checkbox-visual">
                      <Check size={12} color="white" strokeWidth={3} />
                    </span>
                  </label>
                  <span className={`task-title ${task.completed ? 'completed' : ''}`}>
                    {task.title}
                  </span>
                  <button
                    className="task-delete-btn"
                    onClick={() => handleDelete(task.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Voice popover */}
      {active === 'voice' && (
        <VoiceInputPopover
          isOpen={true}
          onClose={() => setActive('none')}
          onSend={(text) => {
            sendToTerminal(text)
            setActive('none')
          }}
          sendLabel="Send to Terminal"
          style={popoverStyle}
        />
      )}

      {/* Comments popover */}
      {active === 'comments' && (
        <CommentWidget
          projectPath={projectPath}
          onClose={() => setActive('none')}
          popoverStyle={popoverStyle}
          sessionId={sessionIdProp || getSessionIdFromUrl() || undefined}
        />
      )}

      {/* Pinned KB shortcuts popover */}
      {active === 'pins' && (
        <div className="task-popover" style={popoverStyle}>
          <div className="task-popover-header">
            <span className="task-popover-title">Pinned</span>
            <button className="task-popover-close" onClick={() => setActive('none')}>
              <X size={16} />
            </button>
          </div>

          <div className="task-list">
            {pins.length === 0 ? (
              <div className="task-empty">
                <div className="task-empty-icon">
                  <Pin size={32} />
                </div>
                No pinned entities yet.
                <br />
                Pin one from the KB detail panel.
              </div>
            ) : (
              pins.map(pin => (
                <div key={pin.entityId} className="pin-item">
                  <button
                    className="pin-item-open"
                    onClick={() => handleOpenPin(pin)}
                    title={pin.folderPath}
                  >
                    <FolderOpen size={16} className="pin-item-icon" />
                    <span className="pin-item-body">
                      <span className="pin-item-title">{pin.title}</span>
                      <span className="pin-item-meta">
                        <span className={`pin-item-type type-${pin.type}`}>{pin.type}</span>
                        <span className="pin-item-path">{pin.folderPath}</span>
                      </span>
                    </span>
                  </button>
                  <button
                    className="pin-item-unpin"
                    onClick={() => handleUnpin(pin.entityId)}
                    title="Unpin"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Copy from Terminal fullscreen modal */}
      <CopyFromTerminalModal
        open={active === 'copy-terminal'}
        onClose={() => setActive('none')}
        captureFn={captureSession}
      />

      {/* Main FAB - draggable */}
      <button
        className={`actions-fab ${active !== 'none' ? 'open' : ''} ${dragging ? 'dragging' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        title="Actions"
      >
        <span className="actions-fab-icon">
          <Plus size={24} />
        </span>
        {active === 'none' && (pendingCount + commentCount + pins.length) > 0 && (
          <span className="actions-fab-badge">{pendingCount + commentCount + pins.length}</span>
        )}
      </button>
    </div>
  )
}
