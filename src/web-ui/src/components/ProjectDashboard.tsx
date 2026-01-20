import { useState, useEffect, useCallback } from 'react'
import { api, RegisteredProject, Session } from '../api/client'
import { FolderOpen, Plus, Trash2, Play, ArrowLeft, RefreshCw } from 'lucide-react'
import { FolderBrowser } from './FolderBrowser'

interface ProjectDashboardProps {
  selectedProject?: RegisteredProject
  onSelectProject: (project: RegisteredProject) => void
  onSelectSession: (project: RegisteredProject, session: Session) => void
  onBack?: () => void
}

export function ProjectDashboard({
  selectedProject,
  onSelectProject,
  onSelectSession,
  onBack,
}: ProjectDashboardProps) {
  const [projects, setProjects] = useState<RegisteredProject[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddProject, setShowAddProject] = useState(false)
  const [showNewSession, setShowNewSession] = useState(false)
  const [newSessionName, setNewSessionName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const loadProjects = useCallback(async () => {
    try {
      const data = await api.listProjects()
      setProjects(data)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  const loadSessions = useCallback(async () => {
    if (!selectedProject) return
    try {
      const data = await api.listSessions(selectedProject.path)
      setSessions(data)
    } catch (err: any) {
      setError(err.message)
    }
  }, [selectedProject])

  useEffect(() => {
    setLoading(true)
    if (selectedProject) {
      loadSessions().finally(() => setLoading(false))
    } else {
      loadProjects().finally(() => setLoading(false))
    }
  }, [selectedProject, loadProjects, loadSessions])

  // Auto-refresh sessions every 5 seconds when viewing a project
  useEffect(() => {
    if (!selectedProject) return
    const interval = setInterval(loadSessions, 5000)
    return () => clearInterval(interval)
  }, [selectedProject, loadSessions])

  const handleAddProject = async (projectPath: string) => {
    if (!projectPath.trim()) return
    setIsCreating(true)
    try {
      await api.registerProject(projectPath)
      setShowAddProject(false)
      await loadProjects()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsCreating(false)
    }
  }

  const handleRemoveProject = async (path: string) => {
    if (!confirm('Remove this project from Orka? (Files will not be deleted)')) return
    try {
      await api.unregisterProject(path)
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
      // Auto-select the new session
      onSelectSession(selectedProject, session)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsCreating(false)
    }
  }

  const handleResumeSession = async (session: Session) => {
    if (!selectedProject) return
    try {
      const resumed = await api.resumeSession(selectedProject.path, session.id)
      onSelectSession(selectedProject, resumed)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleDeleteSession = async (sessionId: string) => {
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
      <div className="dashboard loading">
        <div className="spinner"></div>
        <p>Loading...</p>
      </div>
    )
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        {selectedProject ? (
          <>
            <button className="back-button" onClick={onBack}>
              <ArrowLeft size={18} />
              Back
            </button>
            <div className="project-title">
              <FolderOpen size={24} />
              <div>
                <h1>{selectedProject.name}</h1>
                <span className="project-path">{selectedProject.path}</span>
              </div>
            </div>
            <button className="refresh-button" onClick={loadSessions}>
              <RefreshCw size={18} />
            </button>
          </>
        ) : (
          <>
            <h1>Claude Orka</h1>
            <button className="refresh-button" onClick={loadProjects}>
              <RefreshCw size={18} />
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {selectedProject ? (
        // Session list view
        <div className="session-list">
          <div className="list-header">
            <h2>Sessions</h2>
            <button className="add-button" onClick={() => setShowNewSession(true)}>
              <Plus size={18} />
              New Session
            </button>
          </div>

          {sessions.length === 0 ? (
            <div className="empty-state">
              <p>No sessions yet</p>
              <button className="add-button primary" onClick={() => setShowNewSession(true)}>
                <Plus size={18} />
                Create your first session
              </button>
            </div>
          ) : (
            <div className="list-items">
              {sessions.map((session) => (
                <div key={session.id} className={`session-card ${session.status}`}>
                  <div className="session-info">
                    <div className="session-name">{session.name || session.id}</div>
                    <div className="session-meta">
                      <span className={`status-badge ${session.status}`}>{session.status}</span>
                      <span className="fork-count">{session.forks.length} forks</span>
                      <span className="date">
                        {new Date(session.lastActivity || session.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <div className="session-actions">
                    {session.status === 'active' ? (
                      <button
                        className="action-btn primary"
                        onClick={() => onSelectSession(selectedProject, session)}
                        title="Open session"
                      >
                        <Play size={18} />
                        Open
                      </button>
                    ) : (
                      <button
                        className="action-btn"
                        onClick={() => handleResumeSession(session)}
                        title="Resume session"
                      >
                        <Play size={18} />
                        Resume
                      </button>
                    )}
                    <button
                      className="action-btn danger"
                      onClick={() => handleDeleteSession(session.id)}
                      title="Delete session"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        // Project list view
        <div className="project-list">
          <div className="list-header">
            <h2>Projects</h2>
            <button className="add-button" onClick={() => setShowAddProject(true)}>
              <Plus size={18} />
              Add Project
            </button>
          </div>

          {projects.length === 0 ? (
            <div className="empty-state">
              <p>No projects registered</p>
              <button className="add-button primary" onClick={() => setShowAddProject(true)}>
                <Plus size={18} />
                Add your first project
              </button>
            </div>
          ) : (
            <div className="list-items">
              {projects.map((project) => (
                <div
                  key={project.path}
                  className="project-card"
                  onClick={() => onSelectProject(project)}
                >
                  <div className="project-icon">
                    <FolderOpen size={24} />
                  </div>
                  <div className="project-info">
                    <div className="project-name">{project.name}</div>
                    <div className="project-path">{project.path}</div>
                    <div className="project-meta">
                      <span>{project.sessionCount || 0} sessions</span>
                      {project.activeSessions ? (
                        <span className="active-badge">{project.activeSessions} active</span>
                      ) : null}
                    </div>
                  </div>
                  <button
                    className="remove-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemoveProject(project.path)
                    }}
                    title="Remove project"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add Project Modal */}
      {showAddProject && (
        <div className="modal-overlay">
          <FolderBrowser
            onSelect={handleAddProject}
            onCancel={() => setShowAddProject(false)}
          />
        </div>
      )}

      {/* New Session Modal */}
      {showNewSession && (
        <div className="modal-overlay" onClick={() => setShowNewSession(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create New Session</h3>
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
                {isCreating ? 'Creating...' : 'Create Session'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
