/**
 * Kb3DGraph — three.js / react-three-fiber rendering of the KB graph.
 *
 * Visual model borrowed from DeusData/codebase-memory-mcp's graph-ui:
 *   - Each entity TYPE is a "galaxy" (spherical 3D cluster of nodes).
 *   - Galaxies are placed on a Fibonacci sphere around the origin, with a
 *     priority type (project / initiative / goal) at the nucleus.
 *   - Nodes inside a galaxy are scattered as a deterministic 3D point
 *     cloud (cube-root radial sampling for uniform volumetric density).
 *   - Bloom post-processing gives the glowing-star look.
 *   - Non-highlighted nodes dim to 15 %; selected boosts past 1.0 so bloom
 *     produces a halo around it.
 *
 * Implementation note: uses Drei's `<Instances>` / `<Instance>` API
 * instead of a raw `<instancedMesh>`, because Drei wires the instance
 * color attribute and material correctly out of the box — the raw
 * `setColorAt` + `vertexColors` path was rendering all nodes black on the
 * first paint due to attribute-attach ordering.
 */

import { useEffect, useMemo, useState } from 'react'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls, Html, Instances, Instance } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'
import type { KBEntity } from '../../api/client'

const TYPE_COLORS: Record<string, string> = {
  // Knowledge tier
  decision: '#a6e3a1', question: '#f9e2af', meeting: '#cba6f7',
  milestone: '#f5c2e7', direction: '#fab387',
  // Work tier
  goal: '#f38ba8', initiative: '#eba0ac', project: '#f38ba8',
  task: '#94e2d5', spike: '#eed49f', bug: '#ed8796',
  // Reference tier
  person: '#89b4fa', repo: '#89dceb', artifact: '#a6adc8', context: '#6c7086',
  // Provenance
  activity: '#7f849c',
}

/** Top-level types get a visibly larger sphere so the eye lands on them. */
const SIZE_BOOST_TYPES = new Set(['goal', 'initiative', 'project'])

/** Order types by "importance" — the first type that exists in the KB
 *  becomes the nucleus galaxy at the origin; the rest fill the Fibonacci
 *  sphere outward in this order. */
const TYPE_PRIORITY = [
  'project', 'initiative', 'goal',
  'task', 'spike', 'bug',
  'decision', 'question', 'milestone', 'meeting', 'direction',
  'person', 'repo', 'artifact', 'context',
  'activity',
]

interface Edge3D {
  source: string
  target: string
}

export interface Kb3DGraphProps {
  entities: KBEntity[]
  /** Currently-open entity id; rendered larger + brighter. */
  selectedId: string | null
  /** Set of ids that pass the project filter; nodes NOT in the set dim hard.
   *  `null` = no filter, every node shines normally. */
  highlightedIds: Set<string> | null
  /** Called when a node is clicked. `null` when the user clicks empty space. */
  onSelect: (entity: KBEntity | null) => void
}

export function Kb3DGraph({ entities, selectedId, highlightedIds, onSelect }: Kb3DGraphProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  // Compute galaxy-style 3D positions. Memoized on the entities array, so a
  // 10s poll that returns identical data does not reshuffle the scene.
  const positions3D = useMemo(() => compute3DPositions(entities), [entities])

  // Derive edges from the entity edge lists; drop edges whose target left
  // the current set (e.g. saved but later deleted).
  const edges = useMemo<Edge3D[]>(() => {
    const ids = new Set(entities.map((e) => e.id))
    const list: Edge3D[] = []
    for (const e of entities) {
      for (const edge of e.edges) {
        if (ids.has(edge.target)) list.push({ source: e.id, target: edge.target })
      }
    }
    return list
  }, [entities])

  return (
    <Canvas
      camera={{ position: [0, 0, 900], fov: 50, near: 1, far: 50000 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      style={{ background: '#06090f', width: '100%', height: '100%' }}
      onPointerMissed={() => onSelect(null)}
    >
      {/* Ambient + two point lights from opposite sides. Even though we use
          MeshBasicMaterial (unlit), the lights matter for the bloom passes
          and for any future swap to a lit material. */}
      <ambientLight intensity={0.5} />
      <pointLight position={[500, 500, 500]} intensity={0.6} />
      <pointLight position={[-300, -200, -300]} intensity={0.45} color="#a78bfa" />

      <NodeCloud
        entities={entities}
        positions3D={positions3D}
        selectedId={selectedId}
        hoveredId={hoveredId}
        highlightedIds={highlightedIds}
        onSelect={onSelect}
        onHover={setHoveredId}
      />

      <EdgeLines
        edges={edges}
        positions3D={positions3D}
        selectedId={selectedId}
        highlightedIds={highlightedIds}
      />

      <HoverLabel
        entities={entities}
        positions3D={positions3D}
        hoveredId={hoveredId}
        selectedId={selectedId}
      />

      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.45}
        zoomSpeed={0.8}
        panSpeed={0.6}
        minDistance={60}
        maxDistance={8000}
        screenSpacePanning
      />

      <EffectComposer>
        {/* Bloom tuned to mirror DeusData/codebase-memory-mcp's graph-ui:
            threshold 0.3 so only the over-driven node colors bloom, not the
            line strokes; radius 0.6 keeps haloes tight enough to read each
            node distinctly even when several overlap. */}
        <Bloom luminanceThreshold={0.3} luminanceSmoothing={0.7} radius={0.6} mipmapBlur intensity={0.85} />
      </EffectComposer>
    </Canvas>
  )
}

/* ---------- NodeCloud — instanced spheres via Drei <Instances> ------- */

interface NodeCloudProps {
  entities: KBEntity[]
  positions3D: Record<string, THREE.Vector3>
  selectedId: string | null
  hoveredId: string | null
  highlightedIds: Set<string> | null
  onSelect: (entity: KBEntity | null) => void
  onHover: (id: string | null) => void
}

function NodeCloud({ entities, positions3D, selectedId, hoveredId, highlightedIds, onSelect, onHover }: NodeCloudProps) {
  // Tmp color we re-use to build each instance's final color cheaply.
  const tmpColor = useMemo(() => new THREE.Color(), [])

  // Drei requires `limit` >= max possible instance count; pad lightly so
  // the next 10s poll's growth doesn't require a remount.
  const limit = Math.max(64, entities.length + 32)

  return (
    <Instances limit={limit} range={entities.length} frustumCulled={false}>
      <sphereGeometry args={[1, 24, 18]} />
      {/* `toneMapped={false}` keeps boosted colors above 1.0 so Bloom can
          turn them into proper halos around selected/hovered nodes. */}
      <meshBasicMaterial toneMapped={false} />

      {entities.map((entity) => {
        const pos = positions3D[entity.id]
        if (!pos) return null

        const inFilter = !highlightedIds || highlightedIds.has(entity.id)
        const isSelected = selectedId === entity.id
        const isHovered = hoveredId === entity.id

        // Size by importance + interaction state.
        const baseSize = SIZE_BOOST_TYPES.has(entity.type) ? 12 : 8
        const sizeMult = isSelected ? 1.7 : isHovered ? 1.35 : 1
        const size = baseSize * sizeMult

        // Color: base type color, then dim hard outside the filter, or
        // boost > 1.0 so the Bloom pass picks every visible node up as a
        // glowing star — even idle nodes get a halo. Selection ramps the
        // brightness further so the focus point reads as the brightest
        // body in the field.
        tmpColor.set(TYPE_COLORS[entity.type] || '#cdd6f4')
        if (!inFilter) tmpColor.multiplyScalar(0.15)
        else if (isSelected) tmpColor.multiplyScalar(2.6)
        else if (isHovered) tmpColor.multiplyScalar(2.0)
        else tmpColor.multiplyScalar(1.55) // baseline glow

        return (
          <Instance
            key={entity.id}
            position={[pos.x, pos.y, pos.z]}
            scale={[size, size, size]}
            color={tmpColor.clone()}
            onClick={(e: ThreeEvent<MouseEvent>) => {
              e.stopPropagation()
              onSelect(entity)
            }}
            onPointerOver={(e: ThreeEvent<PointerEvent>) => {
              e.stopPropagation()
              onHover(entity.id)
            }}
            onPointerOut={() => onHover(null)}
          />
        )
      })}
    </Instances>
  )
}

/* ---------- EdgeLines — line segments with per-vertex color ---------- */

interface EdgeLinesProps {
  edges: Edge3D[]
  positions3D: Record<string, THREE.Vector3>
  selectedId: string | null
  highlightedIds: Set<string> | null
}

function EdgeLines({ edges, positions3D, selectedId, highlightedIds }: EdgeLinesProps) {
  // Two layered geometries:
  //   1. "idle" — every (in-filter) edge, rendered at very low opacity so
  //      the structural skeleton is visible without burying the nodes.
  //   2. "incident" — only edges touching the selected node, rendered on
  //      top with higher opacity so the focus subgraph reads instantly.
  //
  // Splitting them lets each use a single solid color via the material's
  // own `color`+`opacity`, instead of trying to encode brightness through
  // per-vertex colors (which interact badly with sRGB output + bloom
  // accumulation when many lines overlap).
  const { idleGeo, incidentGeo } = useMemo(() => {
    const idlePos: number[] = []
    const incPos: number[] = []
    for (const e of edges) {
      const a = positions3D[e.source]
      const b = positions3D[e.target]
      if (!a || !b) continue

      const incidentToSelected = selectedId !== null && (e.source === selectedId || e.target === selectedId)
      const inFilter = highlightedIds === null || (highlightedIds.has(e.source) && highlightedIds.has(e.target))

      if (incidentToSelected) {
        incPos.push(a.x, a.y, a.z, b.x, b.y, b.z)
      } else if (inFilter) {
        // Skip out-of-filter edges entirely (rather than dim them) — keeps
        // the project subgraph clean when a filter is active.
        idlePos.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    }
    const ig = new THREE.BufferGeometry()
    ig.setAttribute('position', new THREE.Float32BufferAttribute(idlePos, 3))
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.Float32BufferAttribute(incPos, 3))
    return { idleGeo: ig, incidentGeo: sg }
  }, [edges, positions3D, selectedId, highlightedIds])

  // Three.js does not GC geometries — dispose explicitly on next swap.
  useEffect(() => () => { idleGeo.dispose(); incidentGeo.dispose() }, [idleGeo, incidentGeo])

  return (
    <>
      {/* Idle skeleton — extremely translucent. `depthWrite={false}` so
          these never occlude the nodes behind them, and the chosen color
          + opacity stay well under the bloom luminance threshold even
          when many lines pile up on the same screen pixel. */}
      <lineSegments frustumCulled={false}>
        <primitive object={idleGeo} attach="geometry" />
        <lineBasicMaterial
          color="#5b8a6e"
          transparent
          opacity={0.10}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>

      {/* Incident-to-selected — soft bright blue, rendered after the idle
          layer so it always sits on top regardless of camera angle. */}
      <lineSegments frustumCulled={false}>
        <primitive object={incidentGeo} attach="geometry" />
        <lineBasicMaterial
          color="#8ab0ff"
          transparent
          opacity={0.85}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>
    </>
  )
}

/* ---------- HoverLabel — HTML overlay above the focused sphere ------- */

interface HoverLabelProps {
  entities: KBEntity[]
  positions3D: Record<string, THREE.Vector3>
  hoveredId: string | null
  selectedId: string | null
}

function HoverLabel({ entities, positions3D, hoveredId, selectedId }: HoverLabelProps) {
  const targetId = hoveredId ?? selectedId
  if (!targetId) return null
  const entity = entities.find((e) => e.id === targetId)
  const pos = entity ? positions3D[entity.id] : undefined
  if (!entity || !pos) return null

  return (
    <Html position={pos} center distanceFactor={320} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div className="kb3d-label">
        <span className="kb3d-label-type" style={{ color: TYPE_COLORS[entity.type] || '#cdd6f4' }}>
          {entity.type}
        </span>
        <span className="kb3d-label-name">{entity.title}</span>
      </div>
    </Html>
  )
}

/* ---------- 3D layout ------------------------------------------------ */

/**
 * Multi-galaxy layout: groups entities by type, places one cluster at the
 * origin (the highest-priority type that exists) and distributes the rest
 * on a Fibonacci sphere around it. Each cluster scatters its entities
 * with cube-root radial sampling so the volume looks evenly filled
 * instead of bunched in the center.
 *
 * Everything is deterministic in `entity.id` — no force simulation, no
 * shimmer across renders.
 */
function compute3DPositions(entities: KBEntity[]): Record<string, THREE.Vector3> {
  const positions: Record<string, THREE.Vector3> = {}
  if (entities.length === 0) return positions

  // Group by type, preserve priority ordering for stable galaxy placement.
  const groups = new Map<string, KBEntity[]>()
  for (const e of entities) {
    const list = groups.get(e.type) || []
    list.push(e)
    groups.set(e.type, list)
  }
  const types = [...groups.keys()].sort((a, b) => {
    const ia = TYPE_PRIORITY.indexOf(a)
    const ib = TYPE_PRIORITY.indexOf(b)
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })

  // Internal cluster radius scales with cbrt(count) so a 100-node cluster
  // doesn't dwarf a 4-node one. Tunable for visual density.
  const NODE_SPACING = 14
  const MIN_CLUSTER_R = 38
  const clusterRadii = new Map<string, number>()
  for (const t of types) {
    const n = groups.get(t)!.length
    clusterRadii.set(t, Math.max(MIN_CLUSTER_R, NODE_SPACING * Math.cbrt(n) * 2.4))
  }

  // Cluster centers: first type at origin (nucleus); the rest on a
  // Fibonacci sphere. Sphere radius is chosen so the closest cluster
  // surfaces don't overlap.
  const centers = new Map<string, THREE.Vector3>()
  centers.set(types[0], new THREE.Vector3(0, 0, 0))

  const nucleusR = clusterRadii.get(types[0])!
  const maxOuterR = Math.max(...types.slice(1).map((t) => clusterRadii.get(t)!), 0)
  // Enough breathing room: nucleus + biggest outer + gap, padded by sqrt(N)
  // so many small galaxies still get spaced apart.
  const ORBIT_PAD = 220
  const orbitR = nucleusR + maxOuterR + ORBIT_PAD + Math.sqrt(types.length) * 40

  const outer = types.slice(1)
  const N = outer.length
  const GOLDEN = Math.PI * (3 - Math.sqrt(5))

  outer.forEach((type, i) => {
    // Standard Fibonacci-sphere distribution: even coverage of the sphere.
    const t = N === 1 ? 0.5 : (i + 0.5) / N
    const phi = Math.acos(1 - 2 * t)
    const theta = GOLDEN * i
    // Per-galaxy hash-based jitter so it doesn't look like a Lego mold.
    const h = hashString(type)
    const jPhi = ((h & 0xFF) / 0xFF - 0.5) * 0.15
    const jTheta = (((h >> 8) & 0xFF) / 0xFF - 0.5) * 0.25
    const jR = (((h >> 16) & 0xFF) / 0xFF - 0.5) * orbitR * 0.18
    const R = orbitR + jR
    const a = phi + jPhi
    const b = theta + jTheta
    centers.set(type, new THREE.Vector3(
      R * Math.sin(a) * Math.cos(b),
      R * Math.cos(a),
      R * Math.sin(a) * Math.sin(b),
    ))
  })

  // Scatter entities inside each cluster — deterministic spherical samples.
  for (const [type, list] of groups) {
    const center = centers.get(type)!
    const radius = clusterRadii.get(type)!
    list.forEach((entity) => {
      const h = hashString(entity.id)
      const r1 = ((h & 0xFFFF) / 0xFFFF)
      const r2 = (((h >> 16) & 0xFFFF) / 0xFFFF)
      const r3 = (((h >> 8) ^ (h >> 24)) & 0xFFFF) / 0xFFFF
      const phi = Math.acos(1 - 2 * r1)
      const theta = 2 * Math.PI * r2
      // Cube-root for uniform volumetric density (linear r would clump
      // every node near the centre).
      const r = radius * Math.cbrt(r3)
      positions[entity.id] = new THREE.Vector3(
        center.x + r * Math.sin(phi) * Math.cos(theta),
        center.y + r * Math.cos(phi),
        center.z + r * Math.sin(phi) * Math.sin(theta),
      )
    })
  }

  return positions
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}
