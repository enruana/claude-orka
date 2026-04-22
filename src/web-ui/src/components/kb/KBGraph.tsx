import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, type KBEntity } from '../../api/client'
import { KBEntityNode } from './KBEntityNode'
import { KBDetailPanel } from './KBDetailPanel'
import { KBGuidePanel } from './KBGuidePanel'
import { KBTimeline } from './KBTimeline'

const nodeTypes = { kbEntity: KBEntityNode }

const STORAGE_KEY = 'orka-kb-positions'
const TIMELINE_TYPES = new Set(['meeting', 'milestone', 'decision', 'direction'])

interface KBGraphInnerProps {
  projectPath: string
  encodedPath: string
  sessionId?: string
  visible?: boolean
}

function KBGraphInner({ projectPath, encodedPath, sessionId, visible }: KBGraphInnerProps) {
  const [entities, setEntities] = useState<KBEntity[]>([])
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selectedEntity, setSelectedEntity] = useState<KBEntity | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [loading, setLoading] = useState(true)
  const { fitView, setCenter } = useReactFlow()
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({})

  // Load saved positions (invalidate if entity count changed significantly)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`${STORAGE_KEY}-${projectPath}`)
      if (raw) {
        const saved = JSON.parse(raw)
        const savedCount = Object.keys(saved).length
        // If saved positions exist but entity count differs a lot, discard (stale layout)
        if (savedCount > 0) {
          positionsRef.current = saved
        }
      }
    } catch { /* ignore */ }
  }, [projectPath])

  // Save positions on node drag
  const handleNodesChange = useCallback((changes: any) => {
    onNodesChange(changes)
    for (const change of changes) {
      if (change.type === 'position' && change.position && change.id) {
        positionsRef.current[change.id] = change.position
      }
    }
    try {
      localStorage.setItem(
        `${STORAGE_KEY}-${projectPath}`,
        JSON.stringify(positionsRef.current)
      )
    } catch { /* ignore */ }
  }, [onNodesChange, projectPath])

  // Load entities
  const loadData = useCallback(async () => {
    try {
      const status = await api.getKBStatus(projectPath)
      if (!status.initialized) {
        setInitialized(false)
        setLoading(false)
        return
      }
      setInitialized(true)
      const data = await api.getKBEntities(projectPath)
      setEntities(data)
      setLoading(false)
    } catch (err) {
      console.error('KB load error:', err)
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 10000)
    return () => clearInterval(interval)
  }, [loadData])

  // Compute which entities are related to the selected project (2-hop BFS)
  const projectRelatedIds = useMemo(() => {
    if (!selectedProjectId) return null
    const related = new Set<string>([selectedProjectId])
    const adjacency = new Map<string, Set<string>>()
    for (const e of entities) {
      if (!adjacency.has(e.id)) adjacency.set(e.id, new Set())
      for (const edge of e.edges) {
        adjacency.get(e.id)!.add(edge.target)
        if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set())
        adjacency.get(edge.target)!.add(e.id)
      }
    }
    const queue = [selectedProjectId]
    const visited = new Set([selectedProjectId])
    let depth = 0
    while (queue.length > 0 && depth < 2) {
      const size = queue.length
      for (let i = 0; i < size; i++) {
        const id = queue.shift()!
        for (const n of adjacency.get(id) || []) {
          if (!visited.has(n)) { visited.add(n); related.add(n); queue.push(n) }
        }
      }
      depth++
    }
    return related
  }, [selectedProjectId, entities])

  const guidePanelEntities = useMemo(() => {
    if (!projectRelatedIds) return entities
    return entities.filter(e => projectRelatedIds.has(e.id))
  }, [entities, projectRelatedIds])

  // Build graph from entities with force-directed layout
  useEffect(() => {
    const entityIds = new Set(entities.map((e) => e.id))

    const savedCount = Object.keys(positionsRef.current).length
    const hasSavedPositions = savedCount > 0 && entities.every((e) => positionsRef.current[e.id])
    const forcePositions = hasSavedPositions ? {} : computeForceLayout(entities)

    const newNodes: Node[] = entities.map((entity) => {
      const saved = positionsRef.current[entity.id]
      const computed = forcePositions[entity.id]
      const isDimmed = projectRelatedIds !== null && !projectRelatedIds.has(entity.id)
      return {
        id: entity.id,
        type: 'kbEntity',
        position: saved || computed || { x: 0, y: 0 },
        data: { entity, selected: selectedEntity?.id === entity.id, dimmed: isDimmed },
      }
    })

    const newEdges: Edge[] = []
    for (const entity of entities) {
      for (const edge of entity.edges) {
        if (!entityIds.has(edge.target)) continue
        const isHighlighted = selectedEntity?.id === entity.id || selectedEntity?.id === edge.target
        const isEdgeDimmed = projectRelatedIds !== null &&
          (!projectRelatedIds.has(entity.id) || !projectRelatedIds.has(edge.target))
        newEdges.push({
          id: `${entity.id}-${edge.relation}-${edge.target}`,
          source: entity.id,
          target: edge.target,
          type: 'default',
          style: {
            stroke: isHighlighted ? '#cba6f7' : isEdgeDimmed ? 'rgba(166, 173, 200, 0.06)' : 'rgba(166, 173, 200, 0.18)',
            strokeWidth: isHighlighted ? 2.5 : 1,
          },
          animated: isHighlighted,
        })
      }
    }

    setNodes(newNodes)
    setEdges(newEdges)
  }, [entities, selectedEntity, projectRelatedIds, setNodes, setEdges])

  // Select and zoom to a node
  const handleSelectEntity = useCallback((id: string) => {
    const entity = entities.find((e) => e.id === id)
    setSelectedEntity(entity || null)

    // Zoom to node position
    const pos = positionsRef.current[id]
    if (pos) {
      const isTimeline = entity && TIMELINE_TYPES.has(entity.type)
      const offset = isTimeline ? 28 : 16
      setCenter(pos.x + offset, pos.y + offset, { zoom: 1.5, duration: 400 })
    }
  }, [entities, setCenter])

  // Node click
  const handleNodeClick = useCallback((_: any, node: Node) => {
    handleSelectEntity(node.id)
  }, [handleSelectEntity])

  // Node double-click → open detail
  const handleNodeDoubleClick = useCallback((_: any, node: Node) => {
    handleSelectEntity(node.id)
  }, [handleSelectEntity])

  // Fit on initial load
  const handleInit = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 200)
  }, [fitView])

  // Re-fit when tab becomes visible
  useEffect(() => {
    if (visible && nodes.length > 0) {
      setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 200)
    }
  }, [visible, fitView, nodes.length])

  // Reset layout
  const handleResetLayout = useCallback(() => {
    positionsRef.current = {}
    localStorage.removeItem(`${STORAGE_KEY}-${projectPath}`)
    setEntities((prev) => [...prev])
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 150)
  }, [projectPath, fitView])

  // Click on background → deselect
  const handlePaneClick = useCallback(() => {
    setSelectedEntity(null)
  }, [])

  if (loading) {
    return (
      <div className="kb-graph-empty">
        <div className="spinner" />
        <p>Loading knowledge graph...</p>
      </div>
    )
  }

  if (!initialized) {
    return (
      <div className="kb-graph-empty">
        <p>Knowledge Base not initialized</p>
        <p className="kb-graph-hint">Run <code>orka kb init</code> in this project</p>
      </div>
    )
  }

  if (entities.length === 0) {
    return (
      <div className="kb-graph-empty">
        <p>No entities in Knowledge Base</p>
        <p className="kb-graph-hint">Use <code>/kb-track</code> or <code>orka kb add</code> to start tracking</p>
      </div>
    )
  }

  return (
    <div className="kb-layout">
      <KBGuidePanel
        entities={guidePanelEntities}
        allEntities={entities}
        selectedId={selectedEntity?.id || null}
        selectedProjectId={selectedProjectId}
        onSelect={handleSelectEntity}
        onSelectProject={setSelectedProjectId}
      />
      <div className="kb-graph-container">
        <KBTimeline
          projectPath={projectPath}
          entities={entities}
          selectedId={selectedEntity?.id || null}
          onSelectEntity={handleSelectEntity}
        />
        <div className="kb-graph-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
            onPaneClick={handlePaneClick}
            onInit={handleInit}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.05}
            maxZoom={4}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={25} size={0.5} color="#1a1a2e" />
            <Controls showInteractive={false} />
          </ReactFlow>
          <KBDetailPanel
            entity={selectedEntity}
            encodedPath={encodedPath}
            projectPath={projectPath}
            sessionId={sessionId}
            onClose={() => setSelectedEntity(null)}
            onSelectNode={handleSelectEntity}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * Clustered layout: each entity type gets a zone, then force-push within zones.
 * Result: organic clusters grouped by type, no overlapping.
 */
function computeForceLayout(
  entities: KBEntity[]
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {}

  // Group by type
  const groups = new Map<string, KBEntity[]>()
  for (const e of entities) {
    const list = groups.get(e.type) || []
    list.push(e)
    groups.set(e.type, list)
  }

  // Assign each type a zone around a circle
  const typeOrder = ['meeting', 'decision', 'question', 'milestone', 'direction', 'person', 'repo', 'artifact', 'context']
  const sortedTypes = [...groups.keys()].sort((a, b) => {
    const ai = typeOrder.indexOf(a), bi = typeOrder.indexOf(b)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  const clusterRadius = 350 // distance of cluster centers from origin
  const nodeSpacing = 120   // spacing between nodes in a cluster

  sortedTypes.forEach((type, typeIdx) => {
    const items = groups.get(type)!
    const angle = (typeIdx / sortedTypes.length) * Math.PI * 2 - Math.PI / 2
    const cx = Math.cos(angle) * clusterRadius
    const cy = Math.sin(angle) * clusterRadius

    // Arrange items in a small spiral within the cluster
    items.forEach((entity, i) => {
      const itemAngle = i * 2.4 // golden angle
      const itemRadius = nodeSpacing * Math.sqrt(i) * 0.7
      positions[entity.id] = {
        x: cx + Math.cos(itemAngle) * itemRadius,
        y: cy + Math.sin(itemAngle) * itemRadius,
      }
    })
  })

  // Light force simulation to resolve overlaps and pull connected nodes closer
  const edgeList: Array<{ source: string; target: string }> = []
  for (const e of entities) {
    for (const edge of e.edges) {
      if (positions[edge.target]) {
        edgeList.push({ source: e.id, target: edge.target })
      }
    }
  }

  const ids = Object.keys(positions)
  const velocities: Record<string, { vx: number; vy: number }> = {}
  for (const id of ids) velocities[id] = { vx: 0, vy: 0 }

  for (let iter = 0; iter < 50; iter++) {
    // Repulsion (only between nearby nodes to keep clusters apart but not explode)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions[ids[i]], b = positions[ids[j]]
        const dx = a.x - b.x, dy = a.y - b.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        if (dist < 300) { // only repel close nodes
          const force = 5000 / (dist * dist)
          const fx = (dx / dist) * force, fy = (dy / dist) * force
          velocities[ids[i]].vx += fx; velocities[ids[i]].vy += fy
          velocities[ids[j]].vx -= fx; velocities[ids[j]].vy -= fy
        }
      }
    }

    // Gentle attraction along edges
    for (const { source, target } of edgeList) {
      const a = positions[source], b = positions[target]
      const dx = b.x - a.x, dy = b.y - a.y
      velocities[source].vx += dx * 0.002
      velocities[source].vy += dy * 0.002
      velocities[target].vx -= dx * 0.002
      velocities[target].vy -= dy * 0.002
    }

    for (const id of ids) {
      velocities[id].vx *= 0.8
      velocities[id].vy *= 0.8
      positions[id].x += velocities[id].vx
      positions[id].y += velocities[id].vy
    }
  }

  // Final pass: enforce minimum distance (no overlap)
  const minDist = 90
  for (let pass = 0; pass < 20; pass++) {
    let moved = false
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions[ids[i]], b = positions[ids[j]]
        const dx = a.x - b.x, dy = a.y - b.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < minDist && dist > 0) {
          const push = (minDist - dist) / 2 + 1
          const nx = dx / dist, ny = dy / dist
          a.x += nx * push; a.y += ny * push
          b.x -= nx * push; b.y -= ny * push
          moved = true
        }
      }
    }
    if (!moved) break
  }

  return positions
}

interface KBGraphProps {
  projectPath: string
  encodedPath: string
  sessionId?: string
  visible?: boolean
}

export function KBGraph({ projectPath, encodedPath, sessionId, visible }: KBGraphProps) {
  return (
    <ReactFlowProvider>
      <KBGraphInner projectPath={projectPath} encodedPath={encodedPath} sessionId={sessionId} visible={visible} />
    </ReactFlowProvider>
  )
}
