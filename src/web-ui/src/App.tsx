import { useState, useEffect, useCallback } from 'react'
import { ProjectDashboard } from './components/ProjectDashboard'
import { SessionView } from './components/SessionView'
import { api, RegisteredProject, Session } from './api/client'

type View =
  | { type: 'projects' }
  | { type: 'project'; project: RegisteredProject }
  | { type: 'session'; project: RegisteredProject; session: Session }

export function App() {
  const [view, setView] = useState<View>({ type: 'projects' })
  const [error, setError] = useState<string | null>(null)

  const handleSelectProject = (project: RegisteredProject) => {
    setView({ type: 'project', project })
  }

  const handleSelectSession = (project: RegisteredProject, session: Session) => {
    setView({ type: 'session', project, session })
  }

  const handleBack = () => {
    if (view.type === 'session') {
      setView({ type: 'project', project: view.project })
    } else {
      setView({ type: 'projects' })
    }
  }

  const handleGoHome = () => {
    setView({ type: 'projects' })
  }

  if (error) {
    return (
      <div className="app error-container">
        <div className="error-message">
          <h2>Error</h2>
          <p>{error}</p>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      {view.type === 'projects' && (
        <ProjectDashboard
          onSelectProject={handleSelectProject}
          onSelectSession={handleSelectSession}
        />
      )}
      {view.type === 'project' && (
        <ProjectDashboard
          selectedProject={view.project}
          onSelectProject={handleSelectProject}
          onSelectSession={handleSelectSession}
          onBack={handleBack}
        />
      )}
      {view.type === 'session' && (
        <SessionView
          project={view.project}
          session={view.session}
          onBack={handleBack}
          onGoHome={handleGoHome}
        />
      )}
    </div>
  )
}
