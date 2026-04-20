import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, RegisteredProject, Session } from '../api/client'
import { encodeProjectPath } from './ProjectDashboard'
import {
  Folder,
  ChevronUp,
  ChevronDown,
  Terminal,
  Layers,
} from 'lucide-react'

interface ProjectGroup {
  key: string
  label: string
  projects: (RegisteredProject & { sessions: Session[] })[]
}

interface ProjectDockProps {
  currentProjectPath: string
  currentSessionId: string
}

const UNGROUPED_KEY = '__ungrouped__'

const DOCK_HIDDEN_KEY = 'orka-dock-hidden'

export function ProjectDock({ currentProjectPath, currentSessionId }: ProjectDockProps) {
  const navigate = useNavigate()
  const [groups, setGroups] = useState<ProjectGroup[]>([])
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [expandedProject, setExpandedProject] = useState<string | null>(null)
  const [hidden, setHidden] = useState(() => localStorage.getItem(DOCK_HIDDEN_KEY) === '1')
  const popoverRef = useRef<HTMLDivElement>(null)

  const toggleHidden = useCallback(() => {
    setHidden(prev => {
      const next = !prev
      localStorage.setItem(DOCK_HIDDEN_KEY, next ? '1' : '0')
      if (next) {
        setExpandedGroup(null)
        setExpandedProject(null)
      }
      return next
    })
  }, [])

  // Fetch all projects and their sessions
  const loadData = useCallback(async () => {
    try {
      const projects = await api.listProjects()

      // Fetch sessions in parallel, collect results
      const entries = await Promise.all(projects.map(async (project) => {
        let sessions: Session[] = []
        try {
          sessions = await api.listSessions(project.path)
        } catch { /* ignore - project may not be initialized */ }
        return { ...project, sessions }
      }))

      // Build groups sequentially (no race condition)
      const groupMap = new Map<string, (RegisteredProject & { sessions: Session[] })[]>()
      for (const entry of entries) {
        const key = entry.group || UNGROUPED_KEY
        if (!groupMap.has(key)) groupMap.set(key, [])
        groupMap.get(key)!.push(entry)
      }

      const sorted: ProjectGroup[] = []
      const namedGroups = [...groupMap.entries()]
        .filter(([k]) => k !== UNGROUPED_KEY)
        .sort(([a], [b]) => a.localeCompare(b))

      for (const [key, projects] of namedGroups) {
        sorted.push({ key, label: key, projects })
      }

      const ungrouped = groupMap.get(UNGROUPED_KEY)
      if (ungrouped) {
        sorted.push({ key: UNGROUPED_KEY, label: 'Other', projects: ungrouped })
      }

      setGroups(sorted)
    } catch (err) {
      console.error('ProjectDock: failed to load data', err)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Close popover on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (expandedGroup && popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setExpandedGroup(null)
        setExpandedProject(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [expandedGroup])

  const handleGroupClick = (key: string) => {
    if (expandedGroup === key) {
      setExpandedGroup(null)
      setExpandedProject(null)
    } else {
      setExpandedGroup(key)
      setExpandedProject(null)
    }
  }

  const handleProjectClick = (projectPath: string) => {
    if (expandedProject === projectPath) {
      setExpandedProject(null)
    } else {
      setExpandedProject(projectPath)
    }
  }

  const handleSessionClick = (projectPath: string, sessionId: string) => {
    // Don't navigate to current session
    if (projectPath === currentProjectPath && sessionId === currentSessionId) return

    const encoded = encodeProjectPath(projectPath)
    navigate(`/projects/${encoded}/sessions/${sessionId}`)
    setExpandedGroup(null)
    setExpandedProject(null)
  }

  if (hidden) {
    return (
      <button
        className="dock-collapsed-tab"
        onClick={toggleHidden}
        title="Show project dock"
      >
        <ChevronUp size={14} />
        <Layers size={14} />
      </button>
    )
  }

  return (
    <div className="project-dock" ref={popoverRef}>
      {/* Popover: shown when a group is expanded */}
      {expandedGroup && (
        <div className="dock-popover">
          <div className="dock-popover-header">
            <Folder size={14} />
            <span>{groups.find(g => g.key === expandedGroup)?.label}</span>
          </div>
          <div className="dock-popover-content">
            {groups.find(g => g.key === expandedGroup)?.projects.map(project => {
              const isCurrentProject = project.path === currentProjectPath
              const projectName = project.name || project.path.split('/').pop() || project.path
              const activeSessions = project.sessions.filter(s => s.status === 'active')
              const isExpanded = expandedProject === project.path

              return (
                <div key={project.path} className="dock-project-item">
                  <button
                    className={`dock-project-btn ${isCurrentProject ? 'current' : ''}`}
                    onClick={() => handleProjectClick(project.path)}
                  >
                    <span className="dock-project-name">{projectName}</span>
                    {activeSessions.length > 0 && (
                      <span className="dock-session-count">{activeSessions.length}</span>
                    )}
                    <ChevronUp size={12} className={`dock-chevron ${isExpanded ? 'expanded' : ''}`} />
                  </button>

                  {isExpanded && (
                    <div className="dock-sessions-list">
                      {project.sessions.length === 0 ? (
                        <div className="dock-no-sessions">No sessions</div>
                      ) : (
                        project.sessions.map(sess => {
                          const isCurrent = project.path === currentProjectPath && sess.id === currentSessionId
                          return (
                            <button
                              key={sess.id}
                              className={`dock-session-btn ${isCurrent ? 'current' : ''} ${sess.status}`}
                              onClick={() => handleSessionClick(project.path, sess.id)}
                              title={`${sess.name || sess.id} (${sess.status})`}
                            >
                              <Terminal size={12} />
                              <span className="dock-session-name">{sess.name || sess.id}</span>
                              <span className={`dock-status-dot ${sess.status}`} />
                            </button>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Dock bar */}
      <div className="dock-bar">
        <button
          className="dock-hide-btn"
          onClick={toggleHidden}
          title="Hide dock"
        >
          <ChevronDown size={14} />
        </button>
        <div className="dock-separator" />
        {groups.map(group => {
          const activeInGroup = group.projects.reduce((s, p) =>
            s + p.sessions.filter(sess => sess.status === 'active').length, 0)
          const hasCurrentProject = group.projects.some(p => p.path === currentProjectPath)
          const isExpanded = expandedGroup === group.key

          return (
            <button
              key={group.key}
              className={`dock-icon ${isExpanded ? 'expanded' : ''} ${hasCurrentProject ? 'has-current' : ''}`}
              onClick={() => handleGroupClick(group.key)}
              title={`${group.label} (${group.projects.length} projects)`}
            >
              <Layers size={18} />
              <span className="dock-icon-label">{group.label}</span>
              {activeInGroup > 0 && (
                <span className="dock-icon-badge">{activeInGroup}</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
