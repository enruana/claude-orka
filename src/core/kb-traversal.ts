/**
 * Weighted graph traversal for the Orka KB.
 *
 * Replaces the v1 uniform 2-hop BFS (which pulled in tons of off-topic
 * entities through any shared meeting or person) with a relevance-scored
 * walk that respects edge semantics:
 *
 * - Edge-type weights: subtask-of/scope-of carry more signal than relates-to
 * - Hop decay: each step weakens the score multiplicatively
 * - Confidence factor: from edge qualifiers (P4) — drops uncertain links
 * - Type allow-list: callers pick which entity types are relevant
 * - Top-N cap: cut by score, not by depth
 *
 * The traversal is undirected (we walk both incoming and outgoing edges)
 * because users care about "everything related to" not "everything below".
 * Direction is encoded in the relation type, not the walk.
 */

import { KBEntity } from '../models'

// --------------------------------------------------------------------------
// Edge weights
// --------------------------------------------------------------------------

/**
 * Default weights for each relation. Higher = stronger signal that the
 * connected entity is relevant to the current context.
 *
 * Values come from the v2 design: structural relations (subtask-of, scope-of,
 * child-of) are most signal-bearing. Provenance edges (generated-by) are
 * weak in the project-context sense — knowing which skill produced an entity
 * doesn't tell you the entity is relevant to a project.
 */
export const DEFAULT_EDGE_WEIGHTS: Record<string, number> = {
  // Hierarchy
  'subtask-of': 1.0,
  'scope-of': 1.0,
  'child-of': 1.0,
  // Knowledge → work
  'addresses': 0.9,
  'answers': 0.9,
  'implements': 0.85,
  // Knowledge ↔ meeting
  'decided-at': 0.85,
  'raised-at': 0.85,
  // Lifecycle
  'blocks': 0.75,
  'depends-on': 0.75,
  'supersedes': 0.7,
  // Provenance — useful for audit, weak for relevance
  'sourced-from': 0.6,
  'derived-from': 0.6,
  'attributed-to': 0.55,
  'generated-by': 0.4,
  // Categorical — weakest signals
  'attended-by': 0.35,
  'assigned-to': 0.5,
  'references': 0.3,
  'owned-by': 0.5,
  'relates-to': 0.3,
  // Deprecated — generous weight so backward-compat KBs (most legacy
  // links use 'part-of') don't lose their structure before P9 migration
  // converts them to typed relations.
  'part-of': 0.85,
  'contributes-to': 0.5,
}

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

export interface TraversalConfig {
  /** Edge-type → weight mapping. Defaults to DEFAULT_EDGE_WEIGHTS. */
  weights?: Record<string, number>
  /** Default weight for relations not in the weights map. */
  fallbackWeight?: number
  /** Multiplicative decay per hop. 0.6 means each hop loses 40% of score. */
  hopDecay?: number
  /** Maximum hop depth to explore. */
  maxHops?: number
  /** Score below which results are dropped. */
  minScore?: number
  /** Cap on total entities returned (sorted by score). */
  maxResults?: number
  /** If set, only include entities of these types in the result. */
  typeFilter?: string[]
  /** Drop edges below this confidence (from qualifiers.confidence). */
  minConfidence?: number
}

const DEFAULTS: Required<TraversalConfig> = {
  weights: DEFAULT_EDGE_WEIGHTS,
  fallbackWeight: 0.2,
  hopDecay: 0.6,
  maxHops: 3,
  minScore: 0.15,
  maxResults: 50,
  typeFilter: [],
  minConfidence: 0.0,
}

// --------------------------------------------------------------------------
// Breadth presets
// --------------------------------------------------------------------------

/**
 * Convenience presets for the `--breadth` CLI flag.
 *
 * - narrow : only direct neighbors with strong relations (1 hop, score ≥ 0.7)
 * - medium : 2 hops, mostly structural relations (default)
 * - wide   : 3 hops, includes weak/categorical edges
 */
export const BREADTH_PRESETS: Record<'narrow' | 'medium' | 'wide', TraversalConfig> = {
  narrow: {
    maxHops: 1,
    minScore: 0.5,
    hopDecay: 0.85,
    maxResults: 25,
  },
  medium: {
    maxHops: 2,
    minScore: 0.2,
    hopDecay: 0.7,
    maxResults: 60,
  },
  wide: {
    maxHops: 3,
    minScore: 0.1,
    hopDecay: 0.55,
    maxResults: 120,
  },
}

// --------------------------------------------------------------------------
// Traversal
// --------------------------------------------------------------------------

export interface ScoredEntity {
  entity: KBEntity
  score: number
  /** Hop distance from the seed entity. */
  depth: number
  /** Path of relations followed from seed (e.g. ['scope-of', 'addresses']). */
  path: string[]
}

/**
 * Run weighted traversal from a seed entity. Returns scored entities sorted
 * descending by relevance.
 *
 * The seed itself is included with score 1.0 unless excluded by the type
 * filter.
 */
export function weightedTraversal(
  seedId: string,
  allEntities: KBEntity[],
  config: TraversalConfig = {}
): ScoredEntity[] {
  const cfg: Required<TraversalConfig> = { ...DEFAULTS, ...config }
  const weights = cfg.weights || DEFAULT_EDGE_WEIGHTS

  const byId = new Map<string, KBEntity>()
  for (const e of allEntities) byId.set(e.id, e)

  const seed = byId.get(seedId)
  if (!seed) return []

  // Build undirected adjacency: entity → list of {neighborId, relation, confidence, direction}
  const adjacency = new Map<string, Array<{ to: string; relation: string; confidence: number; outgoing: boolean }>>()
  for (const e of allEntities) {
    if (!adjacency.has(e.id)) adjacency.set(e.id, [])
    for (const edge of e.edges) {
      const conf = edge.qualifiers?.confidence ?? 1.0
      // outgoing
      adjacency.get(e.id)!.push({
        to: edge.target,
        relation: edge.relation,
        confidence: conf,
        outgoing: true,
      })
      // incoming on the target side
      if (!adjacency.has(edge.target)) adjacency.set(edge.target, [])
      adjacency.get(edge.target)!.push({
        to: e.id,
        relation: edge.relation,
        confidence: conf,
        outgoing: false,
      })
    }
  }

  // Score each reachable entity. Use BFS-like exploration with score
  // accumulation; if we reach the same entity through multiple paths,
  // keep the best score.
  const best = new Map<string, ScoredEntity>()
  best.set(seedId, { entity: seed, score: 1.0, depth: 0, path: [] })

  const queue: Array<{ id: string; score: number; depth: number; path: string[] }> = [
    { id: seedId, score: 1.0, depth: 0, path: [] },
  ]

  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur.depth >= cfg.maxHops) continue

    const links = adjacency.get(cur.id) || []
    for (const link of links) {
      if (link.confidence < cfg.minConfidence) continue
      const w = weights[link.relation] ?? cfg.fallbackWeight
      const newScore = cur.score * w * cfg.hopDecay * link.confidence
      if (newScore < cfg.minScore) continue

      const neighbor = byId.get(link.to)
      if (!neighbor) continue

      const newPath = [...cur.path, link.relation]
      const existing = best.get(link.to)
      if (!existing || newScore > existing.score) {
        best.set(link.to, {
          entity: neighbor,
          score: newScore,
          depth: cur.depth + 1,
          path: newPath,
        })
        queue.push({ id: link.to, score: newScore, depth: cur.depth + 1, path: newPath })
      }
    }
  }

  // Filter by type and rank
  let results = Array.from(best.values())
  if (cfg.typeFilter && cfg.typeFilter.length > 0) {
    results = results.filter(
      (r) => r.entity.id === seedId || cfg.typeFilter.includes(String(r.entity.type))
    )
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, cfg.maxResults)
}

/**
 * Convenience: get just the entity IDs from a traversal, useful as a
 * drop-in replacement for the v1 BFS that returned an id Set.
 */
export function relatedEntityIds(
  seedId: string,
  allEntities: KBEntity[],
  config: TraversalConfig = {}
): Set<string> {
  return new Set(weightedTraversal(seedId, allEntities, config).map((r) => r.entity.id))
}
