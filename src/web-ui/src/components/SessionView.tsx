import { useState, useEffect, useCallback, useRef } from 'react'
import { api, RegisteredProject, Session, Fork } from '../api/client'
import {
  ArrowLeft,
  Home,
  MessageSquarePlus,
  MessagesSquare,
  Square,
  FileText,
  RefreshCw,
  ExternalLink,
  LogOut,
  Power,
  Terminal,
  Code,
  ChevronDown,
  ChevronUp,
  GitBranch,
  FolderOpen,
  Mic,
} from 'lucide-react'
import { SessionCodeEditor, FileExplorer } from './code-editor'
import { encodeProjectPath } from './ProjectDashboard'
import { VoiceInputPopover } from './VoiceInputPopover'

type RightPanelTab = 'terminal' | 'code' | 'files'

interface SessionViewProps {
  project: RegisteredProject
  session: Session
  onBack: () => void
  onGoHome: () => void
  currentTab?: RightPanelTab
  onTabChange?: (tab: RightPanelTab) => void
}

interface TreeNode {
  id: string
  name: string
  status: string
  isMain: boolean
  children: TreeNode[]
  isClickable: boolean
}

export function SessionView({
  project,
  session: initialSession,
  onBack,
  onGoHome,
  currentTab = 'terminal',
  onTabChange
}: SessionViewProps) {
  const [session, setSession] = useState<Session>(initialSession)
  const [selectedNode, setSelectedNode] = useState<string>('main')
  const [error, setError] = useState<string | null>(null)
  const [showForkDialog, setShowForkDialog] = useState(false)
  const [forkNameInput, setForkNameInput] = useState('')
  const [isCreatingFork, setIsCreatingFork] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isMerging, setIsMerging] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [showThreadsOnMobile, setShowThreadsOnMobile] = useState(false)
  const [showThreadsPopover, setShowThreadsPopover] = useState(false)
  const [isTerminalLoading, setIsTerminalLoading] = useState(true)
  const [isTerminalTabDragOver, setIsTerminalTabDragOver] = useState(false)
  const [showVoicePopover, setShowVoicePopover] = useState(false)
  const terminalIframeRef = useRef<HTMLIFrameElement>(null)
  const threadsPopoverRef = useRef<HTMLDivElement>(null)

  // Use controlled tab from props, or local state as fallback
  const [localTab, setLocalTab] = useState<RightPanelTab>(currentTab)
  const rightPanelTab = onTabChange ? currentTab : localTab
  const setRightPanelTab = onTabChange || setLocalTab

  // Send input to terminal iframe via postMessage
  const sendInputToTerminal = useCallback((text: string) => {
    if (terminalIframeRef.current?.contentWindow) {
      terminalIframeRef.current.contentWindow.postMessage(
        { type: 'terminal-input', text },
        '*'
      )
    }
  }, [])

  // Handle drop on terminal tab
  const handleTerminalTabDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsTerminalTabDragOver(false)

    // Get the path from the drag data
    const internalPath = e.dataTransfer.getData('text/x-orka-path')
    const textPath = e.dataTransfer.getData('text/plain')
    const filePath = internalPath || textPath

    if (filePath) {
      // Quote path if it has spaces
      const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath

      // Switch to terminal tab
      setRightPanelTab('terminal')

      // Send the path to terminal after a short delay to ensure tab is switched
      setTimeout(() => {
        sendInputToTerminal(quotedPath)
        // Only focus on desktop - touch devices have virtual keyboard
        const isTouchDevice = window.matchMedia('(pointer: coarse)').matches ||
                              'ontouchstart' in window ||
                              navigator.maxTouchPoints > 0
        if (!isTouchDevice) {
          terminalIframeRef.current?.focus()
        }
      }, 100)
      return
    }

    // Handle external file drops (from OS file manager)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files)
      const encodedProject = btoa(project.path)
      const paths: string[] = []

      for (const file of files) {
        const formData = new FormData()
        formData.append('file', file)
        try {
          const res = await fetch(`/api/files/upload?project=${encodedProject}`, {
            method: 'POST',
            body: formData,
          })
          const data = await res.json()
          if (data.success) {
            paths.push(data.absolutePath.includes(' ') ? `"${data.absolutePath}"` : data.absolutePath)
          }
        } catch (err) {
          console.error('Upload failed:', err)
        }
      }

      if (paths.length > 0) {
        setRightPanelTab('terminal')
        setTimeout(() => {
          sendInputToTerminal(paths.join(' '))
        }, 100)
      }
    }
  }, [project.path, setRightPanelTab, sendInputToTerminal])

  // Focus terminal iframe when switching to terminal tab (desktop only)
  useEffect(() => {
    if (rightPanelTab === 'terminal' && terminalIframeRef.current) {
      // Don't auto-focus on touch devices - it triggers the keyboard
      // pointer: coarse catches most touch devices including iPad
      const isTouchDevice = window.matchMedia('(pointer: coarse)').matches ||
                            'ontouchstart' in window ||
                            navigator.maxTouchPoints > 0
      if (!isTouchDevice) {
        // Small delay to ensure iframe is visible
        setTimeout(() => {
          terminalIframeRef.current?.focus()
        }, 100)
      }
    }
  }, [rightPanelTab])

  // Reset terminal loading state when ttydPort changes
  useEffect(() => {
    if (session.ttydPort) {
      setIsTerminalLoading(true)
    }
  }, [session.ttydPort])

  // Update browser tab title with project name
  useEffect(() => {
    const projectName = project.path.split('/').pop() || project.path
    document.title = `${projectName} - Orka`

    // Restore default title when leaving
    return () => {
      document.title = 'Claude Orka'
    }
  }, [project.path])

  // Close threads popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showThreadsPopover && threadsPopoverRef.current && !threadsPopoverRef.current.contains(e.target as Node)) {
        setShowThreadsPopover(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showThreadsPopover])

  // Refresh session data
  const refreshSession = useCallback(async () => {
    try {
      const updated = await api.getSession(project.path, session.id)
      setSession(updated)
    } catch (err: any) {
      console.error('Failed to refresh session:', err)
    }
  }, [project.path, session.id])

  // Sync selected branch with tmux active pane
  const syncActiveBranch = useCallback(async () => {
    try {
      const activeBranch = await api.getActiveBranch(project.path, session.id)
      if (activeBranch && activeBranch !== selectedNode) {
        // Only update if the branch exists and is clickable
        if (activeBranch === 'main') {
          setSelectedNode(activeBranch)
        } else {
          const fork = session.forks.find((f) => f.id === activeBranch)
          if (fork && (fork.status === 'active' || fork.status === 'saved')) {
            setSelectedNode(activeBranch)
          }
        }
      }
    } catch (err: any) {
      // Silently ignore - this is just for sync
    }
  }, [project.path, session.id, session.forks, selectedNode])

  // Auto-refresh every 3 seconds
  useEffect(() => {
    const interval = setInterval(refreshSession, 3000)
    return () => clearInterval(interval)
  }, [refreshSession])

  // Sync active branch every second (faster for responsiveness)
  useEffect(() => {
    const interval = setInterval(syncActiveBranch, 1000)
    return () => clearInterval(interval)
  }, [syncActiveBranch])

  const handleNodeClick = async (nodeId: string) => {
    const fork = session.forks.find((f) => f.id === nodeId)
    if (fork && (fork.status === 'closed' || fork.status === 'merged')) {
      return
    }
    setSelectedNode(nodeId)

    // Select the pane in tmux
    try {
      await api.selectBranch(project.path, session.id, nodeId)
    } catch (err: any) {
      console.error('Failed to select branch:', err)
    }
  }

  const handleCreateFork = () => {
    const activeChildrenCount = session.forks.filter(
      (f) => f.parentId === selectedNode && f.status === 'active'
    ).length

    if (activeChildrenCount > 0) {
      const nodeName =
        selectedNode === 'main'
          ? 'MAIN'
          : session.forks.find((f) => f.id === selectedNode)?.name || selectedNode
      alert(
        `Claude Code limitation: Only one active thread can branch from each conversation.\n\nThe thread "${nodeName}" already has an active branch. Close or merge the existing thread first.`
      )
      return
    }

    setShowForkDialog(true)
  }

  const handleForkDialogSubmit = async () => {
    if (!forkNameInput.trim()) {
      alert('Please enter a thread name')
      return
    }

    setIsCreatingFork(true)
    try {
      await api.createFork(project.path, session.id, forkNameInput, selectedNode)
      setShowForkDialog(false)
      setForkNameInput('')
      await refreshSession()
    } catch (err: any) {
      alert(`Failed to create fork: ${err.message}`)
    } finally {
      setIsCreatingFork(false)
    }
  }

  const handleExportFork = async () => {
    if (selectedNode === 'main') return

    setIsExporting(true)
    try {
      await api.exportFork(project.path, session.id, selectedNode)
      await refreshSession()
      alert('Export completed!')
    } catch (err: any) {
      alert(`Export failed: ${err.message}`)
    } finally {
      setIsExporting(false)
    }
  }

  const handleMergeFork = async () => {
    if (selectedNode === 'main') return

    const fork = session.forks.find((f) => f.id === selectedNode)
    if (!confirm(`Merge "${fork?.name || selectedNode}" to main?`)) return

    setIsMerging(true)
    try {
      await api.mergeFork(project.path, session.id, selectedNode)
      await refreshSession()
      setSelectedNode('main')
      alert('Merge completed!')
    } catch (err: any) {
      alert(`Merge failed: ${err.message}`)
    } finally {
      setIsMerging(false)
    }
  }

  const handleCloseFork = async () => {
    if (selectedNode === 'main') return

    const fork = session.forks.find((f) => f.id === selectedNode)
    if (!confirm(`Close "${fork?.name || selectedNode}"?`)) return

    setIsClosing(true)
    try {
      await api.closeFork(project.path, session.id, selectedNode)
      await refreshSession()
      setSelectedNode('main')
    } catch (err: any) {
      alert(`Close failed: ${err.message}`)
    } finally {
      setIsClosing(false)
    }
  }

  const handleDetachSession = async () => {
    if (!confirm('Detach this session? The tmux session will keep running in the background.')) return
    try {
      await api.detachSession(project.path, session.id)
      onBack()
    } catch (err: any) {
      alert(`Failed to detach: ${err.message}`)
    }
  }

  const handleCloseSession = async () => {
    if (!confirm('Close this session? This will kill the tmux session and all processes.')) return
    try {
      await api.closeSession(project.path, session.id)
      onBack()
    } catch (err: any) {
      alert(`Failed to close: ${err.message}`)
    }
  }

  // Get terminal URL - uses our custom wrapper with virtual keyboard disabled for desktop
  const getTerminalUrl = () => {
    // Always use our wrapper to have consistent styling and disabled context menu
    // Include project path so the terminal can upload files
    return `/terminal/${session.ttydPort}?desktop=1&project=${btoa(project.path)}`
  }

  // Get mobile terminal URL - uses our custom wrapper with virtual keyboard
  const getMobileTerminalUrl = () => {
    return `/terminal/${session.ttydPort}`
  }

  const handleOpenTerminalInNewTab = () => {
    if (session.ttydPort) {
      // Check if mobile (same logic as CSS media query)
      const isMobile = window.matchMedia('(max-width: 768px)').matches ||
                       window.matchMedia('(pointer: coarse)').matches
      const url = isMobile ? getMobileTerminalUrl() : getTerminalUrl()
      window.open(url, '_blank')
    }
  }

  const encodedPath = encodeProjectPath(project.path)

  const handleOpenCodeInNewTab = () => {
    window.open(`/projects/${encodedPath}/code`, '_blank')
  }

  const selectedFork = session.forks.find((f) => f.id === selectedNode)
  const canCreateFork =
    session.forks.filter((f) => f.parentId === selectedNode && f.status === 'active').length === 0

  // Build tree data structure
  const buildTree = (nodeId: string): TreeNode => {
    const isMain = nodeId === 'main'
    const fork = isMain ? null : session.forks.find((f) => f.id === nodeId)
    const status = isMain ? session.status : fork?.status || 'active'
    const name = isMain ? 'main' : fork?.name || nodeId
    const children = session.forks
      .filter((f) => f.parentId === nodeId)
      .map((child) => buildTree(child.id))
    const isClickable = isMain || (fork !== null && (fork.status === 'active' || fork.status === 'saved'))

    return { id: nodeId, name, status, isMain, children, isClickable }
  }

  // Render the conversation threads tree
  const renderThreadTree = () => {
    const tree = buildTree('main')

    const renderNode = (
      node: TreeNode,
      depth: number = 0,
      isLast: boolean = true,
      parentLines: boolean[] = []
    ): JSX.Element => {
      const isSelected = selectedNode === node.id
      const hasChildren = node.children.length > 0

      return (
        <div key={node.id} className="thread-tree-node-wrapper">
          <div
            className={`thread-tree-node ${node.status} ${isSelected ? 'selected' : ''} ${node.isClickable ? 'clickable' : ''}`}
            onClick={() => node.isClickable && handleNodeClick(node.id)}
          >
            {/* Tree lines */}
            <div className="thread-tree-lines">
              {parentLines.map((showLine, index) => (
                <span key={index} className={`tree-line vertical ${showLine ? 'visible' : ''}`} />
              ))}
              {depth > 0 && (
                <>
                  <span className={`tree-line corner ${isLast ? 'last' : ''}`} />
                </>
              )}
            </div>

            {/* Node content */}
            <div className="thread-tree-node-content">
              <span className={`thread-node-dot ${node.status}`}>
                <span className="dot-inner" />
              </span>
              <span className="thread-node-name">{node.name}</span>
              {hasChildren && (
                <span className="thread-node-children-count">{node.children.length}</span>
              )}
            </div>
          </div>

          {/* Render children */}
          {hasChildren && (
            <div className="thread-tree-children">
              {node.children.map((child, index) => {
                const isLastChild = index === node.children.length - 1
                const newParentLines = [...parentLines, !isLast]
                return renderNode(child, depth + 1, isLastChild, newParentLines)
              })}
            </div>
          )}
        </div>
      )
    }

    return <div className="thread-tree">{renderNode(tree)}</div>
  }

  return (
    <div className="session-view-container">
      {/* Header */}
      <div className="session-header">
        <div className="header-left">
          <button className="icon-button" onClick={onBack} title="Back to project">
            <ArrowLeft size={18} />
          </button>
          <button className="icon-button desktop-only" onClick={onGoHome} title="Go home">
            <Home size={18} />
          </button>
          <div className="session-title">
            <span className="project-name mobile-only">{project.name}</span>
            <h1>{session.name || session.id}</h1>
            <span className={`status-badge ${session.status}`}>{session.status}</span>
          </div>
        </div>
        <div className="header-right desktop-only">
          <div className="threads-popover-container" ref={threadsPopoverRef}>
            <button
              className={`threads-button ${showThreadsPopover ? 'active' : ''}`}
              onClick={() => setShowThreadsPopover(!showThreadsPopover)}
              title="Threads"
            >
              <GitBranch size={16} />
              <span className="btn-text">
                {selectedNode === 'main' ? 'main' : selectedFork?.name || selectedNode}
              </span>
              <span className={`status-dot-small ${selectedNode === 'main' ? session.status : selectedFork?.status || 'active'}`} />
              {session.forks.length > 0 && (
                <span className="threads-count">{session.forks.length}</span>
              )}
              <ChevronDown size={14} className={`chevron ${showThreadsPopover ? 'rotated' : ''}`} />
            </button>

            {showThreadsPopover && (
              <div className="threads-popover">
                <div className="threads-popover-section">
                  <div className="threads-popover-header">
                    <h3>Threads</h3>
                  </div>
                  {renderThreadTree()}
                </div>

                <div className="threads-popover-section">
                  <div className="threads-popover-header">
                    <h3>Active: {selectedNode === 'main' ? 'main' : selectedFork?.name || selectedNode}</h3>
                    <span className={`status-badge small ${selectedNode === 'main' ? session.status : selectedFork?.status || 'active'}`}>
                      {selectedNode === 'main' ? session.status : selectedFork?.status || 'active'}
                    </span>
                  </div>
                </div>

                <div className="threads-popover-actions">
                  <button
                    className="popover-action-btn primary"
                    onClick={() => { handleCreateFork(); setShowThreadsPopover(false); }}
                    disabled={!canCreateFork || isCreatingFork}
                  >
                    <MessageSquarePlus size={14} />
                    {isCreatingFork ? 'Creating...' : 'New Thread'}
                  </button>

                  {selectedNode !== 'main' && (
                    <>
                      <button
                        className="popover-action-btn"
                        onClick={() => { handleExportFork(); setShowThreadsPopover(false); }}
                        disabled={isExporting}
                      >
                        <FileText size={14} />
                        {isExporting ? 'Summarizing...' : 'Summarize'}
                      </button>
                      <button
                        className="popover-action-btn"
                        onClick={() => { handleMergeFork(); setShowThreadsPopover(false); }}
                        disabled={isMerging}
                      >
                        <MessagesSquare size={14} />
                        {isMerging ? 'Merging...' : 'Merge'}
                      </button>
                      <button
                        className="popover-action-btn danger"
                        onClick={() => { handleCloseFork(); setShowThreadsPopover(false); }}
                        disabled={isClosing}
                      >
                        <Square size={14} />
                        {isClosing ? 'Closing...' : 'Close'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
          <button className="icon-button" onClick={refreshSession} title="Refresh">
            <RefreshCw size={18} />
          </button>
          <button className="detach-button" onClick={handleDetachSession} title="Detach (keep tmux running)">
            <LogOut size={16} />
            <span className="btn-text">Detach</span>
          </button>
          <button className="close-button" onClick={handleCloseSession} title="Close (kill tmux)">
            <Power size={16} />
            <span className="btn-text">Close</span>
          </button>
        </div>
        <div className="header-right mobile-only">
          <button className="icon-button" onClick={refreshSession} title="Refresh">
            <RefreshCw size={18} />
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Mobile Layout */}
      <div className="mobile-session-view mobile-only">
        {/* Quick Actions */}
        <div className="mobile-quick-actions">
          <button
            className="mobile-action-card terminal"
            onClick={() => window.open(getMobileTerminalUrl(), '_blank')}
            disabled={!session.ttydPort}
          >
            <Terminal size={28} />
            <span>Claude Code</span>
          </button>
          <button
            className="mobile-action-card code"
            onClick={handleOpenCodeInNewTab}
          >
            <Code size={28} />
            <span>Code</span>
          </button>
          <button
            className="mobile-action-card files"
            onClick={() => window.open(`/projects/${encodedPath}/files`, '_blank')}
          >
            <FolderOpen size={28} />
            <span>Files</span>
          </button>
        </div>

        {/* Thread Info Card */}
        <div className="mobile-info-card">
          <div className="mobile-info-header" onClick={() => setShowThreadsOnMobile(!showThreadsOnMobile)}>
            <div className="mobile-info-title">
              <GitBranch size={16} />
              <span>Active: {selectedNode === 'main' ? 'main' : selectedFork?.name || selectedNode}</span>
              <span className={`status-dot ${selectedNode === 'main' ? session.status : selectedFork?.status || 'active'}`} />
            </div>
            <div className="mobile-info-toggle">
              <span className="thread-count">{session.forks.length} threads</span>
              {showThreadsOnMobile ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </div>
          </div>

          {showThreadsOnMobile && (
            <div className="mobile-threads-expanded">
              {renderThreadTree()}
              <div className="mobile-thread-actions">
                <button
                  className="action-btn-full primary"
                  onClick={handleCreateFork}
                  disabled={!canCreateFork || isCreatingFork}
                >
                  <MessageSquarePlus size={16} />
                  {isCreatingFork ? 'Creating...' : 'New Thread'}
                </button>
                {selectedNode !== 'main' && (
                  <>
                    <button className="action-btn-full" onClick={handleExportFork} disabled={isExporting}>
                      <FileText size={16} />
                      {isExporting ? 'Summarizing...' : 'Summarize'}
                    </button>
                    <button className="action-btn-full" onClick={handleMergeFork} disabled={isMerging}>
                      <MessagesSquare size={16} />
                      {isMerging ? 'Merging...' : 'Merge to Main'}
                    </button>
                    <button className="action-btn-full danger" onClick={handleCloseFork} disabled={isClosing}>
                      <Square size={16} />
                      {isClosing ? 'Closing...' : 'Close Thread'}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Session Controls */}
        <div className="mobile-session-controls">
          <button className="mobile-control-btn detach" onClick={handleDetachSession}>
            <LogOut size={18} />
            <span>Detach Session</span>
          </button>
          <button className="mobile-control-btn close" onClick={handleCloseSession}>
            <Power size={18} />
            <span>Close Session</span>
          </button>
        </div>
      </div>

      {/* Desktop layout - full width panel */}
      <div className="session-panels desktop-only">
        {/* Main Panel - Terminal/Code/Files */}
        <div className="main-panel">
          {/* Panel Tabs */}
          <div className="right-panel-tabs">
            <button
              className={`panel-tab ${rightPanelTab === 'terminal' ? 'active' : ''} ${isTerminalTabDragOver ? 'drag-over' : ''}`}
              onClick={() => setRightPanelTab('terminal')}
              onDragOver={(e) => {
                e.preventDefault()
                setIsTerminalTabDragOver(true)
              }}
              onDragEnter={(e) => {
                e.preventDefault()
                setIsTerminalTabDragOver(true)
              }}
              onDragLeave={() => setIsTerminalTabDragOver(false)}
              onDrop={handleTerminalTabDrop}
            >
              <Terminal size={14} />
              <span>Claude Code</span>
              {isTerminalTabDragOver && <span className="drop-hint">Drop here</span>}
            </button>
            <button
              className={`panel-tab ${rightPanelTab === 'code' ? 'active' : ''}`}
              onClick={() => setRightPanelTab('code')}
            >
              <Code size={14} />
              <span>Code</span>
            </button>
            <button
              className={`panel-tab ${rightPanelTab === 'files' ? 'active' : ''}`}
              onClick={() => setRightPanelTab('files')}
            >
              <FolderOpen size={14} />
              <span>Files</span>
            </button>
            <div className="panel-tab-spacer" />
            {rightPanelTab === 'terminal' && session.ttydPort && (
              <button
                className="icon-button"
                onClick={handleOpenTerminalInNewTab}
                title="Open Claude Code in new tab"
              >
                <ExternalLink size={14} />
              </button>
            )}
            {rightPanelTab === 'code' && (
              <button
                className="icon-button"
                onClick={handleOpenCodeInNewTab}
                title="Open Code in new tab"
              >
                <ExternalLink size={14} />
              </button>
            )}
          </div>

          {/* Panel Content - All tabs stay mounted to preserve state */}
          <div className="right-panel-content">
            <div
              className={`terminal-wrapper ${rightPanelTab === 'terminal' ? 'tab-visible' : 'tab-hidden'}`}
              onContextMenu={(e) => e.preventDefault()}
            >
              {session.ttydPort ? (
                <>
                  {isTerminalLoading && (
                    <div className="terminal-loading-overlay">
                      <div className="terminal-loading-spinner" />
                      <p>Loading terminal...</p>
                    </div>
                  )}
                  <iframe
                    ref={terminalIframeRef}
                    src={getTerminalUrl()}
                    title="Claude Code"
                    className="terminal-iframe"
                    allow="clipboard-read; clipboard-write"
                    tabIndex={rightPanelTab === 'terminal' ? 0 : -1}
                    onLoad={() => {
                      setIsTerminalLoading(false)
                      // Don't auto-focus on touch devices - triggers keyboard
                      const isTouchDevice = window.matchMedia('(pointer: coarse)').matches ||
                                            'ontouchstart' in window ||
                                            navigator.maxTouchPoints > 0
                      if (!isTouchDevice && rightPanelTab === 'terminal') {
                        terminalIframeRef.current?.focus()
                      }
                    }}
                    onContextMenu={(e) => e.preventDefault()}
                  />
                  {/* Floating voice button + popover */}
                  <div className="voice-fab-container">
                    <VoiceInputPopover
                      isOpen={showVoicePopover}
                      onClose={() => setShowVoicePopover(false)}
                      onSend={(text) => {
                        sendInputToTerminal(text)
                        setTimeout(() => terminalIframeRef.current?.focus(), 100)
                      }}
                      sendLabel="Send to Terminal"
                    />
                    <button
                      className="voice-fab"
                      onClick={() => setShowVoicePopover(!showVoicePopover)}
                      title="Voice input"
                    >
                      <Mic size={20} />
                    </button>
                  </div>
                </>
              ) : (
                <div className="terminal-placeholder">
                  <p>Claude Code not available</p>
                  <p className="hint">Session may need to be resumed</p>
                </div>
              )}
            </div>
            <div className={`code-editor-wrapper ${rightPanelTab === 'code' ? 'tab-visible' : 'tab-hidden'}`}>
              <SessionCodeEditor
                projectPath={project.path}
                encodedPath={encodedPath}
                onOpenInNewTab={handleOpenCodeInNewTab}
              />
            </div>
            <div className={`file-explorer-wrapper ${rightPanelTab === 'files' ? 'tab-visible' : 'tab-hidden'}`}>
              <FileExplorer
                projectPath={project.path}
                encodedPath={encodedPath}
              />
            </div>
          </div>
        </div>
      </div>

      {/* New Thread Dialog */}
      {showForkDialog && (
        <div className="modal-overlay" onClick={() => setShowForkDialog(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New Conversation Thread</h3>
            <p className="modal-subtitle">
              Branching from: <strong>{selectedNode === 'main' ? 'main' : selectedFork?.name || selectedNode}</strong>
            </p>
            <input
              type="text"
              value={forkNameInput}
              onChange={(e) => setForkNameInput(e.target.value)}
              placeholder="Thread name (e.g. 'explore auth options')"
              autoFocus
              onKeyPress={(e) => e.key === 'Enter' && handleForkDialogSubmit()}
            />
            <div className="modal-buttons">
              <button className="button-secondary" onClick={() => setShowForkDialog(false)}>
                Cancel
              </button>
              <button
                className="button-primary"
                onClick={handleForkDialogSubmit}
                disabled={isCreatingFork}
              >
                {isCreatingFork ? 'Creating...' : 'Create Thread'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
