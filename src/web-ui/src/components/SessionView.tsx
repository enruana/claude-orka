import { useState, useEffect, useCallback } from 'react'
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
} from 'lucide-react'
import { SessionCodeEditor } from './code-editor'
import { encodeProjectPath } from './ProjectDashboard'

interface SessionViewProps {
  project: RegisteredProject
  session: Session
  onBack: () => void
  onGoHome: () => void
}

interface TreeNode {
  id: string
  name: string
  status: string
  isMain: boolean
  children: TreeNode[]
  isClickable: boolean
}

type RightPanelTab = 'terminal' | 'code'

export function SessionView({ project, session: initialSession, onBack, onGoHome }: SessionViewProps) {
  const [session, setSession] = useState<Session>(initialSession)
  const [selectedNode, setSelectedNode] = useState<string>('main')
  const [error, setError] = useState<string | null>(null)
  const [showForkDialog, setShowForkDialog] = useState(false)
  const [forkNameInput, setForkNameInput] = useState('')
  const [isCreatingFork, setIsCreatingFork] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isMerging, setIsMerging] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('terminal')

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

  // Use current hostname so it works from other devices (phone, etc)
  const getTerminalUrl = () => {
    const host = window.location.hostname
    return `http://${host}:${session.ttydPort}`
  }

  const handleOpenTerminalInNewTab = () => {
    if (session.ttydPort) {
      window.open(getTerminalUrl(), '_blank')
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
            <h1>{session.name || session.id}</h1>
            <span className={`status-badge ${session.status}`}>{session.status}</span>
          </div>
        </div>
        <div className="header-right">
          {session.ttydPort && (
            <button
              className="icon-button terminal-btn mobile-only"
              onClick={handleOpenTerminalInNewTab}
              title="Open Terminal"
            >
              <ExternalLink size={18} />
            </button>
          )}
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
      </div>

      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Two-panel layout */}
      <div className="session-panels">
        {/* Left Panel - Thread Tree & Actions */}
        <div className="left-panel">
          <div className="panel-section">
            <div className="panel-header">
              <h2>Threads</h2>
            </div>
            {renderThreadTree()}
          </div>

          {/* Selected thread info */}
          <div className="panel-section selected-info">
            <div className="panel-header">
              <h2>Active Thread</h2>
            </div>
            <div className="selected-thread-card">
              <span className={`thread-node-dot large ${selectedNode === 'main' ? session.status : selectedFork?.status || 'active'}`}>
                <span className="dot-inner" />
              </span>
              <div className="selected-thread-info">
                <span className="selected-thread-name">
                  {selectedNode === 'main' ? 'main' : selectedFork?.name || selectedNode}
                </span>
                <span className={`selected-thread-status ${selectedNode === 'main' ? session.status : selectedFork?.status || 'active'}`}>
                  {selectedNode === 'main' ? session.status : selectedFork?.status || 'active'}
                </span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="panel-section actions-section">
            <div className="panel-header">
              <h2>Actions</h2>
            </div>
            <div className="action-buttons-vertical">
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
                  <button
                    className="action-btn-full"
                    onClick={handleExportFork}
                    disabled={isExporting}
                  >
                    <FileText size={16} />
                    {isExporting ? 'Summarizing...' : 'Summarize'}
                  </button>
                  <button
                    className="action-btn-full"
                    onClick={handleMergeFork}
                    disabled={isMerging}
                  >
                    <MessagesSquare size={16} />
                    {isMerging ? 'Merging...' : 'Merge to Main'}
                  </button>
                  <button
                    className="action-btn-full danger"
                    onClick={handleCloseFork}
                    disabled={isClosing}
                  >
                    <Square size={16} />
                    {isClosing ? 'Closing...' : 'Close Thread'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right Panel - Terminal/Code */}
        <div className="right-panel">
          {/* Panel Tabs */}
          <div className="right-panel-tabs">
            <button
              className={`panel-tab ${rightPanelTab === 'terminal' ? 'active' : ''}`}
              onClick={() => setRightPanelTab('terminal')}
            >
              <Terminal size={14} />
              <span>Terminal</span>
            </button>
            <button
              className={`panel-tab ${rightPanelTab === 'code' ? 'active' : ''}`}
              onClick={() => setRightPanelTab('code')}
            >
              <Code size={14} />
              <span>Code</span>
            </button>
            <div className="panel-tab-spacer" />
            {rightPanelTab === 'terminal' && session.ttydPort && (
              <button
                className="icon-button"
                onClick={handleOpenTerminalInNewTab}
                title="Open Terminal in new tab"
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

          {/* Panel Content */}
          <div className="right-panel-content">
            {rightPanelTab === 'terminal' ? (
              <div className="terminal-wrapper">
                {session.ttydPort ? (
                  <>
                    {/* Desktop: show iframe */}
                    <iframe
                      src={getTerminalUrl()}
                      title="Terminal"
                      className="terminal-iframe desktop-only"
                    />
                    {/* Mobile: show message and button */}
                    <div className="terminal-mobile-message mobile-only">
                      <p>Terminal not available in mobile view</p>
                      <p className="hint">Open in a dedicated window for the best experience</p>
                      <button
                        className="action-btn-full primary"
                        onClick={handleOpenTerminalInNewTab}
                      >
                        <ExternalLink size={16} />
                        Open Terminal
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="terminal-placeholder">
                    <p>Terminal not available</p>
                    <p className="hint">Session may need to be resumed</p>
                  </div>
                )}
              </div>
            ) : (
              <>
                {/* Desktop: show code editor inline */}
                <div className="code-editor-wrapper desktop-only">
                  <SessionCodeEditor
                    projectPath={project.path}
                    encodedPath={encodedPath}
                    onOpenInNewTab={handleOpenCodeInNewTab}
                  />
                </div>
                {/* Mobile: show message and button */}
                <div className="terminal-mobile-message mobile-only">
                  <p>Code Editor not available in mobile view</p>
                  <p className="hint">Open in a dedicated window for the best experience</p>
                  <button
                    className="action-btn-full primary"
                    onClick={handleOpenCodeInNewTab}
                  >
                    <ExternalLink size={16} />
                    Open Code Editor
                  </button>
                </div>
              </>
            )}
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
