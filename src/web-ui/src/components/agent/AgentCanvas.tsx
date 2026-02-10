/**
 * AgentCanvas - ReactFlow canvas for managing agents and project connections
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  Connection,
  Edge,
  Node,
  BackgroundVariant,
  NodeChange,
  NodePositionChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { AgentNode } from './AgentNode'
import { ProjectNode } from './ProjectNode'
import { ConnectionEdge } from './ConnectionEdge'
import { AgentConfigModal } from './AgentConfigModal'
import { AgentLogsModal } from './AgentLogsModal'
import { agentsApi, Agent, CreateAgentOptions } from '../../api/agents'
import { api, RegisteredProject, Session } from '../../api/client'

// Custom node types
const nodeTypes = {
  agent: AgentNode,
  project: ProjectNode,
}

// Custom edge types
const edgeTypes = {
  connection: ConnectionEdge,
}

interface AgentCanvasProps {
  className?: string
}

// Store positions in localStorage
const POSITIONS_KEY = 'orka-agent-canvas-positions'

function loadPositions(): Record<string, { x: number; y: number }> {
  try {
    const stored = localStorage.getItem(POSITIONS_KEY)
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

function savePositions(positions: Record<string, { x: number; y: number }>) {
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions))
  } catch {
    // Ignore storage errors
  }
}

function AgentCanvasInner({ className }: AgentCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const { setCenter } = useReactFlow()
  const [agents, setAgents] = useState<Agent[]>([])
  const [projects, setProjects] = useState<RegisteredProject[]>([])
  const [projectSessions, setProjectSessions] = useState<Record<string, Session[]>>({})
  const [modalOpen, setModalOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)
  const [logsModalOpen, setLogsModalOpen] = useState(false)
  const [viewingLogsAgent, setViewingLogsAgent] = useState<Agent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Store node positions - persisted to localStorage
  const nodePositionsRef = useRef<Record<string, { x: number; y: number }>>(loadPositions())

  // Track if initial load is done
  const initialLoadDone = useRef(false)

  // Handle node position changes - save to ref and localStorage
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    // Call the original handler
    onNodesChange(changes)

    // Update positions for position changes
    changes.forEach(change => {
      if (change.type === 'position' && change.position) {
        const posChange = change as NodePositionChange
        if (posChange.position) {
          nodePositionsRef.current[change.id] = posChange.position
        }
      }
    })

    // Save to localStorage (debounced by React's batching)
    savePositions(nodePositionsRef.current)
  }, [onNodesChange])

  // Agent actions - defined before buildNodes to avoid dependency issues
  const handleStartAgent = useCallback(
    async (agentId: string) => {
      try {
        await agentsApi.start(agentId)
      } catch (err: any) {
        setError(`Failed to start agent: ${err.message}`)
      }
    },
    []
  )

  const handleStopAgent = useCallback(
    async (agentId: string) => {
      try {
        await agentsApi.stop(agentId)
      } catch (err: any) {
        setError(`Failed to stop agent: ${err.message}`)
      }
    },
    []
  )

  const handlePauseAgent = useCallback(
    async (agentId: string) => {
      try {
        await agentsApi.pause(agentId)
      } catch (err: any) {
        setError(`Failed to pause agent: ${err.message}`)
      }
    },
    []
  )

  const handleResumeAgent = useCallback(
    async (agentId: string) => {
      try {
        await agentsApi.resume(agentId)
      } catch (err: any) {
        setError(`Failed to resume agent: ${err.message}`)
      }
    },
    []
  )

  const handleEditAgent = useCallback((agent: Agent) => {
    setEditingAgent(agent)
    setModalOpen(true)
  }, [])

  const handleViewLogs = useCallback((agent: Agent) => {
    setViewingLogsAgent(agent)
    setLogsModalOpen(true)
  }, [])

  const handleTriggerAgent = useCallback(
    async (agentId: string) => {
      try {
        await agentsApi.trigger(agentId)
      } catch (err: any) {
        setError(`Failed to trigger agent: ${err.message}`)
      }
    },
    []
  )

  const handleDeleteAgent = useCallback(
    async (agentId: string) => {
      try {
        await agentsApi.delete(agentId)
        // Remove position from storage
        delete nodePositionsRef.current[`agent-${agentId}`]
        savePositions(nodePositionsRef.current)
      } catch (err: any) {
        setError(`Failed to delete agent: ${err.message}`)
      }
    },
    []
  )

  // Note: We don't call loadData here to avoid circular dependency
  // The periodic refresh will update the UI
  const handleDisconnectAgent = useCallback(
    async (agentId: string) => {
      try {
        await agentsApi.disconnect(agentId)
        // Remove the edge immediately for better UX
        setEdges(eds => eds.filter(e => e.target !== `agent-${agentId}`))
      } catch (err: any) {
        setError(`Failed to disconnect agent: ${err.message}`)
      }
    },
    [setEdges]
  )

  const handleProjectSelect = useCallback(
    (_project: RegisteredProject, _session?: Session) => {
      // Could be used to update connection with specific session
    },
    []
  )

  // Build nodes from data - preserving positions
  const buildNodes = useCallback(
    (
      agentsData: Agent[],
      projectsData: RegisteredProject[],
      sessionsMap: Record<string, Session[]>
    ) => {
      const newNodes: Node[] = []
      const newEdges: Edge[] = []
      const positions = nodePositionsRef.current

      // Add project nodes on the left
      projectsData.forEach((project, index) => {
        const nodeId = `project-${project.path}`
        const defaultPos = { x: 100, y: 100 + index * 300 }
        const position = positions[nodeId] || defaultPos

        // Save default position if not exists
        if (!positions[nodeId]) {
          positions[nodeId] = defaultPos
        }

        newNodes.push({
          id: nodeId,
          type: 'project',
          position,
          data: {
            data: {
              project,
              sessions: sessionsMap[project.path] || [],
              onSelect: handleProjectSelect,
            },
          },
        })
      })

      // Add agent nodes on the right
      agentsData.forEach((agent, index) => {
        const nodeId = `agent-${agent.id}`
        const defaultPos = { x: 550, y: 100 + index * 350 }
        const position = positions[nodeId] || defaultPos

        // Save default position if not exists
        if (!positions[nodeId]) {
          positions[nodeId] = defaultPos
        }

        newNodes.push({
          id: nodeId,
          type: 'agent',
          position,
          data: {
            data: {
              agent,
              onStart: handleStartAgent,
              onStop: handleStopAgent,
              onPause: handlePauseAgent,
              onResume: handleResumeAgent,
              onEdit: handleEditAgent,
              onDelete: handleDeleteAgent,
              onViewLogs: handleViewLogs,
              onTrigger: handleTriggerAgent,
            },
          },
        })

        // Add edge if agent is connected to a project
        if (agent.connection) {
          const branchId = agent.connection.branchId || 'main'
          const connSessionId = agent.connection.sessionId
          const sourceHandle = connSessionId
            ? (branchId === 'main' ? `main-${connSessionId}` : `fork-${branchId}`)
            : undefined

          newEdges.push({
            id: `edge-${agent.id}`,
            source: `project-${agent.connection.projectPath}`,
            sourceHandle,
            target: `agent-${agent.id}`,
            type: 'connection',
            animated: agent.status === 'active',
            style: { stroke: agent.status === 'active' ? '#a6e3a1' : '#89b4fa' },
            data: {
              agentId: agent.id,
              onDisconnect: handleDisconnectAgent,
              isActive: agent.status === 'active',
            },
          })
        }
      })

      // Save positions
      savePositions(positions)

      setNodes(newNodes)
      setEdges(newEdges)
    },
    [handleStartAgent, handleStopAgent, handlePauseAgent, handleResumeAgent, handleEditAgent, handleDeleteAgent, handleDisconnectAgent, handleViewLogs, handleTriggerAgent, handleProjectSelect, setNodes, setEdges]
  )

  // Load data without rebuilding positions
  const loadData = useCallback(async () => {
    try {
      if (!initialLoadDone.current) {
        setLoading(true)
      }
      setError(null)

      const [agentsData, projectsData] = await Promise.all([
        agentsApi.list(),
        api.listProjects(),
      ])

      setAgents(agentsData)
      setProjects(projectsData)

      // Load sessions for each project
      const sessionsMap: Record<string, Session[]> = {}
      for (const project of projectsData) {
        try {
          const sessions = await api.listSessions(project.path)
          sessionsMap[project.path] = sessions
        } catch {
          sessionsMap[project.path] = []
        }
      }
      setProjectSessions(sessionsMap)

      // Build/update nodes
      buildNodes(agentsData, projectsData, sessionsMap)
      initialLoadDone.current = true
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [buildNodes])

  // Initial load
  useEffect(() => {
    loadData()
  }, [loadData])

  // Refresh periodically - only update data, not positions
  useEffect(() => {
    const interval = setInterval(loadData, 5000)
    return () => clearInterval(interval)
  }, [loadData])

  // Handle new connections
  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!connection.source || !connection.target) return

      // Determine which node is the project and which is the agent
      // Connection can be in either direction
      let projectNodeId: string | null = null
      let agentNodeId: string | null = null

      if (connection.source.startsWith('project-')) {
        projectNodeId = connection.source
        agentNodeId = connection.target
      } else if (connection.target.startsWith('project-')) {
        projectNodeId = connection.target
        agentNodeId = connection.source
      }

      if (!projectNodeId || !agentNodeId) return

      // Extract actual IDs
      const projectPath = projectNodeId.replace('project-', '')
      const agentId = agentNodeId.replace('agent-', '')

      // Find the project and agent
      const project = projects.find(p => p.path === projectPath)
      const agent = agents.find(a => a.id === agentId)

      if (!project || !agent) {
        console.error('Could not find project or agent:', { projectPath, agentId, projects, agents })
        setError('Could not find project or agent')
        return
      }

      try {
        // Extract branch info from sourceHandle
        const sourceHandle = connection.sourceHandle
        const sessions = projectSessions[project.path] || []
        let targetSessionId: string | undefined
        let targetTmuxPaneId: string | undefined
        let targetBranchId: string | undefined

        if (sourceHandle) {
          if (sourceHandle.startsWith('main-')) {
            const sessId = sourceHandle.replace('main-', '')
            const session = sessions.find(s => s.id === sessId)
            if (session) {
              targetSessionId = session.id
              targetTmuxPaneId = session.main?.tmuxPaneId
              targetBranchId = 'main'
            }
          } else if (sourceHandle.startsWith('fork-')) {
            const forkId = sourceHandle.replace('fork-', '')
            for (const session of sessions) {
              const fork = session.forks.find(f => f.id === forkId)
              if (fork) {
                targetSessionId = session.id
                targetTmuxPaneId = fork.tmuxPaneId
                targetBranchId = fork.id
                break
              }
            }
          }
        }

        if (!targetSessionId) {
          // Fallback: use first active session's main branch
          const activeSession = sessions.find(s => s.status === 'active')
          targetSessionId = activeSession?.id
          targetTmuxPaneId = activeSession?.main?.tmuxPaneId
          targetBranchId = 'main'
        }

        // Connect the agent to the project
        await agentsApi.connect(
          agent.id,
          project.path,
          targetSessionId,
          targetTmuxPaneId,
          targetBranchId
        )

        // Add the edge (always from project to agent for consistency)
        setEdges(eds =>
          addEdge(
            {
              id: `edge-${agent.id}`,
              source: `project-${project.path}`,
              sourceHandle: sourceHandle || undefined,
              target: `agent-${agent.id}`,
              animated: true,
              style: { stroke: '#a6e3a1' },
            },
            eds
          )
        )

        // Reload data
        await loadData()
      } catch (err: any) {
        console.error('Failed to connect:', err)
        setError(`Failed to connect: ${err.message}`)
      }
    },
    [projects, agents, projectSessions, loadData, setEdges]
  )

  // Handle edge deletion (disconnect)
  const onEdgesDelete = useCallback(
    async (deletedEdges: Edge[]) => {
      for (const edge of deletedEdges) {
        const agentId = edge.target?.replace('agent-', '')
        if (agentId) {
          try {
            await agentsApi.disconnect(agentId)
          } catch (err: any) {
            setError(`Failed to disconnect: ${err.message}`)
          }
        }
      }
      await loadData()
    },
    [loadData]
  )

  // Modal handlers
  const handleCreateAgent = useCallback(() => {
    setEditingAgent(null)
    setModalOpen(true)
  }, [])

  const handleSaveAgent = useCallback(
    async (options: CreateAgentOptions | Partial<Agent>) => {
      if (editingAgent) {
        await agentsApi.update(editingAgent.id, options)
      } else {
        await agentsApi.create(options as CreateAgentOptions)
      }
      await loadData()
    },
    [editingAgent, loadData]
  )

  // Double click to zoom into node
  const handleNodeDoubleClick = useCallback((_event: React.MouseEvent, node: Node) => {
    // Calculate node center (assuming approximate node dimensions)
    const nodeWidth = node.type === 'project' ? 320 : 280
    const nodeHeight = node.type === 'project' ? 400 : 300

    const x = node.position.x + nodeWidth / 2
    const y = node.position.y + nodeHeight / 2

    // Zoom to 2x and center on node
    setCenter(x, y, { zoom: 2, duration: 500 })
  }, [setCenter])

  return (
    <div className={`agent-canvas-container ${className || ''}`} style={{ width: '100%', height: '100%' }}>
      {loading && !nodes.length && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 10,
          }}
        >
          Loading...
        </div>
      )}

      {error && (
        <div
          style={{
            position: 'absolute',
            top: '16px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--color-red, #f38ba8)',
            color: 'white',
            padding: '8px 16px',
            borderRadius: '8px',
            zIndex: 10,
          }}
        >
          {error}
          <button
            onClick={() => setError(null)}
            style={{ marginLeft: '8px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'white' }}
          >
            ✕
          </button>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodeDoubleClick={handleNodeDoubleClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView={!initialLoadDone.current}
        snapToGrid
        snapGrid={[15, 15]}
        minZoom={0.1}
        maxZoom={8}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#313244" />
        <Controls />
      </ReactFlow>

      {/* Action buttons */}
      <div style={{
        position: 'absolute',
        bottom: '24px',
        right: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        zIndex: 10,
      }}>
        {/* Create agent button */}
        <button
          onClick={handleCreateAgent}
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            background: 'var(--accent-color, #89b4fa)',
            color: 'var(--bg-primary, #1e1e2e)',
            border: 'none',
            fontSize: '24px',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          title="Create new agent"
        >
          +
        </button>
      </div>

      <AgentConfigModal
        agent={editingAgent}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleSaveAgent}
      />

      <AgentLogsModal
        agent={viewingLogsAgent}
        isOpen={logsModalOpen}
        onClose={() => {
          setLogsModalOpen(false)
          setViewingLogsAgent(null)
        }}
      />
    </div>
  )
}

// Wrapper component with ReactFlowProvider
export function AgentCanvas(props: AgentCanvasProps) {
  return (
    <ReactFlowProvider>
      <AgentCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
