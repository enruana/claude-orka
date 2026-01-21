import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ProjectDashboard } from './components/ProjectDashboard'
import { SessionPage } from './components/SessionPage'

export function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <Routes>
          {/* Redirect root to dashboard */}
          <Route path="/" element={<Navigate to="/dashboard" replace />} />

          {/* Dashboard - list of projects */}
          <Route path="/dashboard" element={<ProjectDashboard />} />

          {/* Project view - shows sessions for a project */}
          <Route path="/projects/:encodedPath" element={<ProjectDashboard />} />

          {/* Session view - shows a specific session */}
          <Route path="/projects/:encodedPath/sessions/:sessionId" element={<SessionPage />} />

          {/* Fallback - redirect unknown routes to dashboard */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
