import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, X, Check, Trash2, ClipboardList, Mic, ListTodo } from 'lucide-react'
import { api, ProjectTask } from '../api/client'
import { VoiceInputPopover } from './VoiceInputPopover'
import './task-widget.css'

type ActivePanel = 'none' | 'menu' | 'tasks' | 'voice'

interface TaskWidgetProps {
  projectPath: string
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

export function TaskWidget({ projectPath }: TaskWidgetProps) {
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

  // Click outside to close
  useEffect(() => {
    if (active === 'none') return

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
        {active === 'none' && pendingCount > 0 && (
          <span className="actions-fab-badge">{pendingCount}</span>
        )}
      </button>
    </div>
  )
}
