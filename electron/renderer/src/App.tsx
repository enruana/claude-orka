import { useState, useEffect } from 'react'
import { SessionTree } from './components/SessionTree'
import { SessionInfo } from './components/SessionInfo'
import { ActionPanel } from './components/ActionPanel'
import { ForkInfoModal } from './components/ForkInfoModal'
import type { Session } from '../../../src/models/Session'
import type { Fork } from '../../../src/models/Fork'
import './styles/global.css'

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [selectedNode, setSelectedNode] = useState<string>('main')
  const [loading, setLoading] = useState(true)
  const [showForkDialog, setShowForkDialog] = useState(false)
  const [forkNameInput, setForkNameInput] = useState('')
  const [isCreatingFork, setIsCreatingFork] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isMerging, setIsMerging] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [showForkInfo, setShowForkInfo] = useState(false)
  const [selectedForkInfo, setSelectedForkInfo] = useState<Fork | null>(null)

  useEffect(() => {
    // Request session data from main process
    window.electronAPI.getSession().then((sessionData) => {
      setSession(sessionData)
      setLoading(false)
    })

    // Listen for state updates
    window.electronAPI.onStateUpdate((updatedSession) => {
      setSession(updatedSession)
    })
  }, [])

  const handleNodeClick = async (nodeId: string) => {
    if (!session) return

    // Check if clicking on a closed/merged fork
    const fork = session.forks.find(f => f.id === nodeId)
    if (fork && (fork.status === 'closed' || fork.status === 'merged')) {
      // Show info modal instead of selecting
      setSelectedForkInfo(fork)
      setShowForkInfo(true)
      return
    }

    // Regular selection for active/saved forks and main
    setSelectedNode(nodeId)
    await window.electronAPI.selectNode(nodeId)
  }

  const handleCreateFork = () => {
    if (!session) {
      alert('No session available')
      return
    }

    // Count how many active forks have this node as parent
    const activeChildrenCount = session.forks.filter(
      f => f.parentId === selectedNode && f.status === 'active'
    ).length

    // Check if trying to create a fork when one already exists from this parent
    if (activeChildrenCount > 0) {
      const nodeName = selectedNode === 'main' ? 'MAIN' : session.forks.find(f => f.id === selectedNode)?.name || selectedNode
      alert(`Claude Code limitation: Only one active fork can exist from each branch.\n\nThe branch "${nodeName}" already has an active fork. Close or merge the existing fork first, or create a fork from it.`)
      return
    }

    setShowForkDialog(true)
  }

  const handleForkDialogSubmit = async () => {
    if (!forkNameInput.trim()) {
      alert('Please enter a fork name')
      return
    }

    setIsCreatingFork(true)
    try {
      await window.electronAPI.createFork(session!.id, forkNameInput, selectedNode)
      setShowForkDialog(false)
      setForkNameInput('')
      alert('Fork created successfully!')
    } catch (error) {
      alert(`Failed to create fork: ${error.message}`)
      console.error('Create fork error:', error)
    } finally {
      setIsCreatingFork(false)
    }
  }

  const handleForkDialogCancel = () => {
    setShowForkDialog(false)
    setForkNameInput('')
  }

  const handleExportFork = async () => {
    if (!session || selectedNode === 'main') return

    setIsExporting(true)
    try {
      await window.electronAPI.exportFork(session.id, selectedNode)
      alert('Export completed successfully!')
    } catch (error) {
      alert(`Export failed: ${error.message}`)
      console.error('Export error:', error)
    } finally {
      setIsExporting(false)
    }
  }

  const handleMergeFork = async () => {
    if (!session || selectedNode === 'main') return

    const confirm = window.confirm(
      `Are you sure you want to merge "${selectedNode}" to main?`
    )
    if (!confirm) return

    setIsMerging(true)
    try {
      await window.electronAPI.mergeFork(session.id, selectedNode)
      alert('Merge completed successfully!')
    } catch (error) {
      alert(`Merge failed: ${error.message}`)
      console.error('Merge error:', error)
    } finally {
      setIsMerging(false)
    }
  }

  const handleCloseFork = async () => {
    if (!session || selectedNode === 'main') return

    const fork = session.forks.find(f => f.id === selectedNode)
    const confirm = window.confirm(
      `Are you sure you want to close "${fork?.name || selectedNode}"?\n\nThe fork will be saved and can be resumed later, but it will no longer be active.`
    )
    if (!confirm) return

    setIsClosing(true)
    try {
      await window.electronAPI.closeFork(session.id, selectedNode)
      alert('Fork closed successfully!')
    } catch (error) {
      alert(`Close failed: ${error.message}`)
      console.error('Close error:', error)
    } finally {
      setIsClosing(false)
    }
  }

  const handleOpenExport = async () => {
    if (!selectedForkInfo?.contextPath) return

    try {
      await window.electronAPI.openExportFile(selectedForkInfo.contextPath)
    } catch (error) {
      alert(`Failed to open export file: ${error.message}`)
      console.error('Open export error:', error)
    }
  }

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
        <p>Loading session...</p>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="error">
        <p>No session data available</p>
      </div>
    )
  }

  const handleSaveAndClose = async () => {
    await window.electronAPI.saveAndClose()
  }

  const handleMinimize = async () => {
    await window.electronAPI.minimizeToTaskbar()
  }

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-text">🎭 Claude-Orka</span>
        <div className="titlebar-buttons">
          <button className="titlebar-button minimize" onClick={handleMinimize}>
            Minimize
          </button>
          <button className="titlebar-button save-close" onClick={handleSaveAndClose}>
            Save & Close
          </button>
        </div>
      </div>

      <SessionInfo session={session} />

      <div className="content">
        <SessionTree
          session={session}
          selectedNode={selectedNode}
          onNodeClick={handleNodeClick}
        />
      </div>

      <ActionPanel
        selectedNode={selectedNode}
        onCreateFork={handleCreateFork}
        onExportFork={handleExportFork}
        onMergeFork={handleMergeFork}
        onCloseFork={handleCloseFork}
        isCreatingFork={isCreatingFork}
        isExporting={isExporting}
        isMerging={isMerging}
        isClosing={isClosing}
        canCreateFork={session.forks.filter(f => f.parentId === selectedNode && f.status === 'active').length === 0}
        hasExport={selectedNode === 'main' ? false : !!session.forks.find(f => f.id === selectedNode)?.contextPath}
      />

      {showForkDialog && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Create New Fork</h3>
            <input
              type="text"
              value={forkNameInput}
              onChange={(e) => setForkNameInput(e.target.value)}
              placeholder="Enter fork name..."
              autoFocus
              disabled={isCreatingFork}
              onKeyPress={(e) => e.key === 'Enter' && !isCreatingFork && handleForkDialogSubmit()}
            />
            <div className="modal-buttons">
              <button
                onClick={handleForkDialogCancel}
                className="button-secondary"
                disabled={isCreatingFork}
              >
                Cancel
              </button>
              <button
                onClick={handleForkDialogSubmit}
                className="button-primary"
                disabled={isCreatingFork}
              >
                {isCreatingFork ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showForkInfo && selectedForkInfo && (
        <ForkInfoModal
          fork={selectedForkInfo}
          onClose={() => {
            setShowForkInfo(false)
            setSelectedForkInfo(null)
          }}
          onOpenExport={selectedForkInfo.status === 'merged' ? handleOpenExport : undefined}
        />
      )}
    </div>
  )
}
