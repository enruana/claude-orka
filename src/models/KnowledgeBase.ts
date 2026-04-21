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

export interface KBEdge {
  relation: string
  target: string
  since: string
  eventRef?: string
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
