import { useCallback, useEffect, useRef, useState } from 'react'
import {
  X,
  Terminal,
  ExternalLink,
  Play,
  Package,
  RotateCw,
  RefreshCw,
  AlertTriangle,
  Info,
  PanelLeftClose,
  PanelLeftOpen,
  History,
  FileText,
  FolderOpen,
  Link as LinkIcon,
} from 'lucide-react'
import { api, type AIQueryContext, type BoardTask } from '../../api/client'
import { TaskWidget } from '../TaskWidget'
import { QuickAIDialogWrapper } from '../../App'
import { encodeProjectPath } from '../ProjectDashboard'

/** Same set the KB detail panel uses so both surfaces render identical
 *  Quick Access links from an entity's properties. Keep the priority
 *  order matching (`master_doc` first). */
const PATH_PROPERTIES = ['master_doc', 'path', 'notes_path', 'profile_path', 'source_path', 'repo_path', 'filePath']

/**
 * Fullscreen board task panel.
 *
 * Layout:
 *   ┌ Header — key/title/jira link · [Start · Restart · Close]           ┐
 *   ├─────────────────────────────────┬───────────────────────────────── ┤
 *   │ Info panel (collapsible on desk-│ Terminal panel — iframes the      │
 *   │ top; tabbed on mobile). Shows   │ same mobile-terminal HTML page    │
 *   │ description, meta, KB link,     │ the launcher uses so the user     │
 *   │ branch/worktree.                │ gets the custom keyboard + quick  │
 *   │                                 │ actions "for free".               │
 *   └─────────────────────────────────┴───────────────────────────────── ┘
 *   + TaskWidget FAB (Tasks / Comments / Pins / Copy-terminal / Voice)
 *   + Cmd+K QuickAI dialog scoped to this pane
 *
 * Recovery flow: on mount we call `resumeBoardTask`. Alive → refresh the
 * parent so the modal's `task` prop carries the live handles. Dead → show
 * the "Restart terminal" banner + button. No-handles → task never had a
 * terminal; user can Start it.
 */
interface Props {
  projectPath: string
  boardId: string
  task: BoardTask
  columns: string[]
  /** Move the task to a new column. Parent decides whether that means
   *  spawn-a-terminal (→ in-progress), send-close-prompt (in-progress →
   *  done/review), or a plain status update — same routing as the
   *  drag & drop handler on the Kanban, so touch users get feature parity
   *  through the selector. */
  onMoveTask: (task: BoardTask, newStatus: string) => void | Promise<void>
  onClose: () => void
  onChanged: () => void | Promise<void>
}

type ResumeState = 'idle' | 'checking' | 'alive' | 'dead' | 'no-handles'
type MobileTab = 'terminal' | 'info'

function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(max-width: 768px)').matches
}

/**
 * Exit-animation duration in ms. Kept in sync with the `.board-task-modal.exiting`
 * animation length in `board.css`. If you change one, change both.
 */
const EXIT_MS = 200

export function BoardTaskModal({ projectPath, boardId, task, columns, onMoveTask, onClose, onChanged }: Props) {
  const [starting, setStarting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [resumeState, setResumeState] = useState<ResumeState>('idle')
  const [infoCollapsed, setInfoCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('orka-board-task-info-collapsed') === '1'
  })
  const [mobileTab, setMobileTab] = useState<MobileTab>('terminal')
  const [isMobile, setIsMobile] = useState(isMobileViewport())
  const resumedForKeyRef = useRef<string | null>(null)

  // Two-phase close: user clicks X (or presses Esc) → we set `exiting`
  // which triggers the exit CSS animation, then after the animation
  // finishes we call the parent's `onClose` so the modal unmounts. This
  // keeps React from ripping the node out mid-animation.
  const [exiting, setExiting] = useState(false)
  const exitTimerRef = useRef<number | null>(null)
  const startClose = useCallback(() => {
    if (exiting) return
    setExiting(true)
    exitTimerRef.current = window.setTimeout(() => {
      onClose()
    }, EXIT_MS)
  }, [exiting, onClose])

  useEffect(() => () => {
    if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current)
  }, [])

  // Track viewport so switching desktop/mobile via devtools rotate does
  // not orphan the layout mode.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const onChange = () => setIsMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Pull the linked KB entity so we can render the same Quick Access
  // links (folder + overview.html) the KB detail panel shows. Re-fetches
  // whenever the task's linked entity changes.
  const [kbEntity, setKbEntity] = useState<{ properties?: Record<string, unknown>; title?: string; type?: string } | null>(null)
  useEffect(() => {
    if (!task.kbEntityId) { setKbEntity(null); return }
    let cancelled = false
    api.getKBEntity(projectPath, task.kbEntityId)
      .then((e) => { if (!cancelled) setKbEntity(e as any) })
      .catch(() => { if (!cancelled) setKbEntity(null) })
    return () => { cancelled = true }
  }, [projectPath, task.kbEntityId])

  const encodedProject = encodeProjectPath(projectPath)

  const openFilePath = (filePath: string) => {
    const clean = filePath.replace(/^\/+/, '')
    const isFile = /\.\w+$/.test(clean)
    // HTML files open through the direct `/api/files/preview/:enc/*path`
    // endpoint so relative assets (<link>, <img>, <script>) resolve
    // against the file's own URL — needed for a self-contained
    // overview.html that references its neighbors. Other files stay on
    // the FileViewer SPA route (Markdown, images, code) which wraps them
    // in the app chrome.
    const isHtml = /\.html?$/i.test(clean)
    let target: string
    if (isHtml) {
      const pathSegments = clean.split('/').map((s) => encodeURIComponent(s)).join('/')
      target = `/api/files/preview/${encodedProject}/${pathSegments}?comments=1`
    } else if (isFile) {
      target = `/projects/${encodedProject}/files/view?path=${encodeURIComponent(clean)}`
    } else {
      target = `/projects/${encodedProject}/files?path=${encodeURIComponent(clean)}`
    }
    window.open(target, '_blank')
  }

  const kbLinks = (() => {
    const props = kbEntity?.properties
    if (!props) return [] as Array<{ key: string; path: string; isFile: boolean }>
    const out: Array<{ key: string; path: string; isFile: boolean }> = []
    for (const key of PATH_PROPERTIES) {
      const raw = props[key]
      if (typeof raw !== 'string' || !raw.trim()) continue
      const clean = raw.trim().replace(/^\/+/, '')
      out.push({ key, path: clean, isFile: /\.\w+$/.test(clean) })
    }
    return out
  })()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') startClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [startClose])

  useEffect(() => {
    localStorage.setItem('orka-board-task-info-collapsed', infoCollapsed ? '1' : '0')
  }, [infoCollapsed])

  // Auto-resume the terminal for this task once per opened key.
  useEffect(() => {
    if (!task.terminalTmuxSessionId) {
      setResumeState('no-handles')
      return
    }
    if (resumedForKeyRef.current === task.key) return
    resumedForKeyRef.current = task.key
    setResumeState('checking')
    let cancelled = false
    void (async () => {
      try {
        const r = await api.resumeBoardTask(projectPath, boardId, task.key)
        if (cancelled) return
        setResumeState(r.status)
        if (r.status === 'alive' || r.status === 'dead') await onChanged()
      } catch {
        if (!cancelled) setResumeState('dead')
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.key])

  const handleStart = async () => {
    if (starting) return
    setStarting(true)
    try {
      await api.startBoardTask(projectPath, boardId, task.key, 'full')
      resumedForKeyRef.current = null
      await onChanged()
    } catch (err) {
      console.error(err)
    } finally {
      setStarting(false)
    }
  }

  const handleWrapUp = async () => {
    if (busy) return
    const ok = window.confirm(
      `Wrap up ${task.key}?\n\n` +
      `This will send the close-template prompt to Claude, which will:\n` +
      `  • Push the branch and open a Pull Request\n` +
      `  • Comment on the Jira ticket with the PR link\n` +
      `  • Move the Jira ticket to Done\n` +
      `  • Mark the KB entity as done\n` +
      `  • (Optionally) remove the worktree\n\n` +
      `Continue?`
    )
    if (!ok) return
    setBusy(true)
    try {
      await api.wrapUpBoardTask(projectPath, boardId, task.key, {
        template: 'close-default',
        status: 'done',
        terminal: 'keep',
      })
      await onChanged()
    } catch (err) {
      console.error(err)
    } finally {
      setBusy(false)
    }
  }

  const [reiniting, setReiniting] = useState(false)
  const handleReinit = async () => {
    if (reiniting) return
    const ok = window.confirm(
      `Restart init prompt for ${task.key}?\n\n` +
      `This re-sends the init template to Claude in the same terminal. ` +
      `Use it after updating a skill or an init template — Claude picks ` +
      `up the fresh instructions without losing the current context.\n\n` +
      `(This does NOT restart the terminal, does NOT push code, does NOT ` +
      `touch Jira.)`
    )
    if (!ok) return
    setReiniting(true)
    try {
      await api.reinitBoardTask(projectPath, boardId, task.key, 'full')
    } catch (err) {
      console.error(err)
    } finally {
      setReiniting(false)
    }
  }

  // Context supplier for the Cmd+K QuickAI dialog — same shape as the
  // launcher's desktop session modal. Provides the tmux pane id so
  // "explain what I'm looking at" works against the task terminal.
  const getContext = useCallback(async (): Promise<Omit<AIQueryContext, 'type'>> => {
    const base: Omit<AIQueryContext, 'type'> = { projectPath }
    if (task.terminalPaneId) return { ...base, terminalPaneId: task.terminalPaneId }
    return base
  }, [projectPath, task.terminalPaneId])

  const isRunning = !!task.ttydPort && resumeState !== 'dead' && resumeState !== 'checking'
  const showRestart = resumeState === 'dead'
  // "Reopen" applies when the task is currently in a terminal column
  // (done / review / any column that isn't in-progress) AND we have a
  // Claude session id to resume — either because the user closed it
  // via Kanban / the modal, or because the previous close ritual
  // finished cleanly and stored the id. Provides a single-click path
  // back to work without dragging.
  const canReopen = task.status !== 'in-progress' && !!task.claudeSessionId
  const [busyMove, setBusyMove] = useState(false)

  const handleStatusChange = async (nextStatus: string) => {
    if (busyMove || nextStatus === task.status) return
    setBusyMove(true)
    try {
      // Reset the resume gate so the next mount re-checks with the
      // handles the move endpoint just persisted.
      resumedForKeyRef.current = null
      await onMoveTask(task, nextStatus)
    } finally {
      setBusyMove(false)
    }
  }
  // Use the same custom mobile-terminal HTML page the launcher iframes,
  // so we inherit the virtual keyboard + quick actions. `?desktop=1`
  // flips it to the desktop xterm layout when we're not on mobile.
  const terminalSuffix = isMobile ? '' : '?desktop=1'
  const terminalQuery = terminalSuffix
    ? `${terminalSuffix}&project=${btoa(projectPath)}&session=${encodeURIComponent(task.key)}`
    : `?project=${btoa(projectPath)}&session=${encodeURIComponent(task.key)}`
  const terminalUrl = task.ttydPort ? `/terminal/${task.ttydPort}${terminalQuery}` : null

  const infoPanel = (
    <div className="board-task-info-panel">
      <div className="board-task-info-title">Task details</div>
      <div className="board-task-meta">
        {task.assignee && <span>@{task.assignee}</span>}
        {task.priority && <span>· {task.priority}</span>}
        {resumeState === 'checking' && <span className="board-task-meta-loading">· checking terminal…</span>}
      </div>

      <dl className="board-task-details-grid">
        <dt>Jira</dt>
        <dd><a href={task.jiraUrl} target="_blank" rel="noreferrer">{task.jiraUrl}</a></dd>
        {task.branchName && (<><dt>Branch</dt><dd><code>{task.branchName}</code></dd></>)}
        {task.worktreePath && (<><dt>Worktree</dt><dd><code>{task.worktreePath}</code></dd></>)}
        {task.kbEntityId && (<><dt>KB entity</dt><dd><code>{task.kbEntityId}</code></dd></>)}
        {task.labels && task.labels.length > 0 && (
          <><dt>Labels</dt><dd>{task.labels.join(', ')}</dd></>
        )}
        <dt>Status</dt><dd>{task.status}</dd>
        <dt>Created</dt><dd>{new Date(task.createdAt).toLocaleString()}</dd>
        <dt>Updated</dt><dd>{new Date(task.updatedAt).toLocaleString()}</dd>
      </dl>

      {/* Quick Access — same idea as the KB detail panel: surface any
          folder / master_doc / notes properties on the linked KB entity
          as one-click file-viewer / finder links so the developer never
          has to hunt for the overview.html or the docs folder. */}
      {kbLinks.length > 0 && (
        <>
          <div className="board-task-info-section-label">Quick access</div>
          <div className="board-task-links">
            {kbLinks.map((l) => (
              <button
                key={l.key}
                className="board-task-link"
                onClick={() => openFilePath(l.path)}
                title={l.path}
              >
                {l.isFile ? <FileText size={14} /> : <FolderOpen size={14} />}
                <span className="board-task-link-label">
                  {labelForPathKey(l.key)}
                </span>
                <span className="board-task-link-path">{l.path}</span>
                <LinkIcon size={11} className="board-task-link-arrow" />
              </button>
            ))}
          </div>
        </>
      )}

      {task.description ? (
        <>
          <div className="board-task-info-section-label">Description</div>
          <pre className="board-task-description">{task.description}</pre>
        </>
      ) : (
        <div className="board-task-description-empty">No description.</div>
      )}
    </div>
  )

  const terminalPanel = (
    <div className="board-task-terminal-panel">
      {terminalUrl && isRunning ? (
        <>
          <div className="board-task-terminal-toolbar">
            <span><Terminal size={12} /> Terminal</span>
            <button
              onClick={() => window.open(`/terminal/${task.ttydPort}?desktop=1`, '_blank')}
              title="Open in new tab"
            >
              <ExternalLink size={12} />
            </button>
          </div>
          {/* `terminal-iframe` compound class + `data-orka-session-id`
              let the shared CommentWidget target this iframe when the
              user hits Apply / Apply All from the FAB inside the modal.
              See CommentWidget.sendToTerminal for the resolution. */}
          <iframe
            src={terminalUrl}
            title={`${task.key} terminal`}
            className="board-task-iframe terminal-iframe"
            data-orka-session-id={task.key}
            allow="clipboard-read; clipboard-write; microphone"
          />
        </>
      ) : showRestart ? (
        <div className="board-task-dead">
          <AlertTriangle size={20} />
          <div>
            <strong>Terminal expired</strong>
            <p>The tmux session for this task no longer exists (it was killed externally, or a hard restart cleared it). Restart it above to spawn a fresh Claude session.</p>
          </div>
        </div>
      ) : resumeState === 'checking' ? (
        <div className="board-task-empty-panel">Checking terminal…</div>
      ) : (
        <div className="board-task-empty-panel">
          <Terminal size={22} />
          <p>No terminal yet. Move the task to In Progress or press Start to spawn one.</p>
        </div>
      )}
    </div>
  )

  return (
    <div
      className={`board-task-modal ${exiting ? 'exiting' : 'entering'}`}
      role="dialog"
      aria-modal="true"
    >
      <header className="board-task-header">
        <button className="board-task-close" onClick={startClose} aria-label="Close">
          <X size={16} />
        </button>
        <div className="board-task-title-block">
          <span className="board-task-key">{task.key}</span>
          <h2>{task.title}</h2>
          <a href={task.jiraUrl} target="_blank" rel="noreferrer" className="board-task-jira">
            {task.jiraUrl}
          </a>
        </div>
        <div className="board-task-actions">
          {!isMobile && !showRestart && (
            <button
              className="board-task-btn ghost"
              onClick={() => setInfoCollapsed((v) => !v)}
              title={infoCollapsed ? 'Show info panel' : 'Hide info panel'}
            >
              {infoCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
            </button>
          )}
          {/* Reopen — prominent when the task is closed but has stored
              Claude session; hitting this resumes the prior conversation
              in place (keeps the current column). If the user wants to
              also escalate the card back to In Progress, they can drag
              it or use the status selector — the modal Reopen never
              moves cards on its own. */}
          {canReopen && !isRunning && (
            <button
              className="board-task-btn primary"
              onClick={handleStart}
              disabled={starting}
              title="Reopen: resume the previous Claude session (does NOT change column)"
              aria-label={starting ? 'Reopening' : 'Reopen'}
            >
              <History size={14} className={starting ? 'spinning' : ''} />
              <span className="mobile-hide">{starting ? 'Reopening…' : 'Reopen'}</span>
            </button>
          )}
          {/* Start — for tasks that never had a terminal (no claudeSessionId
              and not currently running). Same fresh-init path as dragging
              a To Do card into In Progress. */}
          {!isRunning && !showRestart && !canReopen && (
            <button
              className="board-task-btn primary"
              onClick={handleStart}
              disabled={starting || resumeState === 'checking'}
              title="Move to In Progress + spawn terminal"
              aria-label={starting ? 'Starting' : 'Start'}
            >
              <Play size={14} />
              <span className="mobile-hide">{starting ? 'Starting…' : 'Start'}</span>
            </button>
          )}
          {showRestart && (
            <button
              className="board-task-btn primary"
              onClick={handleStart}
              disabled={starting}
              title="Terminal died — spawn a fresh one"
              aria-label={starting ? 'Restarting terminal' : 'Restart terminal'}
            >
              <RotateCw size={14} className={starting ? 'spinning' : ''} />
              <span className="mobile-hide">{starting ? 'Restarting…' : 'Restart terminal'}</span>
            </button>
          )}
          {isRunning && (
            <>
              <button
                className="board-task-btn"
                onClick={handleReinit}
                disabled={reiniting}
                title="Re-send the init prompt to Claude (picks up updated skills / template without losing context)"
                aria-label={reiniting ? 'Restarting init' : 'Restart init'}
              >
                <RefreshCw size={14} className={reiniting ? 'spinning' : ''} />
                <span className="mobile-hide">{reiniting ? 'Restarting…' : 'Restart init'}</span>
              </button>
              <button
                className="board-task-btn warning"
                onClick={handleWrapUp}
                disabled={busy}
                title="Wrap up: push branch, open PR, comment on Jira, mark KB done, transition Jira → Done"
                aria-label={busy ? 'Wrapping up' : 'Wrap up'}
              >
                <Package size={14} />
                <span className="mobile-hide">{busy ? 'Wrapping up…' : 'Wrap up'}</span>
              </button>
            </>
          )}
          {/* Status selector — always visible so touch users can move a
              task between columns without drag & drop. Same three-branch
              routing as the Kanban drag handler via `onMoveTask`. */}
          <select
            className="board-task-status-select"
            value={task.status}
            onChange={(e) => void handleStatusChange(e.target.value)}
            disabled={busyMove || starting || busy}
            aria-label="Move to column"
            title="Move to another column"
          >
            {columns.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </header>

      {/* Mobile tab switcher — desktop uses the split view below. */}
      {isMobile && (
        <div className="board-task-tabs">
          <button
            className={`board-task-tab ${mobileTab === 'terminal' ? 'active' : ''}`}
            onClick={() => setMobileTab('terminal')}
          >
            <Terminal size={13} /> Terminal
          </button>
          <button
            className={`board-task-tab ${mobileTab === 'info' ? 'active' : ''}`}
            onClick={() => setMobileTab('info')}
          >
            <Info size={13} /> Info
          </button>
        </div>
      )}

      <div className={`board-task-body split ${infoCollapsed ? 'info-collapsed' : ''}`}>
        {isMobile ? (
          mobileTab === 'terminal' ? terminalPanel : infoPanel
        ) : (
          <>
            {!infoCollapsed && infoPanel}
            {terminalPanel}
          </>
        )}
      </div>

      {/* Per-task shortcuts + FAB. Same components the launcher's desktop
          session modal mounts so Cmd+K / Cmd+L / voice / pins all work
          exactly like inside a Classic session. */}
      <TaskWidget
        projectPath={projectPath}
        sessionId={task.key}
        boardContext={{ boardId, taskKey: task.key }}
      />
      <QuickAIDialogWrapper
        contextType="terminal"
        contextLabel="Task Terminal"
        getContext={getContext}
      />
    </div>
  )
}

/** Friendly Spanish label for a path property key — same wording the KB
 *  detail panel uses so both surfaces read alike. */
function labelForPathKey(key: string): string {
  switch (key) {
    case 'master_doc': return 'Documento principal'
    case 'path': return 'Carpeta'
    case 'notes_path': return 'Notas'
    case 'profile_path': return 'Perfil'
    case 'source_path': return 'Fuente'
    case 'repo_path': return 'Repositorio'
    case 'filePath': return 'Archivo'
    default: return key
  }
}
