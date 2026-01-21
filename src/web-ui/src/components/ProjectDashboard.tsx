import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, RegisteredProject, Session } from '../api/client'
import { FolderOpen, Plus, Trash2, RefreshCw, Settings, ChevronRight, AlertTriangle, Check, RotateCw } from 'lucide-react'
import { FolderBrowser } from './FolderBrowser'

// Helper to encode/decode project paths for URLs
export function encodeProjectPath(path: string): string {
  return btoa(path).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeProjectPath(encoded: string): string {
  // Add back padding
  let padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
  while (padded.length % 4) padded += '='
  return atob(padded)
}

interface VersionInfo {
  isOutdated: boolean
  currentVersion: string
  projectVersion: string
}

export function ProjectDashboard() {
  const navigate = useNavigate()
  const { encodedPath } = useParams<{ encodedPath?: string }>()

  const [projects, setProjects] = useState<RegisteredProject[]>([])
  const [selectedProject, setSelectedProject] = useState<RegisteredProject | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAddProject, setShowAddProject] = useState(false)
  const [showNewSession, setShowNewSession] = useState(false)
  const [newSessionName, setNewSessionName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null)
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [isReinitializing, setIsReinitializing] = useState(false)

  const loadProjects = useCallback(async () => {
    try {
      const data = await api.listProjects()
      setProjects(data)
      return data
    } catch (err: any) {
      setError(err.message)
      return []
    }
  }, [])

  const loadSessions = useCallback(async () => {
    if (!selectedProject) {
      setSessions([])
      return
    }
    setSessionsLoading(true)
    try {
      const data = await api.listSessions(selectedProject.path)
      setSessions(data)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSessionsLoading(false)
    }
  }, [selectedProject])

  // Initial load and URL-based project selection
  useEffect(() => {
    setLoading(true)
    loadProjects().then((projectList) => {
      // If we have a project path in the URL, select that project
      if (encodedPath) {
        try {
          const projectPath = decodeProjectPath(encodedPath)
          const project = projectList.find(p => p.path === projectPath)
          if (project) {
            setSelectedProject(project)
          } else {
            // Project not found, redirect to dashboard
            navigate('/dashboard', { replace: true })
          }
        } catch {
          // Invalid encoded path
          navigate('/dashboard', { replace: true })
        }
      } else if (projectList.length > 0 && !selectedProject) {
        // Auto-select first project if none selected
        setSelectedProject(projectList[0])
      }
      setLoading(false)
    })
  }, [])

  // Update URL when selected project changes
  useEffect(() => {
    if (selectedProject) {
      const encoded = encodeProjectPath(selectedProject.path)
      const currentPath = `/projects/${encoded}`
      if (window.location.pathname !== currentPath) {
        navigate(currentPath, { replace: true })
      }
    }
  }, [selectedProject, navigate])

  useEffect(() => {
    if (selectedProject) {
      loadSessions()
    }
  }, [selectedProject, loadSessions])

  // Auto-refresh sessions every 5 seconds
  useEffect(() => {
    if (!selectedProject) return
    const interval = setInterval(loadSessions, 5000)
    return () => clearInterval(interval)
  }, [selectedProject, loadSessions])

  // Check version when project is selected
  useEffect(() => {
    if (!selectedProject) {
      setVersionInfo(null)
      return
    }
    const checkVersion = async () => {
      try {
        const info = await api.checkProjectVersion(selectedProject.path)
        setVersionInfo(info)
      } catch {
        setVersionInfo(null)
      }
    }
    checkVersion()
  }, [selectedProject])

  const handleReinitialize = async () => {
    if (!selectedProject) return
    setIsReinitializing(true)
    try {
      await api.reinitializeProject(selectedProject.path)
      const info = await api.checkProjectVersion(selectedProject.path)
      setVersionInfo(info)
      await loadSessions()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsReinitializing(false)
    }
  }

  const handleSelectProject = (project: RegisteredProject) => {
    setSelectedProject(project)
  }

  const handleAddProject = async (projectPath: string) => {
    if (!projectPath.trim()) return
    setIsCreating(true)
    try {
      const newProject = await api.registerProject(projectPath)
      setShowAddProject(false)
      await loadProjects()
      setSelectedProject(newProject)
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
      if (selectedProject?.path === path) {
        setSelectedProject(null)
        navigate('/dashboard', { replace: true })
      }
      await loadProjects()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleCreateSession = async () => {
    if (!selectedProject) return
    setIsCreating(true)
    try {
      const session = await api.createSession(selectedProject.path, newSessionName || undefined)
      setNewSessionName('')
      setShowNewSession(false)
      await loadSessions()
      // Navigate to session view
      const encoded = encodeProjectPath(selectedProject.path)
      navigate(`/projects/${encoded}/sessions/${session.id}`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsCreating(false)
    }
  }

  const handleResumeSession = async (session: Session) => {
    if (!selectedProject) return
    setResumingSessionId(session.id)
    try {
      await api.resumeSession(selectedProject.path, session.id)
      await loadSessions()
      // Navigate to session view
      const encoded = encodeProjectPath(selectedProject.path)
      navigate(`/projects/${encoded}/sessions/${session.id}`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setResumingSessionId(null)
    }
  }

  const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    if (!selectedProject) return
    if (!confirm('Delete this session permanently? This cannot be undone.')) return
    try {
      await api.deleteSession(selectedProject.path, sessionId)
      await loadSessions()
    } catch (err: any) {
      setError(err.message)
    }
  }

  if (loading) {
    return (
      <div className="settings-layout loading">
        <div className="spinner"></div>
        <p>Loading...</p>
      </div>
    )
  }

  return (
    <div className="settings-layout">
      {/* Sidebar - Projects */}
      <div className="settings-sidebar">
        <div className="sidebar-header">
          <h1>Claude Orka</h1>
          <button className="icon-button" onClick={() => setShowAddProject(true)} title="Add Project">
            <Plus size={18} />
          </button>
        </div>

        <div className="sidebar-content">
          {projects.length === 0 ? (
            <div className="sidebar-empty">
              <p>No projects</p>
              <button className="add-project-btn" onClick={() => setShowAddProject(true)}>
                <Plus size={16} />
                Add Project
              </button>
            </div>
          ) : (
            <div className="project-list-sidebar">
              {projects.map((project) => (
                <div
                  key={project.path}
                  className={`sidebar-item ${selectedProject?.path === project.path ? 'selected' : ''}`}
                  onClick={() => handleSelectProject(project)}
                >
                  <div className="sidebar-item-icon">
                    <FolderOpen size={18} />
                  </div>
                  <div className="sidebar-item-content">
                    <span className="sidebar-item-name">{project.name}</span>
                    {project.activeSessions && project.activeSessions > 0 && (
                      <span className="sidebar-item-badge">{project.activeSessions}</span>
                    )}
                  </div>
                  <button
                    className="sidebar-item-remove"
                    onClick={(e) => handleRemoveProject(e, project.path)}
                    title="Remove project"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Main Content - Sessions */}
      <div className="settings-content">
        {error && (
          <div className="error-banner">
            {error}
            <button onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}

        {selectedProject ? (
          <>
            <div className="content-header">
              <div className="content-header-info">
                <div className="content-header-title">
                  <h2>{selectedProject.name}</h2>
                  {/* Version Badge */}
                  {versionInfo && (
                    versionInfo.isOutdated ? (
                      <div className="version-badge outdated">
                        <AlertTriangle size={12} />
                        <span>v{versionInfo.projectVersion}</span>
                        <button
                          className="sync-btn"
                          onClick={handleReinitialize}
                          disabled={isReinitializing}
                          title={`Sync to v${versionInfo.currentVersion}`}
                        >
                          <RotateCw size={12} className={isReinitializing ? 'spinning' : ''} />
                          {isReinitializing ? 'Syncing...' : 'Sync'}
                        </button>
                      </div>
                    ) : (
                      <div className="version-badge synced">
                        <Check size={12} />
                        <span>v{versionInfo.currentVersion}</span>
                      </div>
                    )
                  )}
                </div>
                <span className="content-header-path">{selectedProject.path}</span>
              </div>
              <div className="content-header-actions">
                <button className="icon-button" onClick={loadSessions} title="Refresh">
                  <RefreshCw size={16} />
                </button>
                <button className="add-button primary" onClick={() => setShowNewSession(true)}>
                  <Plus size={16} />
                  New Session
                </button>
              </div>
            </div>

            <div className="content-body">
              {sessionsLoading && sessions.length === 0 ? (
                <div className="content-loading">
                  <div className="spinner"></div>
                </div>
              ) : sessions.length === 0 ? (
                <div className="content-empty">
                  <div className="empty-icon">
                    <Settings size={48} />
                  </div>
                  <h3>No sessions yet</h3>
                  <p>Create your first session to start working with Claude</p>
                  <button className="add-button primary" onClick={() => setShowNewSession(true)}>
                    <Plus size={16} />
                    Create Session
                  </button>
                </div>
              ) : (
                <div className="sessions-list">
                  {sessions.map((session) => {
                    const isResuming = resumingSessionId === session.id
                    return (
                      <div
                        key={session.id}
                        className={`session-row ${session.status} ${isResuming ? 'resuming' : ''}`}
                        onClick={() => {
                          if (isResuming) return
                          handleResumeSession(session)
                        }}
                      >
                        <div className="session-row-status">
                          {isResuming ? (
                            <span className="spinner-small"></span>
                          ) : (
                            <span className={`status-indicator ${session.status}`}></span>
                          )}
                        </div>
                        <div className="session-row-info">
                          <span className="session-row-name">{session.name || session.id}</span>
                          <span className="session-row-meta">
                            {isResuming ? (
                              'Resuming session...'
                            ) : (
                              <>
                                {session.forks.length} {session.forks.length === 1 ? 'fork' : 'forks'}
                                <span className="separator">·</span>
                                {new Date(session.lastActivity || session.createdAt).toLocaleDateString()}
                              </>
                            )}
                          </span>
                        </div>
                        <div className="session-row-actions">
                          <span className={`status-label ${session.status}`}>
                            {isResuming ? 'resuming' : session.status}
                          </span>
                          <button
                            className="session-row-delete"
                            onClick={(e) => handleDeleteSession(e, session.id)}
                            title="Delete session"
                            disabled={isResuming}
                          >
                            <Trash2 size={14} />
                          </button>
                          <ChevronRight size={16} className="session-row-chevron" />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="content-empty">
            <div className="empty-icon">
              <FolderOpen size={48} />
            </div>
            <h3>Select a project</h3>
            <p>Choose a project from the sidebar to view its sessions</p>
            {projects.length === 0 && (
              <button className="add-button primary" onClick={() => setShowAddProject(true)}>
                <Plus size={16} />
                Add Your First Project
              </button>
            )}
          </div>
        )}
      </div>

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

      {/* New Session Modal */}
      {showNewSession && (
        <div className="modal-overlay" onClick={() => setShowNewSession(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New Session</h3>
            <p className="modal-subtitle">
              Create a new session in <strong>{selectedProject?.name}</strong>
            </p>
            <input
              type="text"
              value={newSessionName}
              onChange={(e) => setNewSessionName(e.target.value)}
              placeholder="Session name (optional)"
              autoFocus
              onKeyPress={(e) => e.key === 'Enter' && handleCreateSession()}
            />
            <div className="modal-buttons">
              <button className="button-secondary" onClick={() => setShowNewSession(false)}>
                Cancel
              </button>
              <button
                className="button-primary"
                onClick={handleCreateSession}
                disabled={isCreating}
              >
                {isCreating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
