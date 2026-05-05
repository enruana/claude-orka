// --- Entity Types ---

export type KBEntityType =
  | 'decision'
  | 'meeting'
  | 'question'
  | 'person'
  | 'direction'
  | 'repo'
  | 'artifact'
  | 'milestone'
  | 'context'
  | 'project'
  | (string & {})

export type KBEntityStatus =
  | 'active'
  | 'in-progress'
  | 'blocked'
  | 'pending'
  | 'review'
  | 'draft'
  | 'resolved'
  | 'superseded'
  | 'archived'
  | (string & {})

// --- Edges ---

/**
 * Edge-level metadata (Wikidata "qualifiers" pattern). Carries audit trail
 * and contextual info on each link without requiring edge reification.
 *
 * - `at` / `by`     : timestamp + actor that created the edge
 * - `source`        : event id (so each edge points back to its origin event)
 * - `confidence`    : 0..1 — useful when a relation is LLM-suggested
 * - `role`          : optional role-in-context, e.g. assigned-to{role: 'reviewer'}
 * - `note`          : freeform short comment for humans
 *
 * Free-form extension is allowed — `qualifiers` is a Record<string, unknown>
 * keyed by string. The fields above are conventions; tooling reads them but
 * extra keys are preserved.
 */
export interface KBEdgeQualifiers {
  at: string
  by: string
  source?: string
  confidence?: number
  role?: string
  note?: string
  [extra: string]: unknown
}

export interface KBEdge {
  relation: string
  target: string
  /**
   * Legacy v1 field. Mirrored from qualifiers.at for backward-compat.
   * New code should read qualifiers.at.
   */
  since: string
  /**
   * Legacy v1 field. Mirrored from qualifiers.source.
   * New code should read qualifiers.source.
   */
  eventRef?: string
  /** v2 — present on edges created since schema v2; back-filled lazily on read. */
  qualifiers?: KBEdgeQualifiers
}

// --- Entity ---

export interface KBEntityHistoryEntry {
  ts: string
  event: string
  summary: string
}

export interface KBEntity {
  id: string
  type: KBEntityType
  title: string
  status: KBEntityStatus
  created: string
  updated: string
  properties: Record<string, unknown>
  edges: KBEdge[]
  tags: string[]
  history: KBEntityHistoryEntry[]
}

// --- Events ---

export type KBEventType =
  | 'kb.init'
  | 'kb.migrate'
  | 'entity.created'
  | 'entity.updated'
  | 'entity.archived'
  | 'edge.created'
  | 'edge.removed'
  | (string & {})

export interface KBEvent {
  id: string
  ts: string
  type: KBEventType
  entityId?: string
  actor: string
  data: Record<string, unknown>
  refs?: string[]
}

// --- Index ---

export interface KBIndexEntityEntry {
  type: KBEntityType
  title: string
  status: KBEntityStatus
}

export interface KBIndexEdge {
  source: string
  relation: string
  target: string
}

export interface KBIndex {
  project: string
  generatedAt: string
  stats: {
    entities: number
    edges: number
    events: number
    byType: Record<string, number>
  }
  entities: Record<string, KBIndexEntityEntry>
  edges: KBIndexEdge[]
}

// --- Filters ---

export interface KBEntityFilter {
  type?: KBEntityType
  status?: KBEntityStatus
  tag?: string
}

export interface KBTimelineFilter {
  since?: string
  limit?: number
}
