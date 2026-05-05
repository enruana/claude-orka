/**
 * v1 → v2 KB Migrator.
 *
 * Reads current entity files + events.jsonl, computes a list of migration
 * actions, optionally writes them back as new events. The event log is
 * append-only — migrations never destroy history.
 *
 * Migration steps (in order):
 *   1. type:reference → type:artifact
 *   2. status normalization per type
 *   3. deprecated relations (part-of, contributes-to) → typed relations
 *   4. edge qualifiers backfill
 *   5. (manual via /kb-classify) project → task/spike/bug/initiative
 *   6. (manual via /kb-track) MADR fields for decisions
 *
 * Each step emits a `kb.migration` event for auditability. Run in dry-run
 * first to see the plan; then with apply=true to commit.
 */

import path from 'path'
import fs from 'fs-extra'
import { KBEdge } from '../models'
import { KB_RELATIONS, KB_TYPE_PREFIXES, KBTypeStrict, isKnownType } from '../models'
import { KnowledgeBaseManager } from './KnowledgeBaseManager'

export interface MigrationAction {
  kind:
    | 'reclassify_type'
    | 'normalize_status'
    | 'rewrite_relation'
    | 'backfill_qualifiers'
    | 'backfill_property'
    | 'reclassify_relation_constraint'
  entityId: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  reason: string
}

export interface MigrationPlan {
  actions: MigrationAction[]
  byKind: Record<string, number>
  totalEntities: number
}

/**
 * Status normalizations from v1 to v2.
 *
 * Decisions: v1 used "active" generically. In v2, decisions only allow
 * proposed/accepted/rejected/superseded. The vast majority of v1 "active"
 * decisions are decisions that were ACCEPTED — they appear in INDEX.md
 * as committed choices, not pending proposals. Bias toward `accepted`
 * for backward-compat. Users who need `proposed` can override afterwards.
 */
const STATUS_NORMALIZATION: Record<string, Record<string, string>> = {
  meeting: { completed: 'held', active: 'held' },
  milestone: { completed: 'reached' },
  question: { /* answered/resolved both stay valid */ },
  decision: { active: 'accepted' },
}

const TYPE_RECLASSIFICATION: Record<string, string> = {
  reference: 'artifact',
}

/**
 * Given a deprecated `part-of` edge between two entity types, return the
 * v2 relation that best replaces it. Returns null if the pair has no
 * obvious mapping (caller should leave the edge as-is and warn).
 */
function disambiguatePartOf(sourceType: string, targetType: string): string | null {
  // Hierarchy
  if (sourceType === 'task' && targetType === 'project') return 'scope-of'
  if (sourceType === 'spike' && targetType === 'project') return 'scope-of'
  if (sourceType === 'task' && targetType === 'task') return 'subtask-of'
  if (sourceType === 'task' && (targetType === 'spike' || targetType === 'bug')) return 'subtask-of'
  if (sourceType === 'bug' && targetType === 'project') return 'child-of'
  if (sourceType === 'project' && targetType === 'initiative') return 'child-of'
  if (sourceType === 'project' && targetType === 'project') return 'child-of'
  if (sourceType === 'initiative' && targetType === 'goal') return 'child-of'

  // Knowledge → work
  if (sourceType === 'decision' && targetType === 'project') return 'addresses'
  if (sourceType === 'question' && targetType === 'project') return 'addresses'
  if (sourceType === 'milestone' && targetType === 'project') return 'addresses'

  // Reference → repo/project
  if (sourceType === 'artifact' && targetType === 'repo') return 'references'
  if (sourceType === 'artifact' && targetType === 'project') return 'references'
  if (sourceType === 'artifact' && targetType === 'direction') return 'references'
  if (sourceType === 'context' && targetType === 'project') return 'references'

  // Person assignments
  if (sourceType === 'person' && (targetType === 'project' || targetType === 'initiative')) return 'assigned-to'
  if (sourceType === 'repo' && (targetType === 'project' || targetType === 'initiative')) return 'references'

  // Provenance / authorship
  if (sourceType === 'decision' && targetType === 'person') return 'attributed-to'
  if (sourceType === 'artifact' && targetType === 'person') return 'attributed-to'

  // Meeting → project: "happened for this project"
  if (sourceType === 'meeting' && targetType === 'project') return 'relates-to'

  // Direction → direction: sub-direction or related strategy
  if (sourceType === 'direction' && targetType === 'direction') return 'relates-to'

  return null
}

function disambiguateContributesTo(sourceType: string, targetType: string): string | null {
  if (sourceType === 'person') return 'relates-to'
  // repo contributes-to project — repo is referenced by the project
  if (sourceType === 'repo' && (targetType === 'project' || targetType === 'initiative')) return 'references'
  return null
}

export class KBMigrator {
  constructor(private manager: KnowledgeBaseManager, private projectPath: string) {}

  /**
   * Compute the migration plan without writing anything.
   */
  async computePlan(): Promise<MigrationPlan> {
    const entities = await this.manager.listEntities()
    const actions: MigrationAction[] = []
    const byTypeMap = new Map<string, string>()
    for (const e of entities) byTypeMap.set(e.id, String(e.type))

    for (const e of entities) {
      const type = String(e.type)

      // 1. Type reclassification
      if (TYPE_RECLASSIFICATION[type]) {
        actions.push({
          kind: 'reclassify_type',
          entityId: e.id,
          before: { type },
          after: { type: TYPE_RECLASSIFICATION[type], tag: type },
          reason: `Type "${type}" not in v2 registry — reclassify as ${TYPE_RECLASSIFICATION[type]} with tag.`,
        })
      }

      // 2. Status normalization
      const norm = STATUS_NORMALIZATION[type]?.[String(e.status)]
      if (norm) {
        actions.push({
          kind: 'normalize_status',
          entityId: e.id,
          before: { status: e.status },
          after: { status: norm },
          reason: `v1 status "${e.status}" not valid for v2 type "${type}" — normalize to "${norm}".`,
        })
      }

      // 3. Relation rewrites (deprecated → typed)
      for (const edge of e.edges) {
        const def = KB_RELATIONS[edge.relation]
        if (!def?.deprecated) continue

        const targetType = byTypeMap.get(edge.target) || ''
        let newRelation: string | null = null
        if (edge.relation === 'part-of') {
          newRelation = disambiguatePartOf(type, targetType)
        } else if (edge.relation === 'contributes-to') {
          newRelation = disambiguateContributesTo(type, targetType)
        }

        if (newRelation) {
          actions.push({
            kind: 'rewrite_relation',
            entityId: e.id,
            before: { relation: edge.relation, target: edge.target, sourceType: type, targetType },
            after: { relation: newRelation },
            reason: `${edge.relation} between ${type} and ${targetType} → ${newRelation} (typed).`,
          })
        }
      }

      // 4. Backfill description from rationale/resolution/notes for entities
      //    that need it. v1 was lax about `description`; v2 expects it on
      //    work + knowledge tier entities. If a synonym property is set,
      //    promote it as description.
      const NEEDS_DESCRIPTION = ['decision', 'direction', 'project', 'task', 'spike', 'bug', 'goal', 'initiative']
      if (NEEDS_DESCRIPTION.includes(type) && !e.properties.description) {
        const fallback = (e.properties.rationale ||
                          e.properties.resolution ||
                          e.properties.notes ||
                          e.properties.summary ||
                          e.properties.body) as string | undefined
        if (fallback && typeof fallback === 'string' && fallback.trim()) {
          actions.push({
            kind: 'backfill_property',
            entityId: e.id,
            before: { description: undefined },
            after: { property: 'description', value: fallback },
            reason: `Backfill description from existing rationale/resolution/notes property.`,
          })
        }
      }

      // 5. Backfill qualifiers (only if missing — hydrateEdgeQualifiers
      //    handles read-side, but we want them persisted for clean writes)
      for (const edge of e.edges) {
        if (!edge.qualifiers) {
          actions.push({
            kind: 'backfill_qualifiers',
            entityId: e.id,
            before: { relation: edge.relation, target: edge.target, since: edge.since },
            after: {
              qualifiers: {
                at: edge.since,
                by: 'unknown',
                source: edge.eventRef,
              },
            },
            reason: `Edge missing qualifiers — backfill from since/eventRef.`,
          })
        }
      }
    }

    const byKind: Record<string, number> = {}
    for (const a of actions) byKind[a.kind] = (byKind[a.kind] || 0) + 1

    return {
      actions,
      byKind,
      totalEntities: entities.length,
    }
  }

  /**
   * Apply the plan. Each action emits an event so the migration is
   * fully replayable and auditable.
   */
  async apply(plan: MigrationPlan): Promise<{ applied: number; failed: number; events: number }> {
    let applied = 0
    let failed = 0
    let events = 0

    // Emit a marker event so the migration boundary is visible in the timeline
    await this.manager.appendEvent({
      type: 'kb.migration.start',
      actor: 'migration',
      data: { from: 1, to: 2, action_count: plan.actions.length },
    })
    events++

    // Group actions by entity to minimize re-reads
    const byEntity = new Map<string, MigrationAction[]>()
    for (const a of plan.actions) {
      if (!byEntity.has(a.entityId)) byEntity.set(a.entityId, [])
      byEntity.get(a.entityId)!.push(a)
    }

    for (const [entityId, list] of byEntity) {
      const entity = await this.manager.getEntity(entityId)
      if (!entity) {
        failed += list.length
        continue
      }

      let mutated = false

      for (const action of list) {
        try {
          await this.manager.appendEvent({
            type: 'kb.migration.action',
            entityId,
            actor: 'migration',
            data: {
              kind: action.kind,
              before: action.before,
              after: action.after,
              reason: action.reason,
            },
          })
          events++

          switch (action.kind) {
            case 'reclassify_type': {
              const newType = String(action.after.type)
              const tag = String(action.after.tag)
              entity.type = newType
              if (!entity.tags.includes(tag)) entity.tags.push(tag)
              mutated = true
              break
            }
            case 'normalize_status': {
              entity.status = String(action.after.status)
              mutated = true
              break
            }
            case 'rewrite_relation': {
              const oldRelation = String(action.before.relation)
              const target = String(action.before.target)
              const newRelation = String(action.after.relation)
              const edge = entity.edges.find(
                (e) => e.relation === oldRelation && e.target === target
              )
              if (edge) {
                edge.relation = newRelation
                mutated = true
              }
              break
            }
            case 'backfill_qualifiers': {
              const target = String(action.before.target)
              const relation = String(action.before.relation)
              const edge = entity.edges.find(
                (e) => e.relation === relation && e.target === target
              )
              if (edge && !edge.qualifiers) {
                edge.qualifiers = action.after.qualifiers as KBEdge['qualifiers']
                mutated = true
              }
              break
            }
            case 'backfill_property': {
              const prop = String(action.after.property)
              const value = action.after.value
              if (!entity.properties[prop]) {
                entity.properties[prop] = value
                mutated = true
              }
              break
            }
          }

          applied++
        } catch (err) {
          failed++
          await this.manager.appendEvent({
            type: 'kb.migration.error',
            entityId,
            actor: 'migration',
            data: { kind: action.kind, error: String(err) },
          })
          events++
        }
      }

      if (mutated) {
        // Persist the entity directly (we've bypassed the validator on purpose
        // — the entity is being moved INTO compliance, so v2 rules can't
        // pre-validate). Write directly to disk.
        const filePath = path.join(this.projectPath, '.claude-orka', '.orka-kb', 'entities', `${entity.id}.json`)
        await fs.writeJson(filePath, entity, { spaces: 2 })
      }
    }

    // Final pass: persist every entity to disk so their (in-memory hydrated)
    // qualifiers and any other v2 shape get committed to the file system.
    // This is idempotent — entities that already have qualifiers stay the same.
    const allEntities = await this.manager.listEntities()
    let qualifiersWritten = 0
    for (const e of allEntities) {
      const filePath = path.join(this.projectPath, '.claude-orka', '.orka-kb', 'entities', `${e.id}.json`)
      const raw = (await fs.readJson(filePath)) as { edges: Array<{ qualifiers?: unknown }> }
      const needsWrite = raw.edges.some((edge) => !edge.qualifiers)
      if (needsWrite) {
        await fs.writeJson(filePath, e, { spaces: 2 })
        qualifiersWritten++
      }
    }

    await this.manager.appendEvent({
      type: 'kb.migration.complete',
      actor: 'migration',
      data: {
        applied,
        failed,
        total: plan.actions.length,
        qualifiers_persisted: qualifiersWritten,
      },
    })
    events++

    return { applied, failed, events }
  }

  /**
   * Reclassify an entity to a new type — changes the id (new prefix), updates
   * all referencing edges, and writes a new file. Destructive but reversible
   * via event replay.
   *
   * Returns the new id so callers can chain or report.
   *
   * Strategy:
   *   1. Compute new id = `<new-prefix>-<nanoid>` (preserve nanoid suffix)
   *   2. Emit `kb.migration.reclassified` event so sync can replay
   *   3. Walk all entities, rewrite any edge whose target was the old id
   *   4. Write the entity file under the new id, delete old file
   */
  async reclassify(oldId: string, newType: KBTypeStrict): Promise<{
    newId: string
    edgesUpdated: number
    sameId: boolean
  }> {
    if (!isKnownType(newType)) {
      throw new Error(`Unknown target type: ${newType}`)
    }
    const entity = await this.manager.getEntity(oldId)
    if (!entity) throw new Error(`Entity not found: ${oldId}`)

    const newPrefix = KB_TYPE_PREFIXES[newType]
    const idDashIdx = oldId.indexOf('-')
    if (idDashIdx === -1) throw new Error(`Cannot parse id: ${oldId}`)
    const nanoidPart = oldId.substring(idDashIdx + 1)
    const newId = `${newPrefix}-${nanoidPart}`

    // No-op if id and type already match
    if (newId === oldId && entity.type === newType) {
      return { newId, edgesUpdated: 0, sameId: true }
    }

    const oldType = entity.type

    // Append the reclassification event (for full audit + sync replay)
    await this.manager.appendEvent({
      type: 'kb.migration.reclassified',
      entityId: oldId,
      actor: 'migration',
      data: {
        old_id: oldId,
        new_id: newId,
        old_type: oldType,
        new_type: newType,
      },
      refs: newId !== oldId ? [newId] : [],
    })

    const entitiesDir = path.join(this.projectPath, '.claude-orka', '.orka-kb', 'entities')

    // Rewrite edges in all OTHER entities that target the old id
    let edgesUpdated = 0
    if (newId !== oldId) {
      const allEntities = await this.manager.listEntities()
      for (const e of allEntities) {
        if (e.id === oldId) continue
        let mutated = false
        for (const edge of e.edges) {
          if (edge.target === oldId) {
            edge.target = newId
            mutated = true
            edgesUpdated++
          }
        }
        if (mutated) {
          await fs.writeJson(path.join(entitiesDir, `${e.id}.json`), e, { spaces: 2 })
        }
      }
    }

    // Update entity itself: change type and id
    entity.type = newType
    entity.id = newId
    entity.updated = new Date().toISOString()
    entity.history.push({
      ts: entity.updated,
      event: 'reclassified',
      summary: `Reclassified from ${oldType} (${oldId}) to ${newType}`,
    })

    // Write new file, delete old one
    await fs.writeJson(path.join(entitiesDir, `${newId}.json`), entity, { spaces: 2 })
    if (newId !== oldId) {
      await fs.remove(path.join(entitiesDir, `${oldId}.json`))
    }

    return { newId, edgesUpdated, sameId: newId === oldId }
  }

  /**
   * Backup the current events.jsonl before applying.
   */
  async backup(): Promise<string> {
    const eventsPath = path.join(this.projectPath, '.claude-orka', '.orka-kb', 'events.jsonl')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = path.join(this.projectPath, '.claude-orka', '.orka-kb', `events.jsonl.pre-v2-${stamp}.bak`)
    if (await fs.pathExists(eventsPath)) {
      await fs.copy(eventsPath, backupPath)
    }
    return backupPath
  }
}
