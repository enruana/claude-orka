import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { api, RegisteredProject, Session } from '../api/client'
import { SessionView } from './SessionView'
import { decodeProjectPath, encodeProjectPath } from './ProjectDashboard'

type RightPanelTab = 'terminal' | 'code' | 'files'

export function SessionPage() {
  const { encodedPath, sessionId } = useParams<{ encodedPath: string; sessionId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // Get current tab from URL, default to 'terminal'
  const currentTab = (searchParams.get('tab') as RightPanelTab) || 'terminal'

  // Handle tab change - updates URL
  const handleTabChange = useCallback((tab: RightPanelTab) => {
    setSearchParams({ tab }, { replace: true })
  }, [setSearchParams])

  const [project, setProject] = useState<RegisteredProject | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadData = async () => {
      if (!encodedPath || !sessionId) {
        navigate('/dashboard', { replace: true })
        return
      }

      try {
        const projectPath = decodeProjectPath(encodedPath)

        // Load project info
        const projects = await api.listProjects()
        const foundProject = projects.find(p => p.path === projectPath)

        if (!foundProject) {
          setError('Project not found')
          setLoading(false)
          return
        }

        setProject(foundProject)

        // Load session
        const sessionData = await api.getSession(projectPath, sessionId)
        setSession(sessionData)
        setLoading(false)
      } catch (err: any) {
        setError(err.message)
        setLoading(false)
      }
    }

    loadData()
  }, [encodedPath, sessionId, navigate])

  const handleBack = () => {
    if (project) {
      const encoded = encodeProjectPath(project.path)
      navigate(`/projects/${encoded}`)
    } else {
      navigate('/dashboard')
    }
  }

  const handleGoHome = () => {
    navigate('/dashboard')
  }

  if (loading) {
    return (
      <div className="session-view-container loading">
        <div className="spinner"></div>
        <p>Loading session...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="session-view-container error-container">
        <div className="error-message">
          <h2>Error</h2>
          <p>{error}</p>
          <button onClick={handleBack}>Go Back</button>
        </div>
      </div>
    )
  }

  if (!project || !session) {
    return (
      <div className="session-view-container error-container">
        <div className="error-message">
          <h2>Not Found</h2>
          <p>Session not found</p>
          <button onClick={handleBack}>Go Back</button>
        </div>
      </div>
    )
  }

  return (
    <SessionView
      project={project}
      session={session}
      onBack={handleBack}
      onGoHome={handleGoHome}
      currentTab={currentTab}
      onTabChange={handleTabChange}
    />
  )
}
