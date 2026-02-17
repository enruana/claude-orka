import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ProjectDashboard } from './components/ProjectDashboard'
import { SessionPage } from './components/SessionPage'
import { CodeEditorPage, FilesPage } from './components/code-editor'
import { FileViewerPage } from './components/finder'
import { AgentCanvasPage } from './pages/AgentCanvasPage'
import { HomePage } from './pages/HomePage'

export function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <Routes>
          {/* Home page */}
          <Route path="/" element={<HomePage />} />

          {/* Dashboard - unified view of all projects and sessions */}
          <Route path="/dashboard" element={<ProjectDashboard />} />

          {/* Agent Canvas - manage Master Agents */}
          <Route path="/agents" element={<AgentCanvasPage />} />

          {/* Legacy project view - redirect to dashboard */}
          <Route path="/projects/:encodedPath" element={<Navigate to="/dashboard" replace />} />

          {/* Session view - shows a specific session */}
          <Route path="/projects/:encodedPath/sessions/:sessionId" element={<SessionPage />} />

          {/* Code editor view */}
          <Route path="/projects/:encodedPath/code" element={<CodeEditorPage />} />

          {/* Files explorer view */}
          <Route path="/projects/:encodedPath/files" element={<FilesPage />} />

          {/* File viewer (opened from Finder in new tab) */}
          <Route path="/projects/:encodedPath/files/view" element={<FileViewerPage />} />

          {/* Fallback - redirect unknown routes to home */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
