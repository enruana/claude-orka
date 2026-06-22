/**
 * KBGraph — Knowledge Base graph view.
 *
 * The graph area is rendered in 3D via `Kb3DGraph` (react-three-fiber +
 * Three.js + bloom), borrowing the multi-galaxy visual language from
 * DeusData/codebase-memory-mcp's graph-ui. Each entity type is a spherical
 * "galaxy" of nodes; galaxies are distributed on a Fibonacci sphere
 * around the highest-priority type (project / initiative / goal) at the
 * nucleus. Layout lives inside `Kb3DGraph`; KBGraph just owns the
 * surrounding chrome (sidebar, timeline, detail panel) and data loading.
 *
 * Everything around the graph is preserved unchanged:
 *   - KBGuidePanel  (left sidebar, list by status/type)
 *   - KBTimeline    (top strip, weeks → days timeline)
 *   - KBDetailPanel (right panel, opens on selection)
 *   - mobile list/graph tabs
 *   - 10s polling, persisted selection per project
 *   - project-filter 2-hop BFS (drives the `highlightedIds` dim mask)
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { List, Network } from 'lucide-react'
import { api, type KBEntity } from '../../api/client'
import { readPersisted } from '../../hooks/usePersistentState'
import { KBDetailPanel } from './KBDetailPanel'
import { KBGuidePanel } from './KBGuidePanel'
import { KBTimeline } from './KBTimeline'
import { Kb3DGraph } from './Kb3DGraph'

const SEL_KEY_PREFIX = 'orka-kb-sel'

type PersistedSel = {
  project: string | null
  entity: string | null
  mobileView: 'list' | 'graph'
}
const DEFAULT_SEL: PersistedSel = { project: null, entity: null, mobileView: 'list' }
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

interface KBGraphProps {
  projectPath: string
  encodedPath: string
  sessionId?: string
  branch?: string
  onSwitchToTerminal?: () => void
  /** Whether the KB tab is currently the visible one. Reserved for future
   *  use; the 3D Canvas pauses on its own when offscreen via R3F's
   *  visibility detection, so no manual gating is currently needed. */
  visible?: boolean
}

export function KBGraph({ projectPath, encodedPath, sessionId, branch, onSwitchToTerminal }: KBGraphProps) {
  const selKey = `${SEL_KEY_PREFIX}:${projectPath}`
  const [entities, setEntities] = useState<KBEntity[]>([])
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

  // Persistence — one shot restore on project change, then write-through on
  // any change. `selRestored` gates the write effect so the initial load
  // can't clobber the saved value while entities are still loading.
  const [selRestored, setSelRestored] = useState(false)
  const selRestoreKey = useRef<string | null>(null)

  useEffect(() => {
    if (selRestoreKey.current === projectPath) return
    selRestoreKey.current = projectPath
    const saved = readPersisted<PersistedSel>(selKey, DEFAULT_SEL)
    setSelectedProjectId(saved.project)
    setMobileView(saved.mobileView)
    setSelectedEntity(null)
    setSelRestored(!saved.entity)
  }, [projectPath, selKey])

  useEffect(() => {
    if (selRestored) return
    if (entities.length === 0) return
    const saved = readPersisted<PersistedSel>(selKey, DEFAULT_SEL)
    const ent = saved.entity ? entities.find((e) => e.id === saved.entity) ?? null : null
    if (ent) setSelectedEntity(ent)
    setSelRestored(true)
  }, [entities, selRestored, selKey])

  useEffect(() => {
    if (!selRestored) return
    try {
      localStorage.setItem(selKey, JSON.stringify({
        project: selectedProjectId,
        entity: selectedEntity?.id ?? null,
        mobileView,
      } satisfies PersistedSel))
    } catch { /* quota / serialization — non-fatal */ }
  }, [selRestored, selKey, selectedProjectId, selectedEntity, mobileView])

  // Load entities + 10s poll. Cleared on unmount or project change.
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

  // Project filter — 2-hop BFS from the selected project entity. The set is
  // null when no project is selected (every node shines), or the resolved
  // neighborhood otherwise. The 3D scene dims nodes/edges outside the set.
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
    return entities.filter((e) => projectRelatedIds.has(e.id))
  }, [entities, projectRelatedIds])

  // Selection-focused dim mask: when ANY node is selected, compute its
  // 2-hop neighborhood (same BFS used for the project filter) and use
  // that as the highlight set so the focused subgraph stays lit and the
  // rest of the universe dims down. Falls back to the project filter when
  // no node is open, and to null (everything lit) otherwise.
  const selectedRelatedIds = useMemo(() => {
    if (!selectedEntity) return null
    const related = new Set<string>([selectedEntity.id])
    const adjacency = new Map<string, Set<string>>()
    for (const e of entities) {
      if (!adjacency.has(e.id)) adjacency.set(e.id, new Set())
      for (const edge of e.edges) {
        adjacency.get(e.id)!.add(edge.target)
        if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set())
        adjacency.get(edge.target)!.add(e.id)
      }
    }
    const queue = [selectedEntity.id]
    const visited = new Set([selectedEntity.id])
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
  }, [selectedEntity, entities])

  // The 3D scene's dim mask. Selection wins over the project filter so a
  // node click always tightens the focus. When the user clears the
  // selection, the project filter (if any) takes over again.
  const effectiveHighlight = selectedRelatedIds ?? projectRelatedIds

  // Selection from any source (graph click, guide panel click, BFS) goes
  // through here so the detail panel + selection state stay in sync.
  const handleSelectEntity = useCallback(
    (id: string | KBEntity | null) => {
      if (id === null) { setSelectedEntity(null); return }
      const entity = typeof id === 'string' ? entities.find((e) => e.id === id) || null : id
      setSelectedEntity(entity)
    },
    [entities],
  )

  // Reflect detail-panel edits immediately (the 10s poll also reconciles).
  const handleEntityUpdated = useCallback((updated: KBEntity) => {
    setEntities((prev) => prev.map((e) => (e.id === updated.id ? updated : e)))
    setSelectedEntity((cur) => (cur && cur.id === updated.id ? updated : cur))
  }, [])

  if (loading) {
    return (
      <div className="kb-graph-empty">
        <div className="spinner" />
        <p>Loading knowledge graph…</p>
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
            <Kb3DGraph
              entities={entities}
              selectedId={selectedEntity?.id ?? null}
              highlightedIds={effectiveHighlight}
              onSelect={(e) => handleSelectEntity(e)}
            />
          </div>
        </div>
      )}

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
            onEntityUpdated={handleEntityUpdated}
          />
        </>
      )}
    </div>
  )
}
