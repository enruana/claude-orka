import { useState } from 'react'
import { ProjectDashboard } from './components/ProjectDashboard'
import { SessionView } from './components/SessionView'
import { RegisteredProject, Session } from './api/client'

type View =
  | { type: 'dashboard' }
  | { type: 'session'; project: RegisteredProject; session: Session }

export function App() {
  const [view, setView] = useState<View>({ type: 'dashboard' })
  const [error, setError] = useState<string | null>(null)

  const handleSelectSession = (project: RegisteredProject, session: Session) => {
    setView({ type: 'session', project, session })
  }

  const handleBackToDashboard = () => {
    setView({ type: 'dashboard' })
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
      {view.type === 'dashboard' && (
        <ProjectDashboard onSelectSession={handleSelectSession} />
      )}
      {view.type === 'session' && (
        <SessionView
          project={view.project}
          session={view.session}
          onBack={handleBackToDashboard}
          onGoHome={handleBackToDashboard}
        />
      )}
    </div>
  )
}
