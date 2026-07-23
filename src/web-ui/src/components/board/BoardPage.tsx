import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  RefreshCw,
  Settings,
  AlertTriangle,
  Terminal,
  X,
  LayoutGrid,
  Code,
  FolderOpen,
  Network,
  Maximize2,
  Minimize2,
  ExternalLink,
} from 'lucide-react'
import {
  api,
  type BoardConfig,
  type BoardTask,
  type BoardDrift,
} from '../../api/client'
import { decodeProjectPath } from '../ProjectDashboard'
import { BoardKanban } from './BoardKanban'
import { BoardTaskModal } from './BoardTaskModal'
import { SessionCodeEditor } from '../code-editor'
import { FinderExplorer } from '../finder'
import { KBGraph } from '../kb'
import '../../styles/board.css'

/** Tab identifiers for the board's main content area. Kanban is the
 *  default; the other four mirror the SessionView layout (Master
 *  Terminal in place of Claude Code, then Code / Files / Knowledge). */
type BoardTab = 'kanban' | 'terminal' | 'code' | 'files' | 'kb'

/**
 * `/projects/:encodedPath/boards/:boardId` — one page per Board.
 *
 * Layout:
 *   ┌ Header (name, sync, settings, back)                     ┐
 *   │ Kanban (fills area, scrolls columns horizontally)        │
 *   │ Drift banner (collapsible, per-task badges live in card) │
 *   ├ Master drawer (collapsible bottom bar with the master    │
 *   │  session embedded — user pulls it up to see sync output) ┤
 *   └ Task modal (fullscreen, opens when a card is tapped)     ┘
 *
 * All state fetching flows through the API — no local persistence beyond
 * the drawer's expand state (localStorage) and the currently-open task
 * modal (component state).
 */
export function BoardPage() {
  const navigate = useNavigate()
  const { encodedPath = '', boardId = '' } = useParams()
  const projectPath = useMemo(() => decodeProjectPath(encodedPath), [encodedPath])

  const [board, setBoard] = useState<BoardConfig | null>(null)
  const [tasks, setTasks] = useState<BoardTask[]>([])
  const [drifts, setDrifts] = useState<BoardDrift[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [masterPort, setMasterPort] = useState<number | null>(null)
  const [openTaskKey, setOpenTaskKey] = useState<string | null>(null)
  // Active content tab. Persisted per-board so the user's last view is
  // restored on refresh / re-entry.
  const [tab, setTab] = useState<BoardTab>(() => {
    const raw = localStorage.getItem(`orka-board-tab:${boardId}`)
    if (raw === 'terminal' || raw === 'code' || raw === 'files' || raw === 'kb') return raw
    return 'kanban'
  })
  useEffect(() => {
    localStorage.setItem(`orka-board-tab:${boardId}`, tab)
  }, [tab, boardId])

  // Fullscreen mode for the terminal tab — hides the app header / tab
  // bar so the master gets the whole viewport. Useful during a heavy
  // sync when the user wants to watch Claude scroll.
  const [terminalFullscreen, setTerminalFullscreen] = useState(false)
  useEffect(() => {
    if (!terminalFullscreen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTerminalFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [terminalFullscreen])

  const load = useCallback(async () => {
    try {
      const [cfg, ts, ds] = await Promise.all([
        api.getBoard(projectPath, boardId),
        api.listBoardTasks(projectPath, boardId),
        api.listBoardDrifts(projectPath, boardId),
      ])
      setBoard(cfg)
      setTasks(ts)
      setDrifts(ds)
      setLoading(false)
    } catch (err: any) {
      setError(err?.message || 'Failed to load board')
      setLoading(false)
    }
  }, [projectPath, boardId])

  useEffect(() => {
    void load()
    const interval = setInterval(() => { void load() }, 4000)
    return () => clearInterval(interval)
  }, [load])

  // Boot the master lazily — the first time the user enters this board
  // page, we make sure the tmux+ttyd+claude are up. Idempotent server-side.
  useEffect(() => {
    let alive = true
    api.startBoardMaster(projectPath, boardId)
      .then((h) => { if (alive) setMasterPort(h.ttydPort) })
      .catch((e) => { if (alive) console.warn('Master start failed:', e) })
    return () => { alive = false }
  }, [projectPath, boardId])

  // Sweep: after the first tasks fetch, walk every task that has
  // stored terminal handles and ask the server to revive it. Runs once
  // per navigation to this page so refreshing after an `orka restart`
  // brings all in-progress terminals back to life without the user
  // having to click each one. Silent per-task failures — we only need
  // a best-effort recovery.
  const sweptRef = useRef(false)
  useEffect(() => {
    if (sweptRef.current || tasks.length === 0) return
    sweptRef.current = true
    const withHandles = tasks.filter((t) => !!t.terminalTmuxSessionId)
    if (withHandles.length === 0) return
    void (async () => {
      for (const t of withHandles) {
        try { await api.resumeBoardTask(projectPath, boardId, t.key) } catch { /* ignore */ }
      }
      void load()
    })()
  }, [tasks, projectPath, boardId, load])

  const handleSync = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      await api.syncBoardMaster(projectPath, boardId)
      // Jump to the Terminal tab so the user sees Claude executing the
      // sync ritual in real time.
      setTab('terminal')
    } catch (err: any) {
      setError(err?.message || 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  const handleMoveTask = async (task: BoardTask, newStatus: string) => {
    if (task.status === newStatus) return
    try {
      // Moving INTO in-progress: spawn (or resume) the task terminal
      // AND change status — pass `changeStatusTo: 'in-progress'` so the
      // server does both in one call. This is the Kanban drag path.
      // Any other transition — including moving OUT of in-progress into
      // done/review — is a SILENT status change. The full wrap-up
      // ritual (PR / Jira / KB / worktree) is opt-in via the modal's
      // explicit "Wrap up" button so an accidental drag can't fire it.
      if (newStatus === 'in-progress' && task.status !== 'in-progress') {
        await api.startBoardTask(projectPath, boardId, task.key, 'full', 'in-progress')
      } else {
        await api.updateBoardTask(projectPath, boardId, task.key, { status: newStatus })
      }
      await load()
    } catch (err: any) {
      setError(err?.message || 'Failed to move task')
    }
  }

  const handleAckDrift = async (taskKey: string) => {
    try {
      await api.ackBoardDrift(projectPath, boardId, taskKey)
      await load()
    } catch (err: any) {
      setError(err?.message || 'Failed to ack drift')
    }
  }

  if (loading) {
    return (
      <div className="board-page loading">
        <div className="spinner"></div>
        <p>Loading board…</p>
      </div>
    )
  }

  if (!board) {
    return (
      <div className="board-page loading">
        <p>Board not found.</p>
        <button className="button-secondary" onClick={() => navigate(-1)}>Back</button>
      </div>
    )
  }

  const driftByKey = new Map(drifts.map((d) => [d.taskKey, d]))

  const tabDefs: Array<{ id: BoardTab; label: string; icon: React.ReactNode }> = [
    { id: 'kanban', label: 'Board', icon: <LayoutGrid size={14} /> },
    { id: 'terminal', label: 'Master', icon: <Terminal size={14} /> },
    { id: 'code', label: 'Code', icon: <Code size={14} /> },
    { id: 'files', label: 'Files', icon: <FolderOpen size={14} /> },
    { id: 'kb', label: 'Knowledge', icon: <Network size={14} /> },
  ]

  // Terminal fullscreen renders as an overlay so header + tab bar go
  // away and the iframe takes 100vh. Same close pattern (X top-left).
  if (terminalFullscreen && masterPort) {
    return (
      <div className="board-terminal-fullscreen" role="dialog" aria-modal="true">
        <button
          className="orka-close-btn board-terminal-fullscreen-close"
          onClick={() => setTerminalFullscreen(false)}
          aria-label="Exit fullscreen (Esc)"
          title="Exit fullscreen (Esc)"
        >
          <Minimize2 size={16} />
        </button>
        <iframe
          src={`/terminal/${masterPort}?desktop=1`}
          title="Master Terminal (fullscreen)"
          className="board-terminal-iframe terminal-iframe"
          data-orka-session-id={`board-master-${boardId}`}
          allow="clipboard-read; clipboard-write; microphone"
        />
      </div>
    )
  }

  return (
    <div className="board-page">
      <header className="board-header">
        {/* Unified close pattern — X icon top-left, same shape and
            position as every other fullscreen surface in the app. */}
        <button
          className="orka-close-btn"
          onClick={() => navigate(`/projects/${encodedPath}`)}
          aria-label="Close board"
          title="Close (Esc)"
        >
          <X size={16} />
        </button>
        <div className="board-header-title">
          <h1>{board.name}</h1>
          <a className="board-header-jira" href={board.jiraUrl} target="_blank" rel="noreferrer">
            {board.jiraUrl}
          </a>
        </div>
        <div className="board-header-actions">
          <button
            className="board-header-btn"
            onClick={handleSync}
            disabled={syncing}
            title="Ask the master to sync from Jira"
          >
            <RefreshCw size={14} className={syncing ? 'spinning' : ''} />
            <span>Sync</span>
          </button>
          <button
            className="board-header-btn"
            onClick={() => navigate(`/projects/${encodedPath}/boards/${boardId}/settings`)}
            title="Board settings"
          >
            <Settings size={14} />
          </button>
        </div>
      </header>

      {/* Tab bar — same visual language as SessionView's right-panel
          tabs, so the muscle memory carries over. */}
      <nav className="board-tabs" role="tablist">
        {tabDefs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`board-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {error && (
        <div className="board-error-banner">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {/* Content — each tab is kept mounted while `hidden` so state
          (scroll positions, iframe sessions) doesn't reset on tab
          switch. The KB graph is heavy so we only mount it on demand. */}
      <div className="board-tab-content">
        <div className={`board-tab-panel ${tab === 'kanban' ? 'visible' : 'hidden'}`}>
          <BoardKanban
            columns={board.columns}
            tasks={tasks}
            driftByKey={driftByKey}
            onOpenTask={(t) => setOpenTaskKey(t.key)}
            onMoveTask={handleMoveTask}
            onAckDrift={handleAckDrift}
          />
        </div>

        <div className={`board-tab-panel ${tab === 'terminal' ? 'visible' : 'hidden'}`}>
          {masterPort ? (
            <div className="board-terminal-panel">
              <div className="board-terminal-toolbar">
                <span className="board-terminal-toolbar-label">
                  <Terminal size={12} /> Master Terminal
                  <span
                    className={`board-master-dot ${masterPort ? 'running' : 'idle'}`}
                    title={masterPort ? 'Running' : 'Idle'}
                  />
                </span>
                <div className="board-terminal-toolbar-actions">
                  <button
                    className="board-terminal-toolbar-btn"
                    onClick={() => setTerminalFullscreen(true)}
                    title="Fullscreen (Esc to exit)"
                    aria-label="Fullscreen"
                  >
                    <Maximize2 size={12} />
                  </button>
                  <button
                    className="board-terminal-toolbar-btn"
                    onClick={() => window.open(`/terminal/${masterPort}?desktop=1`, '_blank')}
                    title="Open in new tab"
                    aria-label="Open in new tab"
                  >
                    <ExternalLink size={12} />
                  </button>
                </div>
              </div>
              <iframe
                src={`/terminal/${masterPort}?desktop=1`}
                title="Board Master Terminal"
                className="board-terminal-iframe terminal-iframe"
                data-orka-session-id={`board-master-${boardId}`}
                allow="clipboard-read; clipboard-write; microphone"
              />
            </div>
          ) : (
            <div className="board-tab-empty">Starting master terminal…</div>
          )}
        </div>

        <div className={`board-tab-panel ${tab === 'code' ? 'visible' : 'hidden'}`}>
          <SessionCodeEditor
            projectPath={projectPath}
            encodedPath={encodedPath}
            onOpenInNewTab={(path) => window.open(`/projects/${encodedPath}/code?path=${encodeURIComponent(path)}`, '_blank')}
          />
        </div>

        <div className={`board-tab-panel ${tab === 'files' ? 'visible' : 'hidden'}`}>
          <FinderExplorer
            projectPath={projectPath}
            encodedPath={encodedPath}
            embedded
          />
        </div>

        {/* KB is heavy — only mount when visible. */}
        {tab === 'kb' && (
          <div className="board-tab-panel visible">
            <KBGraph
              projectPath={projectPath}
              encodedPath={encodedPath}
              visible
              /* When the user hits "Discuss in terminal" on an entity,
                 auto-switch to the Master tab so they see Claude
                 responding without an extra click. */
              onSwitchToTerminal={() => setTab('terminal')}
            />
          </div>
        )}
      </div>

      {openTaskKey && (
        <BoardTaskModal
          projectPath={projectPath}
          boardId={boardId}
          task={tasks.find((t) => t.key === openTaskKey)!}
          columns={board.columns}
          onMoveTask={handleMoveTask}
          onClose={() => setOpenTaskKey(null)}
          onChanged={load}
        />
      )}
    </div>
  )
}
