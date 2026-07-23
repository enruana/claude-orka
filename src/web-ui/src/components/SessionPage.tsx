import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { api, RegisteredProject, Session } from '../api/client'
import { SessionView } from './SessionView'
import { decodeProjectPath, encodeProjectPath } from './ProjectDashboard'

type RightPanelTab = 'terminal' | 'code' | 'files' | 'kb'

export function SessionPage() {
  const { encodedPath, sessionId } = useParams<{ encodedPath: string; sessionId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // Get current tab from URL, default to 'terminal'
  const currentTab = (searchParams.get('tab') as RightPanelTab) || 'terminal'
  // Embedded file-explorer directory (so reload restores where you were)
  const finderPath = searchParams.get('fpath') || undefined

  // Handle tab change - updates URL (preserve other params, e.g. fpath)
  const handleTabChange = useCallback((tab: RightPanelTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('tab', tab)
      return next
    }, { replace: true })
  }, [setSearchParams])

  // Mirror the embedded explorer's current directory into the URL
  const handleFinderPathChange = useCallback((path: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (path) next.set('fpath', path)
      else next.delete('fpath')
      return next
    }, { replace: true })
  }, [setSearchParams])

  const [project, setProject] = useState<RegisteredProject | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Reset state when URL params change (e.g. navigating between sessions via dock)
    setLoading(true)
    setError(null)
    setProject(null)
    setSession(null)

    const loadData = async () => {
      if (!encodedPath || !sessionId) {
        navigate('/launcher', { replace: true })
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

        // Manual ack: the user just opened this session, so clear the
        // "waiting for input" flag right away (hooks will also clear it
        // when Claude resumes; this is the human-in-the-loop signal).
        if (sessionData.waitingForInput) {
          void api.acknowledgeWaiting(projectPath, sessionId)
        }
      } catch (err: any) {
        setError(err.message)
        setLoading(false)
      }
    }

    loadData()
  }, [encodedPath, sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleBack = () => {
    navigate('/launcher')
  }

  const handleGoHome = () => {
    navigate('/launcher')
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
      initialFinderPath={finderPath}
      onFinderPathChange={handleFinderPathChange}
    />
  )
}
