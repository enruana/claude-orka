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
import { List, Network } from 'lucide-react'
import { api, type KBEntity } from '../../api/client'
import { readPersisted } from '../../hooks/usePersistentState'
import { KBEntityNode } from './KBEntityNode'
import { KBDetailPanel } from './KBDetailPanel'
import { KBGuidePanel } from './KBGuidePanel'
import { KBTimeline } from './KBTimeline'
import { KBZoneLabel } from './KBZoneLabel'

const nodeTypes = { kbEntity: KBEntityNode, kbZoneLabel: KBZoneLabel }

// Bumped on each layout-algorithm change so old saved positions don't
// pollute the fresh visual structure.
//   v1 — force-directed
//   v2 — rigid grid swim-lanes
//   v3 — organic circular clusters (brain-like)
//   v4 — atom/universe: projects at nucleus, other clusters orbit chaotically
const STORAGE_KEY = 'orka-kb-positions-v4'
const SEL_KEY_PREFIX = 'orka-kb-sel'

type PersistedSel = {
  project: string | null
  entity: string | null
  mobileView: 'list' | 'graph'
}
const DEFAULT_SEL: PersistedSel = { project: null, entity: null, mobileView: 'list' }
const TIMELINE_TYPES = new Set(['meeting', 'milestone', 'decision', 'direction'])
const MOBILE_QUERY = '(max-width: 900px)'

function useKBMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(MOBILE_QUERY).matches
  })
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const handler = () => setIsMobile(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return isMobile
}

interface KBGraphInnerProps {
  projectPath: string
  encodedPath: string
  sessionId?: string
  branch?: string
  onSwitchToTerminal?: () => void
  visible?: boolean
}

function KBGraphInner({ projectPath, encodedPath, sessionId, branch, onSwitchToTerminal, visible }: KBGraphInnerProps) {
  const [entities, setEntities] = useState<KBEntity[]>([])
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const selKey = `${SEL_KEY_PREFIX}:${projectPath}`
  const [selectedEntity, setSelectedEntity] = useState<KBEntity | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => readPersisted<PersistedSel>(selKey, DEFAULT_SEL).project,
  )
  const [initialized, setInitialized] = useState(false)
  const [loading, setLoading] = useState(true)
  const isMobile = useKBMobile()
  const [mobileView, setMobileView] = useState<'list' | 'graph'>(
    () => readPersisted<PersistedSel>(selKey, DEFAULT_SEL).mobileView,
  )
  // Selection (project filter + open entity + mobile view) is persisted per
  // project so it survives a reload and switching to the Claude Code tab and
  // back. `selRestored` gates the persist effect so the one-shot restore can't
  // be clobbered before it resolves.
  const [selRestored, setSelRestored] = useState(false)
  const selRestoreKey = useRef<string | null>(null)
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

  // Restore persisted selection when the project changes (or on mount).
  // The entity object is resolved later (it needs `entities` loaded first).
  useEffect(() => {
    if (selRestoreKey.current === projectPath) return
    selRestoreKey.current = projectPath
    const saved = readPersisted<PersistedSel>(selKey, DEFAULT_SEL)
    setSelectedProjectId(saved.project)
    setMobileView(saved.mobileView)
    setSelectedEntity(null)
    // If there's no entity to resolve we're done restoring immediately;
    // otherwise the resolve effect below flips this once entities are in.
    setSelRestored(!saved.entity)
  }, [projectPath, selKey])

  // Resolve the persisted entity id to the loaded entity object.
  useEffect(() => {
    if (selRestored) return
    if (entities.length === 0) return
    const saved = readPersisted<PersistedSel>(selKey, DEFAULT_SEL)
    const ent = saved.entity ? entities.find((e) => e.id === saved.entity) ?? null : null
    if (ent) setSelectedEntity(ent)
    setSelRestored(true)
  }, [entities, selRestored, selKey])

  // Persist selection (only after restore, so we never write a stale/empty
  // selection over the saved one during the initial load).
  useEffect(() => {
    if (!selRestored) return
    try {
      localStorage.setItem(selKey, JSON.stringify({
        project: selectedProjectId,
        entity: selectedEntity?.id ?? null,
        mobileView,
      } satisfies PersistedSel))
    } catch {
      /* quota / serialization — non-fatal */
    }
  }, [selRestored, selKey, selectedProjectId, selectedEntity, mobileView])

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

  // Build graph from entities with clustered layout (zones per type)
  useEffect(() => {
    const entityIds = new Set(entities.map((e) => e.id))

    const savedCount = Object.keys(positionsRef.current).length
    const hasSavedPositions = savedCount > 0 && entities.every((e) => positionsRef.current[e.id])
    // Always compute the clustered layout — we need the zone labels even when
    // entities have user-dragged saved positions. Entity positions favor
    // saved over computed (so user drag-and-drop persists), but zone labels
    // always come from the fresh layout computation.
    const layout = computeClusteredLayout(entities)

    const newNodes: Node[] = []

    // 1. Zone halo nodes — circular backdrops, non-draggable, non-selectable.
    //    Pushed first so ReactFlow's render order places them under entity
    //    nodes. The component renders a circular halo + a floating label
    //    pill above the halo. pointer-events:none in CSS lets clicks reach
    //    the entities inside.
    const PILL_OFFSET = 32
    for (const zone of layout.zones) {
      newNodes.push({
        id: zone.id,
        type: 'kbZoneLabel',
        // ReactFlow uses top-left; the halo top-left is (cx-radius, cy-radius).
        // We expand the bounding box upwards by PILL_OFFSET so the floating
        // pill rendered above the halo is included in the node's hitbox area.
        position: { x: zone.cx - zone.radius, y: zone.cy - zone.radius - PILL_OFFSET },
        data: {
          type: zone.type,
          label: zone.label,
          count: zone.count,
          radius: zone.radius,
          pillOffset: PILL_OFFSET,
          nucleus: !!zone.nucleus,
        },
        draggable: false,
        selectable: false,
        focusable: false,
      })
    }

    // 2. Entity nodes — saved positions take priority (so user drags persist)
    for (const entity of entities) {
      const saved = hasSavedPositions ? positionsRef.current[entity.id] : undefined
      const computed = layout.positions[entity.id]
      const isDimmed = projectRelatedIds !== null && !projectRelatedIds.has(entity.id)
      newNodes.push({
        id: entity.id,
        type: 'kbEntity',
        position: saved || computed || { x: 0, y: 0 },
        data: { entity, selected: selectedEntity?.id === entity.id, dimmed: isDimmed },
      })
    }

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
            stroke: isHighlighted ? '#cba6f7' : isEdgeDimmed ? 'rgba(166, 173, 200, 0.06)' : 'rgba(166, 173, 200, 0.12)',
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

  // Re-fit when tab becomes visible (or on mobile when graph view activates)
  useEffect(() => {
    const graphActive = !isMobile || mobileView === 'graph'
    if (visible && graphActive && nodes.length > 0) {
      setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 200)
    }
  }, [visible, fitView, nodes.length, isMobile, mobileView])

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

  const showGuide = !isMobile || mobileView === 'list'
  const showGraph = !isMobile || mobileView === 'graph'

  return (
    <div className={`kb-layout ${isMobile ? 'is-mobile' : ''}`}>
      {isMobile && (
        <div className="kb-mobile-tabs">
          <button
            className={`kb-mobile-tab ${mobileView === 'list' ? 'active' : ''}`}
            onClick={() => setMobileView('list')}
          >
            <List size={14} />
            <span>List</span>
          </button>
          <button
            className={`kb-mobile-tab ${mobileView === 'graph' ? 'active' : ''}`}
            onClick={() => setMobileView('graph')}
          >
            <Network size={14} />
            <span>Graph</span>
          </button>
          <span className="kb-mobile-tabs-count">{entities.length}</span>
        </div>
      )}

      {showGuide && (
        <KBGuidePanel
          entities={guidePanelEntities}
          allEntities={entities}
          selectedId={selectedEntity?.id || null}
          selectedProjectId={selectedProjectId}
          onSelect={handleSelectEntity}
          onSelectProject={setSelectedProjectId}
        />
      )}

      {showGraph && (
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
          </div>
        </div>
      )}

      {/* Detail panel — overlays the graph on desktop, full-screen sheet on mobile */}
      {selectedEntity && (
        <>
          {isMobile && <div className="kb-detail-backdrop" onClick={() => setSelectedEntity(null)} />}
          <KBDetailPanel
            entity={selectedEntity}
            allEntities={entities}
            encodedPath={encodedPath}
            projectPath={projectPath}
            sessionId={sessionId}
            branch={branch}
            onSwitchToTerminal={onSwitchToTerminal}
            onClose={() => setSelectedEntity(null)}
            onSelectNode={handleSelectEntity}
          />
        </>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// Clustered layout — organic circular clusters (brain-like)
// --------------------------------------------------------------------------

interface ZoneCluster {
  id: string
  type: string
  label: string
  count: number
  /** Center x of the cluster halo (in canvas coords) */
  cx: number
  /** Center y of the cluster halo (in canvas coords) */
  cy: number
  /** Halo radius — entities are scattered within this disk */
  radius: number
  /** True when this is the nucleus (centermost cluster). UI hint only. */
  nucleus?: boolean
}

interface ClusteredLayout {
  positions: Record<string, { x: number; y: number }>
  zones: ZoneCluster[]
}

/**
 * Stable pseudo-random hash for an id. Deterministic so jitter doesn't
 * "shimmer" across renders; pulls bits from the same string each time.
 */
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

/**
 * Display labels for each entity type's cluster.
 */
const TYPE_LABELS: Record<string, string> = {
  goal: 'Goals', initiative: 'Initiatives', project: 'Projects',
  task: 'Tasks', spike: 'Spikes', bug: 'Bugs',
  decision: 'Decisions', question: 'Questions', meeting: 'Meetings',
  milestone: 'Milestones', direction: 'Directions',
  person: 'People', repo: 'Repositories', artifact: 'Artifacts', context: 'Context',
  activity: 'Activities',
}

/**
 * Atom/universe layout: one type sits at the nucleus, the rest orbit it in
 * concentric "shells". Each shell groups types by their semantic distance
 * from the nucleus — work tier closest, then knowledge, reference, and
 * provenance furthest out.
 *
 * Nucleus selection priority — first match wins; falls back to the most
 * populous type if none of these exist in the KB.
 */
const NUCLEUS_PRIORITY: string[] = ['project', 'initiative', 'goal']

/**
 * Orbital shells, ordered inner → outer. Each list defines which types
 * occupy that shell. Types not in any shell fall to a far-out "fringe".
 */
const ORBITAL_SHELLS: string[][] = [
  // Inner: work + the most-tied-to-projects knowledge
  ['task', 'spike', 'bug', 'decision'],
  // Mid: more knowledge + strategic context
  ['question', 'milestone', 'meeting', 'initiative'],
  // Outer: directions + people + reference
  ['direction', 'goal', 'person', 'repo'],
  // Fringe: artifacts, contexts, provenance
  ['artifact', 'context', 'activity'],
]

/**
 * Atom / universe layout — one cluster sits at the nucleus (origin), the
 * rest orbit it in concentric shells with deterministic angular and radial
 * jitter so the whole thing reads as a chaotic "system" instead of a
 * geometric diagram.
 *
 * Inside every cluster the entities are scattered with a sunflower spiral
 * + per-entity jitter (same as the previous brain-cluster layout). There
 * is no force simulation — positions are stable across renders.
 */
function computeClusteredLayout(entities: KBEntity[]): ClusteredLayout {
  const positions: Record<string, { x: number; y: number }> = {}
  const zones: ZoneCluster[] = []

  // Group by type
  const groups = new Map<string, KBEntity[]>()
  for (const e of entities) {
    const list = groups.get(e.type) || []
    list.push(e)
    groups.set(e.type, list)
  }

  if (groups.size === 0) return { positions, zones }

  // Layout constants
  const NODE_VISUAL = 60
  const PACKING = 0.55
  const RADIUS_BASE = 28
  const MIN_RADIUS = 90
  const MAX_RADIUS = 460
  const SHELL_GAP = 130          // breathing room between the EDGE of one shell and the next
  const PILL_OFFSET = 32

  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

  // Compute halo radii for each cluster from its entity count
  const radii = new Map<string, number>()
  for (const [type, list] of groups) {
    const r = Math.max(
      MIN_RADIUS,
      Math.min(MAX_RADIUS, NODE_VISUAL * Math.sqrt(list.length) * PACKING + RADIUS_BASE)
    )
    radii.set(type, r)
  }

  // ---- Pick the nucleus -----------------------------------------------
  let nucleusType: string | null = null
  for (const t of NUCLEUS_PRIORITY) {
    if (groups.has(t)) { nucleusType = t; break }
  }
  if (!nucleusType) {
    let bestCount = 0
    for (const [t, list] of groups) {
      if (list.length > bestCount) { nucleusType = t; bestCount = list.length }
    }
  }

  // Final ordered placement list — nucleus first, then orbiters
  const placements: Array<{ type: string; cx: number; cy: number; radius: number; nucleus: boolean }> = []
  const placed = new Set<string>()

  if (nucleusType) {
    placements.push({ type: nucleusType, cx: 0, cy: 0, radius: radii.get(nucleusType)!, nucleus: true })
    placed.add(nucleusType)
  }

  // ---- Place each orbital shell ---------------------------------------
  // currentInnerEdge = max distance from origin already occupied by a
  // cluster's outer edge. Each new shell's center radius must be at least
  // currentInnerEdge + maxClusterRadius + SHELL_GAP.
  let currentInnerEdge = nucleusType ? radii.get(nucleusType)! + SHELL_GAP : 0

  ORBITAL_SHELLS.forEach((shellTypes, shellIndex) => {
    const shellClusters = shellTypes
      .filter((t) => groups.has(t) && !placed.has(t))
      .map((t) => ({ type: t, radius: radii.get(t)! }))

    if (shellClusters.length === 0) return

    const maxR = Math.max(...shellClusters.map((c) => c.radius))
    const N = shellClusters.length

    // Geometric constraint: angular slot per cluster ≈ 2π/N. Each cluster
    // takes roughly `2 * radius` of arc length, so we need
    //   orbitRadius ≥ N * maxR / (π * spread) where spread<1 controls
    //   how tightly clusters pack along the orbit.
    const minOrbitRadius = (N * maxR) / (Math.PI * 0.78)
    let orbitRadius = Math.max(currentInnerEdge + maxR, minOrbitRadius)

    // Each shell rotates by a different offset so consecutive shells don't
    // align cluster centers along the same axis (visual interest).
    const shellRotation = shellIndex * 0.55 + 0.18 + (N === 1 ? 0.7 : 0)

    shellClusters.forEach((c, i) => {
      const baseAngle = shellRotation + (i / N) * 2 * Math.PI

      // Per-cluster jitter, deterministic from type name
      const h = hashString(c.type)
      // Angular jitter — up to ±35% of the angular slot per cluster
      const jAngle = ((h & 0xFF) / 0xFF - 0.5) * (2 * Math.PI / N) * 0.35
      // Radial jitter — pushes some clusters farther in or out for chaos
      const jRadius = (((h >> 8) & 0xFF) / 0xFF - 0.5) * 90

      const angle = baseAngle + jAngle
      const r = Math.max(currentInnerEdge + c.radius * 0.5, orbitRadius + jRadius)

      placements.push({
        type: c.type,
        cx: Math.cos(angle) * r,
        cy: Math.sin(angle) * r,
        radius: c.radius,
        nucleus: false,
      })
      placed.add(c.type)
    })

    currentInnerEdge = orbitRadius + maxR + SHELL_GAP
  })

  // ---- Place orphan types in a "fringe" beyond the last shell ---------
  const orphans = [...groups.keys()].filter((t) => !placed.has(t))
  orphans.forEach((type, i) => {
    const r = radii.get(type)!
    const orbitRadius = currentInnerEdge + r
    // Spread orphans around their own orbit, hash-based angular jitter
    const N = orphans.length
    const baseAngle = (i / N) * 2 * Math.PI + 0.9
    const h = hashString(type)
    const jAngle = ((h & 0xFF) / 0xFF - 0.5) * 0.6
    const jRadius = (((h >> 8) & 0xFF) / 0xFF - 0.5) * 60

    const angle = baseAngle + jAngle
    const radius = orbitRadius + jRadius
    placements.push({
      type,
      cx: Math.cos(angle) * radius,
      cy: Math.sin(angle) * radius,
      radius: r,
      nucleus: false,
    })
    placed.add(type)
  })

  // ---- Scatter entities inside each cluster (sunflower + jitter) ------
  for (const p of placements) {
    const list = groups.get(p.type)!
    const sorted = [...list].sort((a, b) => {
      const sa = a.status === 'active' ? 0 : 1
      const sb = b.status === 'active' ? 0 : 1
      if (sa !== sb) return sa - sb
      return new Date(b.updated).getTime() - new Date(a.updated).getTime()
    })

    const innerR = Math.max(0, p.radius - NODE_VISUAL / 2 - 8)

    sorted.forEach((entity, i) => {
      const baseAngle = i * GOLDEN_ANGLE
      const baseRadius = innerR * Math.sqrt((i + 0.5) / sorted.length)

      const h = hashString(entity.id)
      const jitterAngle = ((h & 0xFF) / 0xFF - 0.5) * 0.55
      const jitterRadius = (((h >> 8) & 0xFF) / 0xFF - 0.5) * innerR * 0.22

      const angle = baseAngle + jitterAngle
      const r = Math.max(0, Math.min(innerR, baseRadius + jitterRadius))

      positions[entity.id] = {
        x: p.cx + Math.cos(angle) * r - NODE_VISUAL / 2,
        y: p.cy + Math.sin(angle) * r - NODE_VISUAL / 2,
      }
    })

    zones.push({
      id: `zone-${p.type}`,
      type: p.type,
      label: TYPE_LABELS[p.type] || p.type[0].toUpperCase() + p.type.slice(1) + 's',
      count: list.length,
      cx: p.cx,
      cy: p.cy,
      radius: p.radius,
      nucleus: p.nucleus,
    })
  }

  return { positions, zones }
}

interface KBGraphProps {
  projectPath: string
  encodedPath: string
  sessionId?: string
  branch?: string
  onSwitchToTerminal?: () => void
  visible?: boolean
}

export function KBGraph({ projectPath, encodedPath, sessionId, branch, onSwitchToTerminal, visible }: KBGraphProps) {
  return (
    <ReactFlowProvider>
      <KBGraphInner
        projectPath={projectPath}
        encodedPath={encodedPath}
        sessionId={sessionId}
        branch={branch}
        onSwitchToTerminal={onSwitchToTerminal}
        visible={visible}
      />
    </ReactFlowProvider>
  )
}
