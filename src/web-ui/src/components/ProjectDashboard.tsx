import { useState, useEffect, useCallback, useMemo } from 'react'
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
  Tag,
  X,
} from 'lucide-react'
import { FolderBrowser } from './FolderBrowser'
import { usePageTitle } from '../hooks/usePageTitle'

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

const UNGROUPED_KEY = '__ungrouped__'

export function ProjectDashboard() {
  const navigate = useNavigate()
  usePageTitle('Dashboard')

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
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([])

  // Group assignment state
  const [showGroupModal, setShowGroupModal] = useState<string | null>(null) // project path
  const [groupInput, setGroupInput] = useState('')

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

  // Group projects by group field
  const groupedProjects = useMemo(() => {
    const groups = new Map<string, ProjectWithSessions[]>()

    for (const project of projects) {
      const key = project.group || UNGROUPED_KEY
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(project)
    }

    // Sort: named groups alphabetically first, ungrouped last
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

  // Get all existing group names for suggestions
  const existingGroups = useMemo(() => {
    const groups = new Set<string>()
    for (const project of projects) {
      if (project.group) groups.add(project.group)
    }
    return [...groups].sort()
  }, [projects])

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

  const toggleGroupCollapsed = (groupKey: string) => {
    setCollapsedGroups((prev) =>
      prev.includes(groupKey)
        ? prev.filter((g) => g !== groupKey)
        : [...prev, groupKey]
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

  if (loading) {
    return (
      <div className="unified-dashboard loading">
        <div className="spinner"></div>
        <p>Loading...</p>
      </div>
    )
  }

  const renderProjectCard = (project: ProjectWithSessions) => {
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
            <button
              className="group-tag-btn"
              onClick={(e) => openGroupModal(e, project.path, project.group)}
              title="Set group"
            >
              <Tag size={13} />
              {project.group && <span className="group-tag-label">{project.group}</span>}
            </button>
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
  }

  const hasGroups = groupedProjects.some(g => g.key !== UNGROUPED_KEY)

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
            {groupedProjects.map((group) => {
              const isCollapsed = collapsedGroups.includes(group.key)
              const totalSessions = group.projects.reduce((sum, p) => sum + p.sessions.length, 0)
              const activeCount = group.projects.reduce(
                (sum, p) => sum + p.sessions.filter(s => s.status === 'active').length, 0
              )

              // If there's only ungrouped projects, render them flat (no group header)
              if (!hasGroups) {
                return group.projects.map(renderProjectCard)
              }

              return (
                <div key={group.key} className="project-group">
                  <div
                    className="project-group-header"
                    onClick={() => toggleGroupCollapsed(group.key)}
                  >
                    <div className="project-group-header-left">
                      {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                      <span className="project-group-name">{group.label}</span>
                      <span className="project-group-count">
                        {group.projects.length} project{group.projects.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="project-group-header-right">
                      {activeCount > 0 && (
                        <span className="project-group-active">
                          <span className="status-dot active" />
                          {activeCount} active
                        </span>
                      )}
                      <span className="project-group-sessions">
                        {totalSessions} session{totalSessions !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                  {!isCollapsed && (
                    <div className="project-group-content">
                      {group.projects.map(renderProjectCard)}
                    </div>
                  )}
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

      {/* Group Assignment Modal */}
      {showGroupModal && (
        <div className="modal-overlay" onClick={() => { setShowGroupModal(null); setGroupInput('') }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Assign Group</h3>
            <p className="modal-subtitle">
              Organize <strong>{projects.find((p) => p.path === showGroupModal)?.name}</strong> into a group
            </p>
            <input
              type="text"
              value={groupInput}
              onChange={(e) => setGroupInput(e.target.value)}
              placeholder="Group name (leave empty to ungroup)"
              autoFocus
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  handleSetGroup(showGroupModal, groupInput.trim() || null)
                }
              }}
            />
            {existingGroups.length > 0 && (
              <div className="group-suggestions">
                {existingGroups.map((g) => (
                  <button
                    key={g}
                    className={`group-suggestion-btn ${groupInput === g ? 'selected' : ''}`}
                    onClick={() => setGroupInput(g)}
                  >
                    {g}
                  </button>
                ))}
              </div>
            )}
            <div className="modal-buttons">
              <button className="button-secondary" onClick={() => { setShowGroupModal(null); setGroupInput('') }}>
                Cancel
              </button>
              {projects.find(p => p.path === showGroupModal)?.group && (
                <button
                  className="button-secondary"
                  onClick={() => handleSetGroup(showGroupModal, null)}
                  style={{ color: 'var(--accent-red)' }}
                >
                  Remove Group
                </button>
              )}
              <button
                className="button-primary"
                onClick={() => handleSetGroup(showGroupModal, groupInput.trim() || null)}
              >
                {groupInput.trim() ? 'Save' : 'Ungroup'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
