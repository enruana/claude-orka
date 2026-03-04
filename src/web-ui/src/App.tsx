import { BrowserRouter, Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { useState, useEffect, useCallback } from 'react'
import { ProjectDashboard, decodeProjectPath } from './components/ProjectDashboard'
import { SessionPage } from './components/SessionPage'
import { CodeEditorPage, FilesPage } from './components/code-editor'
import { FileViewerPage } from './components/finder'
import { AgentCanvasPage } from './pages/AgentCanvasPage'
import { HomePage } from './pages/HomePage'
import { TaskWidget } from './components/TaskWidget'
import { QuickAIDialog } from './components/QuickAIDialog'
import { api, AIQueryContext } from './api/client'

function GlobalProjectWidgets() {
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const match = pathname.match(/^\/projects\/([^/]+)/)
  if (!match) return null

  const encodedPath = match[1]
  const projectPath = decodeProjectPath(encodedPath)

  // Determine context type from current route
  const sessionMatch = pathname.match(/\/sessions\/([^/]+)/)
  const isCodeRoute = pathname.endsWith('/code')
  const tab = searchParams.get('tab')

  let contextType: 'terminal' | 'code' | 'none' = 'none'
  let contextLabel = 'General'

  if (sessionMatch) {
    if (tab === 'code') {
      contextType = 'code'
      contextLabel = 'Code'
    } else {
      // Default tab is terminal
      contextType = 'terminal'
      contextLabel = 'Terminal'
    }
  } else if (isCodeRoute) {
    contextType = 'code'
    contextLabel = 'Code'
  }

  const sessionId = sessionMatch?.[1] || null

  // Get context data based on current view
  const getContext = useCallback(async (): Promise<Omit<AIQueryContext, 'type'>> => {
    const base: Omit<AIQueryContext, 'type'> = { projectPath }

    if (contextType === 'terminal' && sessionId) {
      try {
        const session = await api.getSession(projectPath, sessionId)
        if (session.main?.tmuxPaneId) {
          return { ...base, terminalPaneId: session.main.tmuxPaneId }
        }
      } catch {
        // Fall through to no terminal context
      }
    }

    if (contextType === 'code') {
      // Request context from Monaco editor via custom event
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(base), 500)

        const handler = (e: Event) => {
          clearTimeout(timeout)
          window.removeEventListener('orka-editor-context', handler)
          const detail = (e as CustomEvent).detail
          resolve({
            ...base,
            fileContent: detail.fileContent,
            filePath: detail.filePath,
            selection: detail.selection,
          })
        }

        window.addEventListener('orka-editor-context', handler)
        window.dispatchEvent(new CustomEvent('orka-get-editor-context'))
      })
    }

    return base
  }, [projectPath, contextType, sessionId])

  return (
    <>
      <TaskWidget projectPath={projectPath} />
      <QuickAIDialogWrapper
        contextType={contextType}
        contextLabel={contextLabel}
        getContext={getContext}
      />
    </>
  )
}

function QuickAIDialogWrapper({
  contextType,
  contextLabel,
  getContext,
}: {
  contextType: 'terminal' | 'code' | 'none'
  contextLabel: string
  getContext: () => Promise<Omit<AIQueryContext, 'type'>>
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(true)
      }
    }
    // Listen for Cmd+K forwarded from terminal iframe via postMessage
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'orka-cmd-k') {
        setOpen(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('message', handleMessage)
    }
  }, [])

  return (
    <QuickAIDialog
      open={open}
      onClose={() => setOpen(false)}
      contextType={contextType}
      contextLabel={contextLabel}
      getContext={getContext}
    />
  )
}

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
        <GlobalProjectWidgets />
      </div>
    </BrowserRouter>
  )
}
