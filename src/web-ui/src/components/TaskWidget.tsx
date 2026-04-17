import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X, Check, Trash2, ClipboardList, Mic, ListTodo, MessageSquare, Terminal, Copy as CopyIcon } from 'lucide-react'
import { AnsiUp } from 'ansi_up'
import { api, ProjectTask } from '../api/client'
import { VoiceInputPopover } from './VoiceInputPopover'
import { CommentWidget } from './CommentWidget'
import './task-widget.css'

type ActivePanel = 'none' | 'menu' | 'tasks' | 'voice' | 'comments' | 'copy-terminal'

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

// Extract sessionId from current URL path: /projects/:encodedPath/sessions/:sessionId
function getSessionIdFromUrl(): string | null {
  const match = window.location.pathname.match(/\/projects\/[^/]+\/sessions\/([^/?#]+)/)
  return match ? match[1] : null
}

/**
 * Walk a DOM tree and apply regex-based highlighting to text nodes only.
 * Modifies the tree in place — won't double-wrap text already inside an
 * existing colored span from ansi_up, because we skip element node children
 * that already contain inline style colors (they're already visually distinct).
 */
function highlightTerminalDom(root: HTMLElement): void {
  const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g
  const PATH_RE = /(?<![\w./])(\/[\w.\-/]+(?:\.[a-z0-9]+)?)(?=[\s:,;)\]"'`]|$)/gi
  const NUM_RE = /\b\d+(?:\.\d+)*\b/g
  const KEYWORD_ERR_RE = /\b(ERROR|ERR|FAIL|FAILED|WARN|WARNING|DENIED|REJECTED)\b/g
  const KEYWORD_OK_RE = /\b(SUCCESS|OK|PASS|PASSED|INFO|DEBUG|DONE|READY)\b/g
  const QUOTED_RE = /(["'`])(?:(?=(\\?))\2.)*?\1/g

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let node: Node | null
  // Collect first to avoid mutating during iteration
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text)
  }

  for (const textNode of textNodes) {
    const text = textNode.nodeValue || ''
    if (!text.trim()) continue

    // Build a list of (start, end, className, href?) replacements, prioritized
    type Hit = { start: number; end: number; className: string; href?: string }
    const hits: Hit[] = []
    const addHits = (re: RegExp, className: string, hrefFn?: (m: string) => string) => {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        hits.push({ start: m.index, end: m.index + m[0].length, className, href: hrefFn?.(m[0]) })
      }
    }
    addHits(URL_RE, 'hl-url', (u) => u)
    addHits(PATH_RE, 'hl-path')
    addHits(QUOTED_RE, 'hl-string')
    addHits(KEYWORD_ERR_RE, 'hl-keyword-error')
    addHits(KEYWORD_OK_RE, 'hl-keyword-ok')
    addHits(NUM_RE, 'hl-number')

    if (hits.length === 0) continue

    // Resolve overlaps — keep the earliest, longest match
    hits.sort((a, b) => a.start - b.start || b.end - a.end)
    const merged: Hit[] = []
    for (const h of hits) {
      const last = merged[merged.length - 1]
      if (!last || h.start >= last.end) merged.push(h)
    }

    // Replace the text node with a fragment containing highlighted spans
    const frag = document.createDocumentFragment()
    let cursor = 0
    for (const h of merged) {
      if (h.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, h.start)))
      let el: HTMLElement
      if (h.href) {
        const a = document.createElement('a')
        a.href = h.href
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        a.className = h.className
        el = a
      } else {
        el = document.createElement('span')
        el.className = h.className
      }
      el.textContent = text.slice(h.start, h.end)
      frag.appendChild(el)
      cursor = h.end
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)))
    textNode.parentNode?.replaceChild(frag, textNode)
  }
}

export function TaskWidget({ projectPath }: TaskWidgetProps) {
  const [active, setActive] = useState<ActivePanel>('none')
  const [tasks, setTasks] = useState<ProjectTask[]>([])
  const [newTitle, setNewTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [terminalAvailable, setTerminalAvailable] = useState(false)
  const [position, setPosition] = useState<FabPosition>(() => loadPosition() || getDefaultPosition())
  const [dragging, setDragging] = useState(false)
  const [terminalCapture, setTerminalCapture] = useState<string>('')
  const [terminalCaptureHtml, setTerminalCaptureHtml] = useState<string>('')
  const [capturing, setCapturing] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const copyTerminalBodyRef = useRef<HTMLDivElement>(null)
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

  // Auto-scroll the copy-terminal modal to the bottom when content loads
  // and apply syntax-like highlighting (URLs, paths, numbers, keywords, strings)
  // (terminal prompt / most recent output is at the end — user wants to see that first)
  useEffect(() => {
    if (active === 'copy-terminal' && !capturing) {
      const body = copyTerminalBodyRef.current
      if (body) {
        requestAnimationFrame(() => {
          // Apply extra highlighting on top of ansi_up's colors
          const pre = body.querySelector('pre.copy-terminal-pre') as HTMLElement | null
          if (pre) {
            try { highlightTerminalDom(pre) } catch {}
          }
          body.scrollTop = body.scrollHeight
        })
      }
    }
  }, [active, capturing, terminalCapture, terminalCaptureHtml])

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
      openCopyTerminal()
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

  const openCopyTerminal = async () => {
    setActive('copy-terminal')
    setCapturing(true)
    setTerminalCapture('')
    setTerminalCaptureHtml('')
    setCopyFeedback(false)
    try {
      const sessionId = getSessionIdFromUrl()
      if (!sessionId) {
        setTerminalCapture('(No active session found in URL)')
        return
      }
      // Fetch both plain (for clipboard) and ANSI-colored (for display) versions
      const [plainRes, ansiRes] = await Promise.all([
        api.captureTerminalPane(projectPath, sessionId, { lines: 400 }),
        api.captureTerminalPane(projectPath, sessionId, { lines: 400, ansi: true }),
      ])

      let plain = plainRes.text.replace(/\n+$/, '')
      if (plain.length > 5000) plain = '…' + plain.slice(-5000)
      setTerminalCapture(plain)

      try {
        const converter = new AnsiUp()
        ;(converter as any).use_classes = false
        const html = converter.ansi_to_html(ansiRes.text || '')
        setTerminalCaptureHtml(html)
      } catch {
        setTerminalCaptureHtml('')
      }
    } catch (err: any) {
      setTerminalCapture(`(Failed to capture terminal: ${err.message || err})`)
    } finally {
      setCapturing(false)
    }
  }

  const handleCopyTerminalText = async () => {
    if (!terminalCapture) return
    try {
      await navigator.clipboard.writeText(terminalCapture)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = terminalCapture
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopyFeedback(true)
    setTimeout(() => setCopyFeedback(false), 1500)
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
                  <button className="speed-dial-btn copy-terminal" onClick={openCopyTerminal} title="Copy from Terminal">
                    <Terminal size={20} />
                  </button>
                  <span className="speed-dial-label">Copy Terminal</span>
                </>
              ) : (
                <>
                  <span className="speed-dial-label">Copy Terminal</span>
                  <button className="speed-dial-btn copy-terminal" onClick={openCopyTerminal} title="Copy from Terminal">
                    <Terminal size={20} />
                  </button>
                </>
              )}
            </div>
          )}
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
        />
      )}

      {/* Copy from Terminal fullscreen modal — rendered via portal to escape
          ancestor stacking contexts (the FAB container has position:fixed which
          creates its own context, trapping child z-indexes). */}
      {active === 'copy-terminal' && createPortal(
        <div
          className="copy-terminal-overlay"
          onMouseDown={(e) => {
            // Only close when the mousedown (not just mouseup) happened on the overlay.
            // This prevents closing when the user drags-to-select text starting inside
            // the modal and releases the mouse over the overlay.
            if (e.target === e.currentTarget) setActive('none')
          }}
        >
          <div className="copy-terminal-modal" onClick={e => e.stopPropagation()}>
            <div className="copy-terminal-modal-header">
              <span className="copy-terminal-modal-title">
                <Terminal size={18} />
                Terminal capture
                {terminalCapture && <span className="copy-terminal-chars">{terminalCapture.length} chars</span>}
              </span>
              <div className="copy-terminal-modal-actions">
                <button
                  className={`copy-terminal-btn-primary ${copyFeedback ? 'success' : ''}`}
                  disabled={!terminalCapture || capturing}
                  onClick={handleCopyTerminalText}
                >
                  {copyFeedback ? (<><Check size={14} /> Copied</>) : (<><CopyIcon size={14} /> Copy all</>)}
                </button>
                <button className="copy-terminal-btn-close" onClick={() => setActive('none')} title="Close">
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="copy-terminal-modal-body" ref={copyTerminalBodyRef}>
              {capturing ? (
                <div className="copy-terminal-loading-fs">
                  <div className="spinner" />
                  <span>Capturing terminal…</span>
                </div>
              ) : terminalCaptureHtml ? (
                <pre
                  className="copy-terminal-pre"
                  dangerouslySetInnerHTML={{ __html: terminalCaptureHtml }}
                />
              ) : (
                <pre className="copy-terminal-pre">{terminalCapture}</pre>
              )}
            </div>
            <div className="copy-terminal-modal-footer">
              <span className="copy-terminal-hint-fs">
                Select any text and Cmd+C to copy, or use "Copy all" to grab everything
              </span>
            </div>
          </div>
        </div>,
        document.body
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
        {active === 'none' && (pendingCount + commentCount) > 0 && (
          <span className="actions-fab-badge">{pendingCount + commentCount}</span>
        )}
      </button>
    </div>
  )
}
