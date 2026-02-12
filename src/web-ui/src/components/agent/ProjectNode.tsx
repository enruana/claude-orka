/**
 * ProjectNode - ReactFlow node for displaying a Project with live terminal
 */

import { memo, useState, useEffect, useRef, useCallback } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Terminal, Code, FolderOpen } from 'lucide-react'
import type { RegisteredProject, Session } from '../../api/client'

interface ProjectNodeData {
  project: RegisteredProject
  sessions?: Session[]
  onSelect?: (project: RegisteredProject, session?: Session) => void
}

// Helper to encode path for URL
function encodePathForUrl(path: string): string {
  return btoa(path).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function ProjectNodeComponent({ data, selected }: { data: { data: ProjectNodeData }; selected?: boolean }) {
  const { project, sessions, onSelect } = data.data
  const [activeSession, setActiveSession] = useState<Session | undefined>()
  const [isTerminalLoading, setIsTerminalLoading] = useState(true)
  const [terminalError, setTerminalError] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Generate URLs for session views
  const getSessionUrl = useCallback((tab: 'terminal' | 'code' | 'files') => {
    if (!activeSession) return null
    const encodedPath = encodePathForUrl(project.path)
    return `/projects/${encodedPath}/sessions/${activeSession.id}?tab=${tab}`
  }, [activeSession, project.path])

  const openInNewTab = useCallback((tab: 'terminal' | 'code' | 'files') => {
    const url = getSessionUrl(tab)
    if (url) {
      window.open(url, '_blank')
    }
  }, [getSessionUrl])

  useEffect(() => {
    // Find the first active session with a ttyd port
    const active = sessions?.find(s => s.status === 'active' && s.ttydPort)
    setActiveSession(active)
  }, [sessions])

  const handleSelectSession = (session: Session) => {
    setActiveSession(session)
    onSelect?.(project, session)
  }

  const activeSessions = sessions?.filter(s => s.status === 'active') || []
  const hasActiveSessions = activeSessions.length > 0

  // Memoize terminal URL to prevent unnecessary iframe reloads
  const [terminalUrl, setTerminalUrl] = useState<string | null>(null)
  const [currentPort, setCurrentPort] = useState<number | undefined>(undefined)

  useEffect(() => {
    const port = activeSession?.ttydPort
    // Only update URL if port actually changed
    if (port !== currentPort) {
      setCurrentPort(port)
      if (port) {
        // Use our terminal wrapper which routes WebSocket through the main server proxy
        // This works on mobile where individual ttyd ports aren't reachable
        const url = `/terminal/${port}?desktop=1`
        setTerminalUrl(url)
        setIsTerminalLoading(true)
        setTerminalError(false)
      } else {
        setTerminalUrl(null)
      }
    }
  }, [activeSession?.ttydPort, currentPort])

  return (
    <div className={`project-node ${selected ? 'selected' : ''}`} style={{ width: '420px', display: 'flex' }}>
      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="node-header">
          <span className="icon">📁</span>
          <span className="title">{project.name}</span>
        </div>

        <div className="node-status">
          <span className={`status-dot ${hasActiveSessions ? 'active' : 'idle'}`} />
          <span>
            {hasActiveSessions
              ? `${activeSessions.length} active session${activeSessions.length > 1 ? 's' : ''}`
              : 'No active sessions'}
          </span>
        </div>

        {/* Live Terminal Preview */}
        {terminalUrl && !terminalError ? (
          <div
            className="terminal-preview-live nodrag nopan nowheel"
            style={{
              position: 'relative',
              width: '100%',
              height: '200px',
              marginTop: '8px',
              borderRadius: '6px',
              overflow: 'hidden',
              background: '#11111b',
              cursor: 'text',
            }}
          >
            {isTerminalLoading && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: '#11111b',
                  color: '#6c7086',
                  fontSize: '0.75rem',
                  zIndex: 2,
                }}
              >
                <div style={{ textAlign: 'center' }}>
                  <div className="terminal-loading-spinner" style={{
                    width: '20px',
                    height: '20px',
                    border: '2px solid #313244',
                    borderTop: '2px solid #89b4fa',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                    margin: '0 auto 8px',
                  }} />
                  Loading terminal...
                </div>
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={terminalUrl}
              title={`Terminal - ${project.name}`}
              style={{
                border: 'none',
                transform: 'scale(0.4)',
                transformOrigin: 'top left',
                width: '250%',
                height: '250%',
              }}
              onLoad={() => setIsTerminalLoading(false)}
              onError={() => {
                setIsTerminalLoading(false)
                setTerminalError(true)
              }}
            />
            {/* Overlay to show it's a preview */}
            <div
              style={{
                position: 'absolute',
                bottom: '4px',
                right: '4px',
                background: 'rgba(0, 0, 0, 0.6)',
                color: '#a6e3a1',
                fontSize: '0.6rem',
                padding: '2px 6px',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <span style={{
                width: '6px',
                height: '6px',
                background: '#a6e3a1',
                borderRadius: '50%',
                animation: 'pulse 2s infinite',
              }} />
              LIVE
            </div>
          </div>
        ) : (
          <div
            className="terminal-preview"
            style={{
              background: '#11111b',
              borderRadius: '6px',
              padding: '12px',
              marginTop: '8px',
              fontFamily: 'monospace',
              fontSize: '0.7rem',
              color: '#6c7086',
              minHeight: '60px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
            }}
          >
            {hasActiveSessions ? (
              terminalError ? (
                <span>Terminal unavailable</span>
              ) : (
                <span>No terminal port available</span>
              )
            ) : (
              <span>Start a session to see terminal</span>
            )}
          </div>
        )}

        {/* Session selector */}
        {sessions && sessions.length > 0 && (
          <div className="node-content" style={{ marginTop: '8px' }}>
            <div style={{ fontSize: '0.7rem', marginBottom: '4px', color: '#a6adc8' }}>
              Sessions:
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '80px', overflowY: 'auto' }}>
              {sessions.slice(0, 5).map(session => (
                <div
                  key={session.id}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleSelectSession(session)
                  }}
                  style={{
                    padding: '4px 8px',
                    background: activeSession?.id === session.id
                      ? 'var(--accent-color, #89b4fa)'
                      : 'var(--bg-tertiary, #1e1e2e)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '0.7rem',
                    color: activeSession?.id === session.id
                      ? 'var(--bg-primary, #1e1e2e)'
                      : 'var(--text-primary, #cdd6f4)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    transition: 'background 0.2s',
                  }}
                >
                  <span
                    className={`status-dot ${session.status}`}
                    style={{
                      width: '6px',
                      height: '6px',
                      background: session.status === 'active' ? '#a6e3a1' : '#6c7086',
                      borderRadius: '50%',
                    }}
                  />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {session.name}
                  </span>
                  {session.ttydPort && (
                    <span style={{
                      fontSize: '0.6rem',
                      opacity: 0.7,
                      background: activeSession?.id === session.id ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.1)',
                      padding: '1px 4px',
                      borderRadius: '3px',
                    }}>
                      :{session.ttydPort}
                    </span>
                  )}
                </div>
              ))}
              {sessions.length > 5 && (
                <div style={{ fontSize: '0.65rem', color: '#6c7086', textAlign: 'center' }}>
                  +{sessions.length - 5} more
                </div>
              )}
            </div>
          </div>
        )}

        {/* Project path */}
        <div style={{
          fontSize: '0.65rem',
          color: '#6c7086',
          marginTop: '8px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {project.path}
        </div>
      </div>

      {/* Sidebar with action buttons */}
      {activeSession && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          marginLeft: '8px',
          paddingLeft: '8px',
          borderLeft: '1px solid #313244',
        }}>
          {/* Terminal button */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              openInNewTab('terminal')
            }}
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '6px',
              border: 'none',
              background: '#313244',
              color: '#a6e3a1',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.2s, transform 0.1s',
            }}
            title="Open Terminal"
            onMouseEnter={(e) => e.currentTarget.style.background = '#45475a'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#313244'}
          >
            <Terminal size={14} />
          </button>

          {/* Code button */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              openInNewTab('code')
            }}
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '6px',
              border: 'none',
              background: '#313244',
              color: '#89b4fa',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.2s, transform 0.1s',
            }}
            title="Open Code"
            onMouseEnter={(e) => e.currentTarget.style.background = '#45475a'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#313244'}
          >
            <Code size={14} />
          </button>

          {/* Files button */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              openInNewTab('files')
            }}
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '6px',
              border: 'none',
              background: '#313244',
              color: '#f9e2af',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.2s, transform 0.1s',
            }}
            title="Open Files"
            onMouseEnter={(e) => e.currentTarget.style.background = '#45475a'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#313244'}
          >
            <FolderOpen size={14} />
          </button>
        </div>
      )}

      {/* Per-branch output handles for connecting to agents */}
      {activeSession ? (
        <div style={{
          position: 'absolute',
          right: '-12px',
          top: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: '12px',
          pointerEvents: 'none',
        }}>
          {/* Main branch handle */}
          <div style={{ position: 'relative' }}>
            <Handle
              type="source"
              position={Position.Right}
              id={`main-${activeSession.id}`}
              style={{ position: 'relative', top: 'auto', transform: 'none' }}
            />
            <div style={{
              position: 'absolute',
              left: '16px',
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: '0.55rem',
              color: '#a6e3a1',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              background: '#1e1e2e',
              padding: '1px 4px',
              borderRadius: '3px',
              border: '1px solid #313244',
            }}>
              main
            </div>
          </div>
          {/* Active fork handles */}
          {activeSession.forks
            .filter(f => f.status === 'active')
            .map((fork) => (
              <div key={fork.id} style={{ position: 'relative' }}>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`fork-${fork.id}`}
                  style={{ position: 'relative', top: 'auto', transform: 'none' }}
                />
                <div style={{
                  position: 'absolute',
                  left: '16px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  fontSize: '0.55rem',
                  color: '#94e2d5',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  background: '#1e1e2e',
                  padding: '1px 4px',
                  borderRadius: '3px',
                  border: '1px solid #313244',
                }}>
                  {fork.name}
                </div>
              </div>
            ))}
        </div>
      ) : (
        <Handle type="source" position={Position.Right} />
      )}

      {/* Keyframes for animations */}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  )
}

export const ProjectNode = memo(ProjectNodeComponent)
