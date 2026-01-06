import React, { useCallback, useMemo, useState, useEffect } from 'react'
import ReactFlow, {
  Node,
  Edge,
  Background,
  Controls,
  MarkerType,
  useNodesState,
  useEdgesState,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { NodeCard } from './NodeCard'
import { CompactNode } from './CompactNode'
import type { Session, NodePosition } from '../../../../src/models/Session'

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
  // Create a stable key that captures fork structure AND status
  // This is used as the primary dependency for rebuilding nodes/edges
  const forksKey = useMemo(() => {
    const forks = session.forks || []
    return forks.map(f => `${f.id}:${f.status}:${f.parentId}`).join(',')
  }, [session.forks])

  // Stable positions key
  const positionsKey = useMemo(() => {
    return JSON.stringify(session.nodePositions || {})
  }, [session.nodePositions])

  // Calculate tree depth for each fork - stable function
  const getDepth = useCallback((forkId: string, forksArray: Array<{id: string; parentId: string}>, visited = new Set<string>()): number => {
    if (forkId === 'main') return 0
    if (visited.has(forkId)) return 0

    const fork = forksArray.find(f => f.id === forkId)
    if (!fork) return 0

    visited.add(forkId)
    return 1 + getDepth(fork.parentId, forksArray, visited)
  }, [])

  // Build nodes - only recalculate when forksKey changes
  const nodes: Node[] = useMemo(() => {
    const forks = session.forks || []
    const savedPositions = session.nodePositions || {}

    // Group forks by depth
    const forksByDepth = new Map<number, typeof forks>()
    forks.forEach(fork => {
      const depth = getDepth(fork.id, forks)
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

      const depth = getDepth(fork.id, forks)
      const forksAtDepth = forksByDepth.get(depth) || []
      const indexAtDepth = forksAtDepth.indexOf(fork)

      return {
        x: 100 + indexAtDepth * 150 - (forksAtDepth.length * 75) + 250,
        y: 50 + depth * 150,
      }
    }

    const getNodePosition = (nodeId: string): NodePosition => {
      return savedPositions[nodeId] || getDefaultPosition(nodeId)
    }

    const result: Node[] = [
      {
        id: 'main',
        type: 'sessionNode',
        position: getNodePosition('main'),
        draggable: true,
        data: {
          label: 'MAIN',
          status: session.main?.status || session.status,
          claudeSessionId: session.main?.claudeSessionId,
          selected: false,
        },
      },
    ]

    forks.forEach((fork) => {
      const nodeType = (fork.status === 'closed' || fork.status === 'merged') ? 'compactNode' : 'sessionNode'

      result.push({
        id: fork.id,
        type: nodeType,
        position: getNodePosition(fork.id),
        draggable: true,
        data: {
          label: fork.name,
          status: fork.status,
          claudeSessionId: fork.claudeSessionId,
          selected: false,
        },
      })
    })

    return result
  }, [session.id, session.status, session.main?.status, session.main?.claudeSessionId, forksKey, positionsKey, getDepth])

  // Build edges - only recalculate when forksKey changes
  const edges: Edge[] = useMemo(() => {
    const forks = session.forks || []
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
  }, [forksKey])

  // Use controlled state for nodes and edges
  const [controlledNodes, setControlledNodes, onNodesChange] = useNodesState(nodes)
  const [controlledEdges, setControlledEdges, onEdgesChange] = useEdgesState(edges)

  // Reset nodes AND edges when forksKey changes (structure or status change)
  useEffect(() => {
    setControlledNodes(nodes)
    setControlledEdges(edges)
  }, [forksKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Apply selection to controlled nodes
  const nodesWithSelection = useMemo(() => {
    return controlledNodes.map(node => ({
      ...node,
      data: {
        ...node.data,
        selected: node.id === selectedNode,
      },
    }))
  }, [controlledNodes, selectedNode])

  // Handle node click
  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    onNodeClick(node.id)
  }, [onNodeClick])

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodesWithSelection}
        edges={controlledEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
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
