import ReactFlow, {
  Node,
  Edge,
  Background,
  Controls,
  MarkerType,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { NodeCard } from './NodeCard'
import type { Session } from '../../../../src/models/Session'

interface SessionTreeProps {
  session: Session
  selectedNode: string
  onNodeClick: (nodeId: string) => void
}

const nodeTypes = {
  sessionNode: NodeCard,
}

export function SessionTree({ session, selectedNode, onNodeClick }: SessionTreeProps) {
  // Create nodes for main and forks
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
    ...session.forks.map((fork, index) => ({
      id: fork.id,
      type: 'sessionNode',
      position: {
        x: 100 + index * 150 - (session.forks.length * 75) + 250,
        y: 200,
      },
      data: {
        label: fork.name || `Fork ${index + 1}`,
        status: fork.status,
        claudeSessionId: fork.claudeSessionId,
        selected: selectedNode === fork.id,
      },
    })),
  ]

  // Create edges from main to each fork
  const edges: Edge[] = session.forks.map((fork) => ({
    id: `main-${fork.id}`,
    source: 'main',
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
