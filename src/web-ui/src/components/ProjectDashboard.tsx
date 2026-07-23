import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api, RegisteredProject, Session, type BoardIndexEntry } from '../api/client'
import { CopyFromTerminalModal, useCopyFromTerminalShortcut } from './CopyFromTerminalModal'
import {
  Folder,
  FolderOpen,
  Plus,
  Trash2,
  RefreshCw,
  AlertTriangle,
  RotateCw,
  GitBranch,
  Tag,
  ArrowLeft,
  Settings,
  Terminal,
  Smartphone,
  Save,
} from 'lucide-react'
import { FolderBrowser } from './FolderBrowser'
import { NewSessionModal } from './NewSessionModal'
import { GroupPickerModal } from './GroupPickerModal'
import { usePageTitle } from '../hooks/usePageTitle'

// Helper to encode/decode project paths for URLs
export function encodeProjectPath(path: string): string {
  return btoa(path).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeProjectPath(encoded: string): string {
  let padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
  while (padded.length % 4) padded += '='
  return atob(padded)
}

interface VersionInfo {
  isOutdated: boolean
  currentVersion: string
  projectVersion: string
}

interface ProjectWithSessions extends RegisteredProject {
  sessions: Session[]
  sessionsLoading: boolean
  versionInfo: VersionInfo | null
  boards: BoardIndexEntry[]
}

const UNGROUPED_KEY = '__ungrouped__'

export function ProjectDashboard() {
  const navigate = useNavigate()
  usePageTitle('Dashboard')

  const [projects, setProjects] = useState<ProjectWithSessions[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddProject, setShowAddProject] = useState(false)
  const [showNewSession, setShowNewSession] = useState<string | null>(null)
  const [newSessionName, setNewSessionName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null)
  const [reinitializingProject, setReinitializingProject] = useState<string | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<string[]>([])
  // Save All state: `isSavingAll` disables the button; `saveAllToast`
  // shows a short confirmation with the aggregated counts.
  const [isSavingAll, setIsSavingAll] = useState(false)
  const [saveAllToast, setSaveAllToast] = useState<string | null>(null)

  // Group assignment state
  const [showGroupModal, setShowGroupModal] = useState<string | null>(null)
  const [groupInput, setGroupInput] = useState('')

  // Folder navigation
  const [activeFolder, setActiveFolder] = useState<string | null>(() => {
    return sessionStorage.getItem('orka-active-folder') || null
  })

  // System terminal
  const [systemTerminalPort, setSystemTerminalPort] = useState<number | null>(null)
  const [terminalLoading, setTerminalLoading] = useState(true)
  const terminalIframeRef = useRef<HTMLIFrameElement>(null)
  const [copyTerminalOpen, setCopyTerminalOpen] = useState(false)

  // Fetch plain + ANSI captures of the system terminal for the copy modal.
  const captureSystemTerminal = useCallback(async () => {
    const [plainRes, ansiRes] = await Promise.all([
      api.captureSystemTerminal({ lines: 400 }),
      api.captureSystemTerminal({ lines: 400, ansi: true }),
    ])
    return { plain: plainRes.text || '', ansi: ansiRes.text || '' }
  }, [])

  // Cmd/Ctrl+L (and the postMessage forwarded from inside the terminal
  // iframe) toggles the Copy from Terminal modal — but only when the
  // system terminal is actually mounted.
  useCopyFromTerminalShortcut(
    !!systemTerminalPort,
    useCallback(() => setCopyTerminalOpen(prev => !prev), []),
  )

  // Persist activeFolder
  useEffect(() => {
    if (activeFolder) {
      sessionStorage.setItem('orka-active-folder', activeFolder)
    } else {
      sessionStorage.removeItem('orka-active-folder')
    }
  }, [activeFolder])

  // Load system terminal on mount
  useEffect(() => {
    api.getSystemTerminal()
      .then(({ port }) => setSystemTerminalPort(port))
      .catch(() => {}) // Terminal unavailable is fine
  }, [])

  // Load all projects with their sessions
  const loadAllData = useCallback(async () => {
    try {
      const projectList = await api.listProjects()

      const projectsWithData = await Promise.all(
        projectList.map(async (project) => {
          let sessions: Session[] = []
          let versionInfo: VersionInfo | null = null
          let boards: BoardIndexEntry[] = []

          try {
            sessions = await api.listSessions(project.path)
          } catch {}

          try {
            versionInfo = await api.checkProjectVersion(project.path)
          } catch {}

          try {
            boards = await api.listBoards(project.path)
          } catch {}

          return {
            ...project,
            sessions,
            sessionsLoading: false,
            versionInfo,
            boards,
          }
        })
      )

      setProjects(projectsWithData)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAllData() }, [loadAllData])
  useEffect(() => {
    // Poll at 2s (was 5s) so the per-session waitingForInput flag is
    // visible to the user even when Claude only blocks for a couple of
    // seconds before they approve in the terminal — a 5s window misses
    // those entirely. Refetch on tab refocus too because browsers
    // throttle background-tab setInterval to >=1min, so a notification
    // arriving while the tab is hidden would otherwise be invisible
    // until the user manually reloads.
    const interval = setInterval(loadAllData, 2000)
    const onVisible = () => { if (document.visibilityState === 'visible') loadAllData() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadAllData])

  // Group projects
  const groupedProjects = useMemo(() => {
    const groups = new Map<string, ProjectWithSessions[]>()
    for (const project of projects) {
      const key = project.group || UNGROUPED_KEY
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(project)
    }

    const sorted: { key: string; label: string; projects: ProjectWithSessions[] }[] = []
    const namedGroups = [...groups.entries()]
      .filter(([k]) => k !== UNGROUPED_KEY)
      .sort(([a], [b]) => a.localeCompare(b))

    for (const [key, projs] of namedGroups) {
      sorted.push({ key, label: key, projects: projs })
    }

    const ungrouped = groups.get(UNGROUPED_KEY)
    if (ungrouped) {
      sorted.push({ key: UNGROUPED_KEY, label: 'Ungrouped', projects: ungrouped })
    }

    return sorted
  }, [projects])

  const existingGroups = useMemo(() => {
    const groups = new Set<string>()
    for (const project of projects) {
      if (project.group) groups.add(project.group)
    }
    return [...groups].sort()
  }, [projects])

  const hasGroups = groupedProjects.some(g => g.key !== UNGROUPED_KEY)

  // Handlers

  /**
   * Save a lossless snapshot of every session in every registered
   * project. The backend endpoint is per-project (`POST /save-all?
   * project=...`), so we fan out client-side and aggregate. Failures on
   * individual projects don't stop the run — each project either
   * contributes counts to the toast or an error line.
   *
   * This is the "big red safety net": before rebooting, before killing
   * tmux, or just periodically. Non-destructive — nothing is stopped or
   * killed.
   */
  const handleSaveAll = async () => {
    if (isSavingAll) return
    setIsSavingAll(true)
    setSaveAllToast(null)
    let totalSaved = 0
    let totalFailed = 0
    let totalBranches = 0
    const projectErrors: string[] = []

    try {
      // Run projects in parallel — each project has independent state
      // (its own .claude-orka/state.json) so there's no lock contention.
      await Promise.all(
        projects.map(async (p) => {
          try {
            const r = await api.saveAllSessions(p.path)
            totalSaved += r.saved
            totalFailed += r.failed
            totalBranches += r.results.reduce((n, s) => n + s.branchesSaved, 0)
          } catch (err: any) {
            projectErrors.push(`${p.name}: ${err?.message || err}`)
          }
        })
      )

      const parts: string[] = [`Saved ${totalSaved} session${totalSaved === 1 ? '' : 's'}`]
      if (totalBranches) parts.push(`${totalBranches} branches`)
      if (totalFailed) parts.push(`${totalFailed} failed`)
      const msg = parts.join(' · ')
      setSaveAllToast(projectErrors.length
        ? `${msg} · ${projectErrors.length} project error(s)`
        : msg)
      // Refresh sessions in the sidebar so any updated lastActivity /
      // status shows immediately.
      await loadAllData()
    } catch (err: any) {
      setError(err?.message || 'Failed to save all sessions')
    } finally {
      setIsSavingAll(false)
      // Auto-hide the toast after 5s so it doesn't linger.
      setTimeout(() => setSaveAllToast(null), 5000)
    }
  }

  const handleReinitialize = async (projectPath: string) => {
    setReinitializingProject(projectPath)
    try {
      await api.reinitializeProject(projectPath)
      await loadAllData()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setReinitializingProject(null)
    }
  }

  const handleAddProject = async (projectPath: string) => {
    if (!projectPath.trim()) return
    setIsCreating(true)
    try {
      await api.registerProject(projectPath)
      setShowAddProject(false)
      await loadAllData()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsCreating(false)
    }
  }

  const handleRemoveProject = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    if (!confirm('Remove this project from Orka? (Files will not be deleted)')) return
    try {
      await api.unregisterProject(path)
      await loadAllData()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleCreateSession = async (projectPath: string) => {
    setIsCreating(true)
    try {
      const session = await api.createSession(projectPath, newSessionName || undefined)
      setNewSessionName('')
      setShowNewSession(null)
      await loadAllData()
      const encoded = encodeProjectPath(projectPath)
      navigate(`/projects/${encoded}/sessions/${session.id}`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsCreating(false)
    }
  }

  const handleResumeSession = async (projectPath: string, session: Session) => {
    setResumingSessionId(session.id)
    try {
      await api.resumeSession(projectPath, session.id)
      await loadAllData()
      const encoded = encodeProjectPath(projectPath)
      navigate(`/projects/${encoded}/sessions/${session.id}`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setResumingSessionId(null)
    }
  }

  const handleDeleteSession = async (e: React.MouseEvent, projectPath: string, sessionId: string) => {
    e.stopPropagation()
    if (!confirm('Delete this session permanently? This cannot be undone.')) return
    try {
      await api.deleteSession(projectPath, sessionId)
      await loadAllData()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const toggleProjectExpanded = (projectPath: string) => {
    setExpandedProjects((prev) =>
      prev.includes(projectPath)
        ? prev.filter((p) => p !== projectPath)
        : [...prev, projectPath]
    )
  }

  const handleSetGroup = async (projectPath: string, group: string | null) => {
    try {
      await api.updateProject(projectPath, { group })
      setShowGroupModal(null)
      setGroupInput('')
      await loadAllData()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const openGroupModal = (e: React.MouseEvent, projectPath: string, currentGroup?: string) => {
    e.stopPropagation()
    setShowGroupModal(projectPath)
    setGroupInput(currentGroup || '')
  }

  // Loading state
  if (loading) {
    return (
      <div className="unified-dashboard loading">
        <div className="spinner"></div>
        <p>Loading...</p>
      </div>
    )
  }

  // Render a project card — clean card style matching folder aesthetic
  const renderProjectCard = (project: ProjectWithSessions) => {
    const isReinitializing = reinitializingProject === project.path
    const activeSessions = project.sessions.filter((s) => s.status === 'active')
    const savedSessions = project.sessions.filter((s) => s.status === 'saved')

    return (
      <div key={project.path} className="pcard">
        {/* Card header */}
        <div className="pcard-header">
          <div className="pcard-icon">
            <FolderOpen size={28} />
            {activeSessions.length > 0 && <span className="pcard-active-dot" />}
          </div>
          <div className="pcard-info">
            <span className="pcard-name">{project.name}</span>
            <span className="pcard-path">{project.path}</span>
          </div>
          <div className="pcard-badges">
            {project.versionInfo && !project.versionInfo.isOutdated && (
              <button
                className="pcard-badge version"
                onClick={(e) => { e.stopPropagation(); handleReinitialize(project.path) }}
                disabled={isReinitializing}
                title="Refresh skills and re-run project init (no version change)"
              >
                <RotateCw size={11} className={isReinitializing ? 'spinning' : ''} />
                v{project.versionInfo.currentVersion}
              </button>
            )}
            {project.versionInfo?.isOutdated && (
              <button
                className="pcard-badge outdated"
                onClick={(e) => { e.stopPropagation(); handleReinitialize(project.path) }}
                disabled={isReinitializing}
                title={`Sync to Orka v${project.versionInfo.currentVersion} (installs latest skills + tmux theme)`}
              >
                <RotateCw size={11} className={isReinitializing ? 'spinning' : ''} />
                Sync
              </button>
            )}
            <button
              className="pcard-badge tag-btn"
              onClick={(e) => openGroupModal(e, project.path, project.group)}
              title="Set group"
            >
              <Tag size={11} />
              {project.group || 'Tag'}
            </button>
          </div>
        </div>

        {/* Boards — sit above sessions so a project with a board doesn't
            hide it below a long session list. Each row opens the board
            page in this same tab. */}
        {project.boards.length > 0 && (
          <div className="pcard-boards">
            {project.boards.map((b) => (
              <div
                key={b.id}
                className="pcard-board"
                onClick={() => navigate(`/projects/${encodeProjectPath(project.path)}/boards/${b.id}`)}
                title={b.jiraUrl}
              >
                <span className="pcard-board-dot" />
                <span className="pcard-board-name">{b.name}</span>
                <span className="pcard-board-tag">board</span>
              </div>
            ))}
          </div>
        )}

        {/* Sessions */}
        <div className="pcard-sessions">
          {[...activeSessions, ...savedSessions].map((session) => {
            const isResuming = resumingSessionId === session.id
            return (
              <div
                key={session.id}
                className={`pcard-session ${session.status}${session.waitingForInput ? ' waiting' : ''}`}
                onClick={() => { if (!isResuming) handleResumeSession(project.path, session) }}
                title={session.waitingForInput && session.waitingMessage ? session.waitingMessage : undefined}
              >
                {isResuming ? (
                  <span className="spinner-small" />
                ) : session.waitingForInput ? (
                  <span className="pcard-session-dot waiting" aria-label="Waiting for input" />
                ) : (
                  <span className={`pcard-session-dot ${session.status}`} />
                )}
                <span className="pcard-session-name">{session.name || 'Unnamed'}</span>
                {session.waitingForInput && (
                  <span className="pcard-session-waiting-badge" title={session.waitingMessage || 'Waiting for input'}>
                    needs input
                  </span>
                )}
                {session.forks.length > 0 && (
                  <span className="pcard-session-forks">
                    <GitBranch size={11} /> {session.forks.length}
                  </span>
                )}
                <span className="pcard-session-date">
                  {new Date(session.lastActivity || session.createdAt).toLocaleDateString()}
                </span>
                <button
                  className="pcard-session-del"
                  onClick={(e) => handleDeleteSession(e, project.path, session.id)}
                  disabled={isResuming}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )
          })}
          {project.sessions.length === 0 && (
            <div className="pcard-empty">No sessions yet</div>
          )}
        </div>

        {/* Actions */}
        <div className="pcard-actions">
          <button
            className="pcard-action primary"
            onClick={(e) => { e.stopPropagation(); setShowNewSession(project.path) }}
          >
            <Plus size={14} /> New Session
          </button>
          <button
            className="pcard-action danger"
            onClick={(e) => handleRemoveProject(e, project.path)}
          >
            <Trash2 size={14} /> Remove
          </button>
        </div>
      </div>
    )
  }

  // Get projects for the active folder
  const activeFolderGroup = activeFolder
    ? groupedProjects.find(g => g.key === activeFolder)
    : null

  // If activeFolder is set but group doesn't exist anymore, reset
  if (activeFolder && !activeFolderGroup) {
    setActiveFolder(null)
  }

  return (
    <div className="unified-dashboard">
      {/* Header */}
      <div className="dashboard-header">
        <div className="header-left">
          <h1><Link to="/" style={{ color: 'inherit', textDecoration: 'none' }}>Claude Orka</Link></h1>
        </div>
        <div className="header-right">
          <Link to="/launcher" className="icon-button" title="iPhone-style launcher">
            <Smartphone size={18} />
          </Link>
          <button className="icon-button" onClick={loadAllData} title="Refresh">
            <RefreshCw size={18} />
          </button>
          {/* Save All: fans out per-project to /api/sessions/save-all so
              every session's claudeSessionId, untracked panes and
              context summary are refreshed and persisted. Safe to click
              any time — nothing is stopped. */}
          <button
            className="save-all-button"
            onClick={handleSaveAll}
            disabled={isSavingAll || projects.length === 0}
            title={
              projects.length === 0
                ? 'No projects to save'
                : 'Save a lossless snapshot of every session in every project'
            }
          >
            <Save size={16} className={isSavingAll ? 'spinning' : ''} />
            <span className="btn-text">{isSavingAll ? 'Saving…' : 'Save All'}</span>
          </button>
          <button className="add-button primary" onClick={() => setShowAddProject(true)}>
            <Plus size={16} />
            <span className="btn-text">Add Project</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {saveAllToast && (
        <div className="save-all-toast">
          <Save size={14} />
          {saveAllToast}
        </div>
      )}

      {/* Body: split view */}
      <div className="dashboard-body">
        {/* Left: Projects panel */}
        <div className="dashboard-projects-panel">
          {projects.length === 0 ? (
            <div className="content-empty">
              <div className="empty-icon">
                <FolderOpen size={48} />
              </div>
              <h3>No projects yet</h3>
              <p>Add your first project to start working with Claude Code</p>
              <button className="add-button primary" onClick={() => setShowAddProject(true)}>
                <Plus size={16} />
                Add Your First Project
              </button>
            </div>
          ) : !hasGroups || activeFolder !== null ? (
            // Project list view (inside a folder or no groups)
            <>
              {hasGroups && activeFolderGroup && (
                <button className="folder-nav-back" onClick={() => setActiveFolder(null)}>
                  <ArrowLeft size={16} />
                  <span>{activeFolderGroup.label}</span>
                </button>
              )}
              <div className="projects-list">
                {(activeFolderGroup?.projects || projects).map(renderProjectCard)}
              </div>
            </>
          ) : (
            // Folder grid view
            <div className="folder-grid">
              {groupedProjects.map((group) => {
                const activeCount = group.projects.reduce(
                  (sum, p) => sum + p.sessions.filter(s => s.status === 'active').length, 0
                )
                const totalSessions = group.projects.reduce((sum, p) => sum + p.sessions.length, 0)

                return (
                  <div
                    key={group.key}
                    className="folder-card"
                    onClick={() => setActiveFolder(group.key)}
                  >
                    <div className="folder-card-icon">
                      <Folder size={40} />
                      {activeCount > 0 && <span className="folder-active-dot" />}
                    </div>
                    <span className="folder-card-name">{group.label}</span>
                    <span className="folder-card-meta">
                      {group.projects.length} project{group.projects.length !== 1 ? 's' : ''}
                    </span>
                    {totalSessions > 0 && (
                      <span className="folder-card-meta">
                        {totalSessions} session{totalSessions !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Right: Terminal panel */}
        <div className="dashboard-terminal-panel">
          {systemTerminalPort ? (
            <>
              {terminalLoading && (
                <div className="terminal-loading-overlay">
                  <div className="terminal-loading-spinner" />
                  <p>Loading terminal...</p>
                </div>
              )}
              <iframe
                ref={terminalIframeRef}
                src={`/terminal/${systemTerminalPort}${window.innerWidth >= 769 ? '?desktop=1' : ''}`}
                title="System Terminal"
                className="terminal-iframe"
                allow="clipboard-read; clipboard-write; microphone"
                onLoad={() => setTerminalLoading(false)}
              />
            </>
          ) : (
            <div className="terminal-placeholder">
              <Settings size={24} />
              <span>Terminal unavailable</span>
            </div>
          )}
        </div>
      </div>

      {/* Mobile: floating terminal button */}
      {systemTerminalPort && (
        <button
          className="dashboard-terminal-fab"
          onClick={() => window.open(`/terminal/${systemTerminalPort}`, '_blank')}
          title="Open Terminal"
        >
          <Terminal size={24} />
        </button>
      )}

      {/* Copy from Terminal — Cmd+L on the system terminal iframe */}
      <CopyFromTerminalModal
        open={copyTerminalOpen}
        onClose={() => setCopyTerminalOpen(false)}
        captureFn={captureSystemTerminal}
      />

      {/* Add Project Modal */}
      {showAddProject && (
        <div className="modal-overlay" onClick={() => setShowAddProject(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <FolderBrowser
              onSelect={handleAddProject}
              onCancel={() => setShowAddProject(false)}
            />
          </div>
        </div>
      )}

      {/* New Session Modal — unified picker (Classic | Board) */}
      {showNewSession && (
        <NewSessionModal
          projectPath={showNewSession}
          projectName={projects.find((p) => p.path === showNewSession)?.name}
          onCancel={() => setShowNewSession(null)}
          onCreated={(result) => {
            setShowNewSession(null)
            const encoded = encodeProjectPath(showNewSession)
            if (result.kind === 'classic') {
              navigate(`/projects/${encoded}/sessions/${result.sessionId}`)
            } else {
              navigate(`/projects/${encoded}/boards/${result.boardId}`)
            }
            void loadAllData()
          }}
        />
      )}

      {/* Group / tag picker — shared component with the launcher. */}
      {showGroupModal && (
        <GroupPickerModal
          projectName={projects.find((p) => p.path === showGroupModal)?.name || showGroupModal}
          currentGroup={projects.find((p) => p.path === showGroupModal)?.group || null}
          existingGroups={existingGroups}
          onClose={() => { setShowGroupModal(null); setGroupInput('') }}
          onApply={(value) => handleSetGroup(showGroupModal, value)}
        />
      )}
    </div>
  )
}
