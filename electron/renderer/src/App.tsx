import { useState, useEffect } from 'react'
import { SessionTree } from './components/SessionTree'
import { SessionInfo } from './components/SessionInfo'
import { ActionPanel } from './components/ActionPanel'
import type { Session } from '../../../src/models/Session'
import './styles/global.css'

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [selectedNode, setSelectedNode] = useState<string>('main')
  const [loading, setLoading] = useState(true)

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
    setSelectedNode(nodeId)
    await window.electronAPI.selectNode(nodeId)
  }

  const handleCreateFork = async () => {
    if (!session) return

    const forkName = prompt('Enter fork name:')
    if (!forkName) return

    await window.electronAPI.createFork(session.id, forkName)
  }

  const handleExportFork = async () => {
    if (!session || selectedNode === 'main') return
    await window.electronAPI.exportFork(session.id, selectedNode)
  }

  const handleMergeFork = async () => {
    if (!session || selectedNode === 'main') return

    const confirm = window.confirm(
      `Are you sure you want to merge "${selectedNode}" to main?`
    )
    if (!confirm) return

    await window.electronAPI.mergeFork(session.id, selectedNode)
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

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-text">🎭 Claude-Orka</span>
        <button className="titlebar-button" onClick={() => window.electronAPI.closeWindow()}>
          ✕
        </button>
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
      />
    </div>
  )
}
