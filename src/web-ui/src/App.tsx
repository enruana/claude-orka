import {
  createBrowserRouter,
  createRoutesFromElements,
  RouterProvider,
  Route,
  Navigate,
  Outlet,
  useLocation,
  useSearchParams,
  useRouteError,
} from 'react-router-dom'
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

/**
 * Error page shown when a route throws during render.
 * Displays the actual error message for debugging.
 */
function RouteErrorPage() {
  const error = useRouteError() as Error | { statusText?: string; message?: string }
  const message = error instanceof Error
    ? error.message
    : (error as any)?.statusText || (error as any)?.message || JSON.stringify(error)

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100%', gap: '16px', padding: '24px',
      color: 'var(--text-primary)', background: 'var(--bg-primary)'
    }}>
      <h2>Something went wrong</h2>
      <pre style={{
        color: 'var(--text-secondary)', maxWidth: '600px', textAlign: 'left',
        background: 'var(--bg-secondary)', padding: '16px', borderRadius: '8px',
        overflow: 'auto', fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
      }}>
        {message}
      </pre>
      {error instanceof Error && error.stack && (
        <details style={{ maxWidth: '600px', width: '100%' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>Stack trace</summary>
          <pre style={{
            color: 'var(--text-tertiary)', fontSize: '11px',
            background: 'var(--bg-secondary)', padding: '12px', borderRadius: '6px',
            overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: '8px'
          }}>
            {error.stack}
          </pre>
        </details>
      )}
      <button
        onClick={() => window.location.reload()}
        style={{
          padding: '8px 16px', borderRadius: '6px', border: 'none',
          background: 'var(--accent-blue)', color: 'white', cursor: 'pointer'
        }}
      >
        Reload Page
      </button>
    </div>
  )
}

/**
 * Root layout - renders matched child route via Outlet.
 */
function RootLayout() {
  return (
    <div className="app">
      <Outlet />
      <GlobalProjectWidgets />
    </div>
  )
}

function GlobalProjectWidgets() {
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()

  const match = pathname.match(/^\/projects\/([^/]+)/)
  const encodedPath = match?.[1] ?? ''
  const projectPath = match ? decodeProjectPath(encodedPath) : ''

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
      contextType = 'terminal'
      contextLabel = 'Terminal'
    }
  } else if (isCodeRoute) {
    contextType = 'code'
    contextLabel = 'Code'
  }

  const sessionId = sessionMatch?.[1] || null

  const getContext = useCallback(async (): Promise<Omit<AIQueryContext, 'type'>> => {
    const base: Omit<AIQueryContext, 'type'> = { projectPath }

    if (contextType === 'terminal' && sessionId) {
      try {
        const session = await api.getSession(projectPath, sessionId)
        if (session.main?.tmuxPaneId) {
          return { ...base, terminalPaneId: session.main.tmuxPaneId }
        }
      } catch {
        // Fall through
      }
    }

    if (contextType === 'code') {
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

  // Don't render widgets on non-project routes
  if (!match) return null

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
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'orka-cmd-k') {
        setOpen(true)
      }
      // Clipboard write forwarded from terminal iframe (OSC 52).
      if (e.data?.type === 'orka-clipboard-write' && typeof e.data.text === 'string') {
        const text = e.data.text as string

        // execCommand fallback — works even without document focus on some browsers
        const tryExecCommand = (): boolean => {
          try {
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.position = 'fixed'
            ta.style.top = '0'
            ta.style.left = '0'
            ta.style.width = '2em'
            ta.style.height = '2em'
            ta.style.opacity = '0'
            ta.style.pointerEvents = 'none'
            ta.setAttribute('readonly', '')
            document.body.appendChild(ta)
            ta.focus()
            ta.select()
            ta.setSelectionRange(0, text.length)
            const ok = document.execCommand('copy')
            document.body.removeChild(ta)
            return ok
          } catch {
            return false
          }
        }

        // Try execCommand first (more reliable across focus states)
        if (tryExecCommand()) {
          return
        }

        // Fallback: Clipboard API (requires document focus)
        if (document.hasFocus() && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).catch(() => {})
        } else {
          // Wait for next focus event, then write
          const onFocus = () => {
            window.removeEventListener('focus', onFocus)
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(text).catch(() => tryExecCommand())
            } else {
              tryExecCommand()
            }
          }
          window.addEventListener('focus', onFocus)
        }
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

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<RootLayout />} errorElement={<RouteErrorPage />}>
      <Route path="/" element={<HomePage />} />
      <Route path="/dashboard" element={<ProjectDashboard />} />
      <Route path="/agents" element={<AgentCanvasPage />} />
      <Route path="/projects/:encodedPath" element={<Navigate to="/dashboard" replace />} />
      <Route path="/projects/:encodedPath/sessions/:sessionId" element={<SessionPage />} />
      <Route path="/projects/:encodedPath/code" element={<CodeEditorPage />} />
      <Route path="/projects/:encodedPath/files" element={<FilesPage />} />
      <Route path="/projects/:encodedPath/files/view" element={<FileViewerPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
  )
)

export function App() {
  return <RouterProvider router={router} />
}
