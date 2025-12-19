import { useCallback, useMemo } from 'react'
import ReactFlow, {
  Node,
  Edge,
  Background,
  Controls,
  MarkerType,
  useNodesState,
  useEdgesState,
  NodeDragHandler,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { NodeCard } from './NodeCard'
import { CompactNode } from './CompactNode'
import type { Session, NodePosition } from '../../../../src/models/Session'

interface SessionTreeProps {
  session: Session
  selectedNode: string
  onNodeClick: (nodeId: string) => void
  onNodePositionChange?: (nodeId: string, position: NodePosition) => void
}

const nodeTypes = {
  sessionNode: NodeCard,
  compactNode: CompactNode,
}

export function SessionTree({ session, selectedNode, onNodeClick, onNodePositionChange }: SessionTreeProps) {
  const forks = session.forks || []
  const savedPositions = session.nodePositions || {}

  // Calculate tree depth for each fork
  const getDepth = (forkId: string, visited = new Set<string>()): number => {
    if (forkId === 'main') return 0
    if (visited.has(forkId)) return 0 // Prevent infinite loops

    const fork = forks.find(f => f.id === forkId)
    if (!fork) return 0

    visited.add(forkId)
    return 1 + getDepth(fork.parentId, visited)
  }

  // Group forks by depth
  const forksByDepth = new Map<number, typeof forks>()
  forks.forEach(fork => {
    const depth = getDepth(fork.id)
    if (!forksByDepth.has(depth)) {
      forksByDepth.set(depth, [])
    }
    forksByDepth.get(depth)!.push(fork)
  })

  // Calculate default position for a node
  const getDefaultPosition = (nodeId: string): NodePosition => {
    if (nodeId === 'main') {
      return { x: 250, y: 50 }
    }

    const fork = forks.find(f => f.id === nodeId)
    if (!fork) return { x: 250, y: 50 }

    const depth = getDepth(fork.id)
    const forksAtDepth = forksByDepth.get(depth) || []
    const indexAtDepth = forksAtDepth.indexOf(fork)

    return {
      x: 100 + indexAtDepth * 150 - (forksAtDepth.length * 75) + 250,
      y: 50 + depth * 150,
    }
  }

  // Get position for a node (saved or default)
  const getNodePosition = (nodeId: string): NodePosition => {
    return savedPositions[nodeId] || getDefaultPosition(nodeId)
  }

  // Build initial nodes
  const initialNodes = useMemo(() => {
    const nodes: Node[] = [
      {
        id: 'main',
        type: 'sessionNode',
        position: getNodePosition('main'),
        draggable: true,
        data: {
          label: 'MAIN',
          status: session.main?.status || session.status,
          claudeSessionId: session.main?.claudeSessionId,
          selected: selectedNode === 'main',
        },
      },
    ]

    // Create fork nodes
    forks.forEach((fork) => {
      const nodeType = (fork.status === 'closed' || fork.status === 'merged') ? 'compactNode' : 'sessionNode'

      nodes.push({
        id: fork.id,
        type: nodeType,
        position: getNodePosition(fork.id),
        draggable: true,
        data: {
          label: fork.name,
          status: fork.status,
          claudeSessionId: fork.claudeSessionId,
          selected: selectedNode === fork.id,
        },
      })
    })

    return nodes
  }, [session.id, forks.length, selectedNode, JSON.stringify(savedPositions)])

  // Build edges
  const initialEdges = useMemo(() => {
    return forks.map((fork) => ({
      id: `${fork.parentId}-${fork.id}`,
      source: fork.parentId,
      target: fork.id,
      animated: fork.status === 'active',
      markerEnd: {
        type: MarkerType.ArrowClosed,
      },
      style: {
        stroke: fork.status === 'active' ? '#a6e3a1' : '#585b70',
        strokeWidth: 2,
      },
    }))
  }, [forks])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Update nodes when session changes
  useMemo(() => {
    setNodes(initialNodes)
    setEdges(initialEdges)
  }, [initialNodes, initialEdges])

  // Handle node drag end - save position
  const onNodeDragStop: NodeDragHandler = useCallback((_, node) => {
    if (onNodePositionChange) {
      onNodePositionChange(node.id, { x: node.position.x, y: node.position.y })
    }
  }, [onNodePositionChange])

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onNodeClick(node.id)}
        onNodeDragStop={onNodeDragStop}
        fitView
        minZoom={0.5}
        maxZoom={1.5}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}
