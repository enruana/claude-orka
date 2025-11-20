import ReactFlow, {
  Node,
  Edge,
  Background,
  Controls,
  MarkerType,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { NodeCard } from './NodeCard'
import { CompactNode } from './CompactNode'
import type { Session } from '../../../../src/models/Session'

interface SessionTreeProps {
  session: Session
  selectedNode: string
  onNodeClick: (nodeId: string) => void
}

const nodeTypes = {
  sessionNode: NodeCard,
  compactNode: CompactNode,
}

export function SessionTree({ session, selectedNode, onNodeClick }: SessionTreeProps) {
  // Calculate tree depth for each fork
  const getDepth = (forkId: string, visited = new Set<string>()): number => {
    if (forkId === 'main') return 0
    if (visited.has(forkId)) return 0 // Prevent infinite loops

    const fork = session.forks.find(f => f.id === forkId)
    if (!fork) return 0

    visited.add(forkId)
    return 1 + getDepth(fork.parentId, visited)
  }

  // Group forks by depth
  const forksByDepth = new Map<number, typeof session.forks>()
  session.forks.forEach(fork => {
    const depth = getDepth(fork.id)
    if (!forksByDepth.has(depth)) {
      forksByDepth.set(depth, [])
    }
    forksByDepth.get(depth)!.push(fork)
  })

  // Create main node
  const nodes: Node[] = [
    {
      id: 'main',
      type: 'sessionNode',
      position: { x: 250, y: 50 },
      data: {
        label: 'MAIN',
        status: session.main?.status || session.status,
        claudeSessionId: session.main?.claudeSessionId,
        selected: selectedNode === 'main',
      },
    },
  ]

  // Create fork nodes with tree layout
  session.forks.forEach((fork) => {
    const depth = getDepth(fork.id)
    const forksAtDepth = forksByDepth.get(depth) || []
    const indexAtDepth = forksAtDepth.indexOf(fork)

    // Use compact node for closed/merged forks, regular node for active/saved
    const nodeType = (fork.status === 'closed' || fork.status === 'merged') ? 'compactNode' : 'sessionNode'

    nodes.push({
      id: fork.id,
      type: nodeType,
      position: {
        x: 100 + indexAtDepth * 150 - (forksAtDepth.length * 75) + 250,
        y: 50 + depth * 150,
      },
      data: {
        label: fork.name,
        status: fork.status,
        claudeSessionId: fork.claudeSessionId,
        selected: selectedNode === fork.id,
      },
    })
  })

  // Create edges based on parentId
  const edges: Edge[] = session.forks.map((fork) => ({
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

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onNodeClick(node.id)}
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
