import { useState, useEffect, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api, RegisteredProject, Session } from '../api/client'
import {
  FolderOpen,
  Plus,
  Trash2,
  RefreshCw,
  Settings,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Check,
  RotateCw,
  GitBranch,
} from 'lucide-react'
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

interface ProjectWithSessions extends RegisteredProject {
  sessions: Session[]
  sessionsLoading: boolean
  versionInfo: VersionInfo | null
}

export function ProjectDashboard() {
  const navigate = useNavigate()

  const [projects, setProjects] = useState<ProjectWithSessions[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddProject, setShowAddProject] = useState(false)
  const [showNewSession, setShowNewSession] = useState<string | null>(null) // project path
  const [newSessionName, setNewSessionName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null)
  const [reinitializingProject, setReinitializingProject] = useState<string | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<string[]>([])

  // Load all projects with their sessions
  const loadAllData = useCallback(async () => {
    try {
      const projectList = await api.listProjects()

      // Load sessions and version info for each project in parallel
      const projectsWithData = await Promise.all(
        projectList.map(async (project) => {
          let sessions: Session[] = []
          let versionInfo: VersionInfo | null = null

          try {
            sessions = await api.listSessions(project.path)
          } catch {
            // Ignore session loading errors
          }

          try {
            versionInfo = await api.checkProjectVersion(project.path)
          } catch {
            // Ignore version check errors
          }

          return {
            ...project,
            sessions,
            sessionsLoading: false,
            versionInfo,
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

  // Initial load
  useEffect(() => {
    loadAllData()
  }, [loadAllData])

  // Auto-refresh every 5 seconds
  useEffect(() => {
    const interval = setInterval(loadAllData, 5000)
    return () => clearInterval(interval)
  }, [loadAllData])

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
      // Navigate to session view
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
      // Navigate to session view
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

  if (loading) {
    return (
      <div className="unified-dashboard loading">
        <div className="spinner"></div>
        <p>Loading...</p>
      </div>
    )
  }

  return (
    <div className="unified-dashboard">
      {/* Header */}
      <div className="dashboard-header">
        <div className="header-left">
          <h1><Link to="/" style={{ color: 'inherit', textDecoration: 'none' }}>Claude Orka</Link></h1>
        </div>
        <div className="header-right">
          <button className="icon-button" onClick={loadAllData} title="Refresh">
            <RefreshCw size={18} />
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

      {/* Projects List */}
      <div className="dashboard-content">
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
        ) : (
          <div className="projects-list">
            {projects.map((project) => {
              const isReinitializing = reinitializingProject === project.path
              const activeSessions = project.sessions.filter((s) => s.status === 'active')
              const savedSessions = project.sessions.filter((s) => s.status === 'saved')
              const isExpanded = expandedProjects.includes(project.path)

              return (
                <div key={project.path} className="project-card-unified">
                  {/* Header - clickable on mobile to expand/collapse */}
                  <div
                    className="project-card-header-unified"
                    onClick={() => toggleProjectExpanded(project.path)}
                  >
                    <div className="project-header-left">
                      <FolderOpen size={18} className="project-icon" />
                      <div className="project-header-info">
                        <div className="project-header-title">
                          <span className="project-name">{project.name}</span>
                          {activeSessions.length > 0 && <span className="status-dot active" />}
                          {project.versionInfo && !project.versionInfo.isOutdated && (
                            <span className="version-badge-small">v{project.versionInfo.currentVersion}</span>
                          )}
                        </div>
                        <span className="project-path">{project.path}</span>
                      </div>
                    </div>
                    <div className="project-header-right">
                      <span className="sessions-count">{project.sessions.length} session{project.sessions.length !== 1 ? 's' : ''}</span>
                      <span className="expand-icon mobile-only">
                        {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                      </span>
                    </div>
                  </div>

                  {/* Content - always visible on desktop, collapsible on mobile */}
                  <div className={`project-card-content ${isExpanded ? 'expanded' : ''}`}>
                    {/* Version Alert */}
                    {project.versionInfo?.isOutdated && (
                      <div className="version-alert">
                        <div className="version-alert-info">
                          <AlertTriangle size={16} />
                          <span>v{project.versionInfo.projectVersion} → v{project.versionInfo.currentVersion}</span>
                        </div>
                        <button
                          className="version-alert-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleReinitialize(project.path)
                          }}
                          disabled={isReinitializing}
                        >
                          <RotateCw size={14} className={isReinitializing ? 'spinning' : ''} />
                          {isReinitializing ? 'Syncing...' : 'Sync'}
                        </button>
                      </div>
                    )}

                    {/* Quick Actions */}
                    <div className="project-actions">
                      <button
                        className="project-action-btn primary"
                        onClick={(e) => {
                          e.stopPropagation()
                          setShowNewSession(project.path)
                        }}
                      >
                        <Plus size={18} />
                        <span>New Session</span>
                      </button>
                      <button
                        className="project-action-btn danger"
                        onClick={(e) => handleRemoveProject(e, project.path)}
                      >
                        <Trash2 size={18} />
                        <span>Remove</span>
                      </button>
                    </div>

                    {/* Sessions List */}
                    {project.sessions.length === 0 ? (
                      <div className="no-sessions-msg">
                        <Settings size={20} />
                        <span>No sessions yet</span>
                      </div>
                    ) : (
                      <div className="sessions-list">
                        {[...activeSessions, ...savedSessions].map((session) => {
                          const isResuming = resumingSessionId === session.id
                          return (
                            <div
                              key={session.id}
                              className={`session-row-unified ${session.status} ${isResuming ? 'resuming' : ''}`}
                              onClick={() => {
                                if (isResuming) return
                                handleResumeSession(project.path, session)
                              }}
                            >
                              <div className="session-status">
                                {isResuming ? (
                                  <span className="spinner-small" />
                                ) : (
                                  <span className={`status-indicator ${session.status}`} />
                                )}
                              </div>
                              <div className="session-info">
                                <span className="session-name">{session.name || session.id}</span>
                                <span className="session-meta">
                                  {isResuming ? 'Opening...' : (
                                    <>
                                      {session.forks.length > 0 && (
                                        <>
                                          <GitBranch size={12} />
                                          {session.forks.length}
                                          <span className="separator">·</span>
                                        </>
                                      )}
                                      {new Date(session.lastActivity || session.createdAt).toLocaleDateString()}
                                    </>
                                  )}
                                </span>
                              </div>
                              <button
                                className="session-delete"
                                onClick={(e) => handleDeleteSession(e, project.path, session.id)}
                                disabled={isResuming}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
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
        <div className="modal-overlay" onClick={() => setShowNewSession(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New Session</h3>
            <p className="modal-subtitle">
              Create a new session in{' '}
              <strong>{projects.find((p) => p.path === showNewSession)?.name}</strong>
            </p>
            <input
              type="text"
              value={newSessionName}
              onChange={(e) => setNewSessionName(e.target.value)}
              placeholder="Session name (optional)"
              autoFocus
              onKeyPress={(e) => e.key === 'Enter' && handleCreateSession(showNewSession)}
            />
            <div className="modal-buttons">
              <button className="button-secondary" onClick={() => setShowNewSession(null)}>
                Cancel
              </button>
              <button
                className="button-primary"
                onClick={() => handleCreateSession(showNewSession)}
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
