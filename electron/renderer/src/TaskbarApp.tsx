import { useState, useEffect } from 'react'
import { FolderOpen, Terminal, Maximize2 } from 'lucide-react'
import type { Session } from '../../../src/models/Session'
import './styles/taskbar.css'

export function TaskbarApp() {
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    // Listen for session data updates
    window.electronAPI.onSessionData((sessionData) => {
      setSession(sessionData)
    })
  }, [])

  // Calculate and update taskbar height based on content
  useEffect(() => {
    if (!session) return

    // Calculate total branches (main + all forks)
    const totalBranches = 1 + session.forks.length

    // Base height: 3 icon buttons (44px each with gap) + top/bottom padding (24px total) + separator
    const baseHeight = 168

    // Branch tree height: each branch item is ~16px (12px height + 4px gap)
    const branchTreeHeight = totalBranches * 16 + 24 // +24 for padding and spacing

    const totalHeight = baseHeight + branchTreeHeight

    // Update window size
    window.electronAPI.resizeTaskbar(totalHeight).catch(error => {
      console.error('Error resizing taskbar:', error)
    })
  }, [session])

  const handleOpenFolder = async () => {
    try {
      await window.electronAPI.openProjectFolder()
    } catch (error) {
      console.error('Error opening project folder:', error)
    }
  }

  const handleFocusTerminal = async () => {
    try {
      await window.electronAPI.focusTerminal()
    } catch (error) {
      console.error('Error focusing terminal:', error)
    }
  }

  const handleRestore = async () => {
    try {
      await window.electronAPI.restoreFromTaskbar()
    } catch (error) {
      console.error('Error restoring window:', error)
    }
  }

  // Build branch tree structure
  const getBranchTree = () => {
    if (!session) return []

    const tree: Array<{ id: string; name: string; status: string; level: number }> = []

    // Add main branch
    tree.push({
      id: 'main',
      name: 'MAIN',
      status: session.main?.status || 'active',
      level: 0,
    })

    // Add forks recursively
    const addForks = (parentId: string, level: number) => {
      const forks = session.forks.filter(f => f.parentId === parentId)
      forks.forEach(fork => {
        tree.push({
          id: fork.id,
          name: fork.name,
          status: fork.status,
          level,
        })
        // Recursively add child forks
        addForks(fork.id, level + 1)
      })
    }

    addForks('main', 1)

    return tree
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return '#a6e3a1' // green
      case 'saved':
        return '#f9e2af' // yellow
      case 'merged':
        return '#94e2d5' // cyan
      case 'closed':
        return '#6c7086' // gray
      default:
        return '#cdd6f4' // default
    }
  }

  const branchTree = getBranchTree()

  return (
    <div className="taskbar">
      <button
        className="taskbar-icon"
        onClick={handleRestore}
        title="Restore window"
      >
        <Maximize2 size={20} />
      </button>

      <button
        className="taskbar-icon"
        onClick={handleOpenFolder}
        title="Open project folder"
      >
        <FolderOpen size={20} />
      </button>

      <button
        className="taskbar-icon"
        onClick={handleFocusTerminal}
        title="Focus terminal"
      >
        <Terminal size={20} />
      </button>

      {branchTree.length > 0 && (
        <div className="branch-tree">
          {branchTree.map((branch, index) => (
            <div key={branch.id} className="branch-item">
              {branch.level > 0 && (
                <div className="branch-line" style={{ left: `${branch.level * 8}px` }} />
              )}
              <div
                className="branch-dot"
                style={{
                  backgroundColor: getStatusColor(branch.status),
                  marginLeft: `${branch.level * 8}px`,
                }}
                title={`${branch.name} (${branch.status})`}
              />
              {index < branchTree.length - 1 && branchTree[index + 1].level > branch.level && (
                <div
                  className="branch-connector"
                  style={{ left: `${branch.level * 8 + 4}px` }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
