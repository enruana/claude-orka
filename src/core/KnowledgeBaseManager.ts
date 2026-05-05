import path from 'path'
import fs from 'fs-extra'
import { nanoid } from 'nanoid'
import execa from 'execa'
import {
  KBEntity,
  KBEvent,
  KBEntityType,
  KBEntityStatus,
  KBEdge,
  KBIndex,
  KBEntityFilter,
  KBTimelineFilter,
  KB_TYPE_PREFIXES,
  KBTypeStrict,
  ValidationMode,
  ValidationResult,
  validateEntityCreation,
  validateEntityUpdate,
  validateEdge,
  formatResult,
} from '../models'
import { BREADTH_PRESETS, relatedEntityIds } from './kb-traversal'

const KB_DIR = path.join('.claude-orka', '.orka-kb')
const EVENTS_FILE = 'events.jsonl'
const ENTITIES_DIR = 'entities'
const VIEWS_DIR = 'views'

function generateId(type: string): string {
  const prefix = KB_TYPE_PREFIXES[type as KBTypeStrict] || type.slice(0, 3)
  return `${prefix}-${nanoid(8)}`
}

export interface AddEntityOptions {
  status?: KBEntityStatus
  properties?: Record<string, unknown>
  tags?: string[]
  edges?: Array<{ relation: string; target: string }>
  actor?: string
  /**
   * Validation mode override. Defaults to the manager's instance mode.
   * - 'strict' — errors throw, warnings printed
   * - 'draft'  — errors logged as 'entity.flagged' events, mutation proceeds
   * - 'off'    — no validation (legacy / migration use only)
   */
  validation?: ValidationMode
}

export interface UpdateEntityOptions {
  status?: KBEntityStatus
  title?: string
  properties?: Record<string, unknown>
  addTags?: string[]
  removeTags?: string[]
  actor?: string
  validation?: ValidationMode
}

export interface KnowledgeBaseManagerOptions {
  /**
   * Default validation mode for all mutations. Individual calls can override.
   * Default: 'draft' — backward-compatible with v1 KBs (warns on issues but
   * proceeds). Set to 'strict' for new KBs or after running 'orka kb upgrade'.
   */
  validation?: ValidationMode
}

export class ValidationError extends Error {
  constructor(message: string, public result: ValidationResult) {
    super(message)
    this.name = 'ValidationError'
  }
}

export class KnowledgeBaseManager {
  private projectPath: string
  private kbPath: string
  private eventsPath: string
  private entitiesPath: string
  private viewsPath: string
  private validationMode: ValidationMode

  constructor(projectPath: string, opts: KnowledgeBaseManagerOptions = {}) {
    this.projectPath = projectPath
    this.kbPath = path.join(projectPath, KB_DIR)
    this.eventsPath = path.join(this.kbPath, EVENTS_FILE)
    this.entitiesPath = path.join(this.kbPath, ENTITIES_DIR)
    this.viewsPath = path.join(this.kbPath, VIEWS_DIR)
    this.validationMode = opts.validation ?? 'draft'
  }

  /** Change the default validation mode after construction. */
  setValidationMode(mode: ValidationMode): void {
    this.validationMode = mode
  }

  getValidationMode(): ValidationMode {
    return this.validationMode
  }

  // --- Validation ---

  /**
   * Apply a validation result according to the active mode.
   * - strict: errors throw a ValidationError; warnings are printed.
   * - draft:  errors and warnings are recorded as 'entity.flagged' events,
   *           but the mutation proceeds.
   * - off:    nothing happens.
   *
   * Returns true if the mutation should proceed, false if it should abort.
   * In strict mode with errors, this throws — so it never returns false.
   */
  private async applyValidation(
    result: ValidationResult,
    context: { entityId?: string; actor: string; operation: string },
    mode: ValidationMode
  ): Promise<boolean> {
    if (mode === 'off') return true
    if (result.ok && result.warnings.length === 0) return true

    if (mode === 'strict' && !result.ok) {
      const summary = `${result.errors.length} validation error(s) for ${context.operation}:\n${formatResult(result)}`
      throw new ValidationError(summary, result)
    }

    // Draft mode (or strict with only warnings) — record as event for later linting
    const issues = [...result.errors, ...result.warnings]
    if (issues.length > 0) {
      await this.appendEvent({
        type: 'entity.flagged',
        entityId: context.entityId,
        actor: context.actor,
        data: {
          operation: context.operation,
          issues: issues.map((i) => ({
            code: i.code,
            severity: i.severity,
            message: i.message,
            hint: i.hint,
          })),
        },
      })

      // In draft mode, also surface warnings to stderr so the user knows
      // they're accumulating debt. Skipped under TEST/CI to keep test output
      // clean — the events are still recorded and queryable.
      if (process.env.ORKA_QUIET !== '1') {
        const tag = result.errors.length > 0 ? 'flagged' : 'warned'
        console.error(`⚠ ${context.operation} ${tag}: ${issues.length} issue(s) — see 'orka kb lint' or events.jsonl`)
      }
    }

    return true
  }

  // --- Initialization ---

  isInitialized(): boolean {
    return fs.pathExistsSync(this.kbPath)
  }

  async initialize(): Promise<void> {
    if (this.isInitialized()) {
      throw new Error('Knowledge Base already initialized in this project')
    }

    await fs.ensureDir(this.entitiesPath)
    await fs.ensureDir(this.viewsPath)
    await fs.writeFile(this.eventsPath, '', 'utf-8')

    await this.appendEvent({
      type: 'kb.init',
      actor: 'cli',
      data: { projectPath: this.projectPath },
    })

    await this.sync()
  }

  // --- Provenance / Activity (PROV-O) ---

  /**
   * Get or create an `activity` entity representing a skill/agent run.
   *
   * Strategy: one persistent activity per skill name (e.g. one for /kb-track,
   * one for /kb-ingest). This keeps the activity count manageable and lets
   * the UI group "all entities generated by /kb-track" cleanly. Sessions or
   * specific runs can be tracked via the activity's history (each generation
   * appends an event linked to the activity).
   *
   * If the activity already exists, returns it without creating duplicates.
   */
  async getOrCreateActivity(skillName: string, opts: {
    sessionId?: string
    description?: string
  } = {}): Promise<KBEntity> {
    // Look up by title — activity titles use a canonical "skill: <name>" form
    const title = `skill: ${skillName}`
    const existing = await this.findEntityByTitle(title, 'activity')
    if (existing) return existing

    return this.addEntity('activity', title, {
      actor: 'system',
      properties: {
        skill: skillName,
        session_id: opts.sessionId || 'persistent',
        description: opts.description || `Provenance activity for the ${skillName} skill`,
      },
      // No edges required for activity creation (system actor bypasses provenance check)
    })
  }

  /**
   * High-level wrapper: when a skill creates entities, it should call this
   * with the skill name. The wrapper adds `generated-by` to the entity's
   * edges automatically, satisfying the PROV-O provenance requirement.
   */
  async addEntityFromSkill(
    skillName: string,
    type: KBEntityType,
    title: string,
    opts: AddEntityOptions = {}
  ): Promise<KBEntity> {
    const activity = await this.getOrCreateActivity(skillName)
    const edges = [...(opts.edges || []), { relation: 'generated-by', target: activity.id }]
    return this.addEntity(type, title, {
      ...opts,
      actor: opts.actor || `skill:${skillName}`,
      edges,
    })
  }

  // --- Event Log ---

  async appendEvent(partial: Omit<KBEvent, 'id' | 'ts'>): Promise<KBEvent> {
    const event: KBEvent = {
      id: `evt-${nanoid(8)}`,
      ts: new Date().toISOString(),
      ...partial,
    }

    const line = JSON.stringify(event) + '\n'
    await fs.appendFile(this.eventsPath, line, 'utf-8')
    return event
  }

  async getTimeline(filter?: KBTimelineFilter): Promise<KBEvent[]> {
    const events = await this.readEvents()
    let result = events

    if (filter?.since) {
      const since = new Date(filter.since).getTime()
      result = result.filter((e) => new Date(e.ts).getTime() >= since)
    }

    if (filter?.limit) {
      result = result.slice(-filter.limit)
    }

    return result
  }

  async getEntityHistory(entityId: string): Promise<KBEvent[]> {
    const events = await this.readEvents()
    return events.filter(
      (e) => e.entityId === entityId || e.refs?.includes(entityId)
    )
  }

  // --- Entity CRUD ---

  async addEntity(
    type: KBEntityType,
    title: string,
    opts: AddEntityOptions = {}
  ): Promise<KBEntity> {
    const id = generateId(type)
    const now = new Date().toISOString()
    const actor = opts.actor || 'cli'
    const mode = opts.validation ?? this.validationMode
    const status = opts.status || 'active'

    // Validate before mutating state
    const validation = validateEntityCreation({
      type: String(type),
      status: String(status),
      properties: opts.properties || {},
      edges: opts.edges || [],
      actor,
    })
    await this.applyValidation(
      validation,
      { entityId: id, actor, operation: `addEntity(${type})` },
      mode
    )

    const event = await this.appendEvent({
      type: 'entity.created',
      entityId: id,
      actor,
      data: { type, title, status, properties: opts.properties || {}, tags: opts.tags || [] },
      refs: opts.edges?.map((e) => e.target),
    })

    const entity: KBEntity = {
      id,
      type,
      title,
      status,
      created: now,
      updated: now,
      properties: opts.properties || {},
      edges: [],
      tags: opts.tags || [],
      history: [{ ts: now, event: event.id, summary: 'Created' }],
    }

    await this.writeEntity(entity)

    // Create edges via separate events (so sync can replay them)
    if (opts.edges) {
      for (const edge of opts.edges) {
        await this.addEdge(id, edge.relation, edge.target, actor, { validation: mode })
      }
      // Re-read entity after edges were added
      const updated = await this.getEntity(id)
      if (updated) {
        await this.refreshIndex()
        return updated
      }
    }

    await this.refreshIndex()
    return entity
  }

  async updateEntity(id: string, opts: UpdateEntityOptions): Promise<KBEntity> {
    const entity = await this.getEntity(id)
    if (!entity) {
      throw new Error(`Entity not found: ${id}`)
    }

    const now = new Date().toISOString()
    const actor = opts.actor || 'cli'
    const mode = opts.validation ?? this.validationMode
    const changes: Record<string, unknown> = {}

    // Validate status transition (if changing status)
    if (opts.status && opts.status !== entity.status) {
      const validation = validateEntityUpdate({
        type: String(entity.type),
        fromStatus: String(entity.status),
        toStatus: String(opts.status),
        newProperties: opts.properties,
      })
      await this.applyValidation(
        validation,
        { entityId: id, actor, operation: `updateEntity(${entity.type}, status)` },
        mode
      )
      changes.status = { from: entity.status, to: opts.status }
      entity.status = opts.status
    }

    if (opts.title && opts.title !== entity.title) {
      changes.title = { from: entity.title, to: opts.title }
      entity.title = opts.title
    }

    if (opts.properties) {
      for (const [key, value] of Object.entries(opts.properties)) {
        changes[`property.${key}`] = { from: entity.properties[key], to: value }
        entity.properties[key] = value
      }
    }

    if (opts.addTags) {
      for (const tag of opts.addTags) {
        if (!entity.tags.includes(tag)) {
          entity.tags.push(tag)
          changes[`tag.add`] = tag
        }
      }
    }

    if (opts.removeTags) {
      for (const tag of opts.removeTags) {
        entity.tags = entity.tags.filter((t) => t !== tag)
        changes[`tag.remove`] = tag
      }
    }

    if (Object.keys(changes).length === 0) {
      return entity // no changes
    }

    entity.updated = now

    const event = await this.appendEvent({
      type: 'entity.updated',
      entityId: id,
      actor,
      data: changes,
    })

    const summary = Object.keys(changes)
      .map((k) => k.replace('property.', '').replace('tag.', ''))
      .join(', ')
    entity.history.push({ ts: now, event: event.id, summary: `Updated: ${summary}` })

    await this.writeEntity(entity)
    await this.refreshIndex()
    return entity
  }

  async archiveEntity(id: string, actor = 'cli'): Promise<void> {
    await this.updateEntity(id, { status: 'archived', actor })
  }

  // --- Edges ---

  async addEdge(
    sourceId: string,
    relation: string,
    targetId: string,
    actor = 'cli',
    opts: {
      validation?: ValidationMode
      qualifiers?: Partial<import('../models').KBEdgeQualifiers>
    } = {}
  ): Promise<KBEdge> {
    const source = await this.getEntity(sourceId)
    if (!source) throw new Error(`Entity not found: ${sourceId}`)

    const target = await this.getEntity(targetId)
    if (!target) throw new Error(`Entity not found: ${targetId}`)

    const mode = opts.validation ?? this.validationMode

    // Validate the edge against the relation registry
    const validation = validateEdge({
      sourceType: String(source.type),
      relation,
      targetType: String(target.type),
    })
    await this.applyValidation(
      validation,
      { entityId: sourceId, actor, operation: `addEdge(${relation})` },
      mode
    )

    const now = new Date().toISOString()

    const event = await this.appendEvent({
      type: 'edge.created',
      entityId: sourceId,
      actor,
      // Persist qualifiers in the event for full replay fidelity.
      data: { relation, target: targetId, qualifiers: opts.qualifiers || null },
      refs: [targetId],
    })

    // Build the qualifier metadata. Caller-supplied values win over defaults.
    const qualifiers: import('../models').KBEdgeQualifiers = {
      at: now,
      by: actor,
      source: event.id,
      ...(opts.qualifiers || {}),
    }

    const edge: KBEdge = {
      relation,
      target: targetId,
      // Legacy fields kept for backward compat; mirror the qualifier values.
      since: now,
      eventRef: event.id,
      qualifiers,
    }

    source.edges.push(edge)
    source.updated = now
    source.history.push({
      ts: now,
      event: event.id,
      summary: `Linked to ${targetId} via "${relation}"`,
    })
    await this.writeEntity(source)

    target.updated = now
    target.history.push({
      ts: now,
      event: event.id,
      summary: `Linked from ${sourceId} via "${relation}"`,
    })
    await this.writeEntity(target)

    await this.refreshIndex()
    return edge
  }

  async removeEdge(
    sourceId: string,
    relation: string,
    targetId: string,
    actor = 'cli'
  ): Promise<void> {
    const source = await this.getEntity(sourceId)
    if (!source) throw new Error(`Entity not found: ${sourceId}`)

    const idx = source.edges.findIndex(
      (e) => e.relation === relation && e.target === targetId
    )
    if (idx === -1) throw new Error(`Edge not found: ${sourceId} -[${relation}]-> ${targetId}`)

    source.edges.splice(idx, 1)
    source.updated = new Date().toISOString()

    await this.appendEvent({
      type: 'edge.removed',
      entityId: sourceId,
      actor,
      data: { relation, target: targetId },
      refs: [targetId],
    })

    await this.writeEntity(source)
    await this.refreshIndex()
  }

  // --- Queries ---

  /**
   * Back-fill missing qualifiers on legacy v1 edges that lack them.
   * v1 stored only `since` and `eventRef`; v2 expects a `qualifiers` object.
   * Called on every read so consumers always see a v2-shaped entity.
   */
  private hydrateEdgeQualifiers(entity: KBEntity): KBEntity {
    let mutated = false
    for (const edge of entity.edges) {
      if (!edge.qualifiers) {
        edge.qualifiers = {
          at: edge.since,
          by: 'unknown',
          source: edge.eventRef,
        }
        mutated = true
      }
    }
    // Mark the entity in-memory; we don't write back here (read-side only).
    void mutated
    return entity
  }

  async getEntity(id: string): Promise<KBEntity | null> {
    const filePath = path.join(this.entitiesPath, `${id}.json`)
    if (!await fs.pathExists(filePath)) return null
    const entity: KBEntity = await fs.readJson(filePath)
    return this.hydrateEdgeQualifiers(entity)
  }

  async listEntities(filter?: KBEntityFilter): Promise<KBEntity[]> {
    if (!await fs.pathExists(this.entitiesPath)) return []

    const files = await fs.readdir(this.entitiesPath)
    const entities: KBEntity[] = []

    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const entity: KBEntity = await fs.readJson(
        path.join(this.entitiesPath, file)
      )

      if (filter?.type && entity.type !== filter.type) continue
      if (filter?.status && entity.status !== filter.status) continue
      if (filter?.tag && !entity.tags.includes(filter.tag)) continue

      entities.push(this.hydrateEdgeQualifiers(entity))
    }

    return entities.sort(
      (a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime()
    )
  }

  async findEntityByTitle(title: string, type?: KBEntityType): Promise<KBEntity | null> {
    const entities = await this.listEntities(type ? { type } : undefined)
    const lower = title.toLowerCase()
    return entities.find((e) => e.title.toLowerCase().includes(lower)) || null
  }

  // --- Graph Export ---

  async getIndex(): Promise<KBIndex> {
    const indexPath = path.join(this.viewsPath, 'index.json')
    if (await fs.pathExists(indexPath)) {
      return fs.readJson(indexPath)
    }
    return this.buildIndex()
  }

  async exportGraph(format: 'dot' | 'json'): Promise<string> {
    const index = await this.getIndex()

    if (format === 'json') {
      return JSON.stringify(index, null, 2)
    }

    // DOT format
    let dot = 'digraph KB {\n'
    dot += '  rankdir=LR;\n'
    dot += '  node [shape=box, style=rounded];\n\n'

    // Nodes
    for (const [id, entry] of Object.entries(index.entities)) {
      const label = `${entry.title}\\n[${entry.type}]`
      const color = entry.status === 'active' ? '#a6e3a1' : entry.status === 'archived' ? '#6c7086' : '#f9e2af'
      dot += `  "${id}" [label="${label}", fillcolor="${color}", style="filled,rounded"];\n`
    }

    dot += '\n'

    // Edges
    for (const edge of index.edges) {
      dot += `  "${edge.source}" -> "${edge.target}" [label="${edge.relation}"];\n`
    }

    dot += '}\n'
    return dot
  }

  // --- Context Generation ---

  async generateContext(
    projectId?: string,
    breadth: 'narrow' | 'medium' | 'wide' = 'medium'
  ): Promise<string> {
    const allEntities = await this.listEntities()
    const events = await this.readEvents()

    // If project filter, use weighted traversal (replaces v1 uniform 2-hop BFS)
    let entities = allEntities
    let project: KBEntity | undefined

    if (projectId) {
      project = allEntities.find((e) => e.id === projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)

      const config = BREADTH_PRESETS[breadth]
      const related = relatedEntityIds(projectId, allEntities, config)
      entities = allEntities.filter((e) => related.has(e.id))
    }

    const sections: string[] = []

    // Header
    if (project) {
      sections.push(`# Project Context: ${project.title}\n`)
      sections.push(`**Status:** ${project.status}`)
      if (project.properties.description) sections.push(`**Description:** ${project.properties.description}`)
      if (project.properties.owner) sections.push(`**Owner:** ${project.properties.owner}`)
      if (project.properties.target_release) sections.push(`**Target:** ${project.properties.target_release}`)
      if (project.properties.repo_path) sections.push(`**Repo:** ${project.properties.repo_path}`)
      if (project.properties.path) sections.push(`**Path:** ${project.properties.path}`)
      sections.push('')
    } else {
      sections.push('# Project Knowledge Base Context\n')
    }

    // Active work items (tier types — tasks, spikes, bugs, sub-projects, initiatives)
    const workItems = entities.filter(
      (e) => ['task', 'spike', 'bug', 'initiative'].includes(String(e.type)) && e.status !== 'archived' && e.status !== 'cancelled' && e.status !== 'done' && e.status !== 'fixed'
    )
    if (workItems.length > 0) {
      sections.push('## Active Work Items\n')
      for (const w of workItems.slice(0, 20)) {
        const owner = w.properties.owner ? ` — ${w.properties.owner}` : ''
        sections.push(`- **[${w.type}]** ${w.title} (${w.id}) [${w.status}]${owner}`)
      }
      sections.push('')
    }

    // Active decisions
    const decisions = entities.filter((e) => e.type === 'decision' && e.status !== 'archived')
    if (decisions.length > 0) {
      sections.push('## Decisions\n')
      for (const d of decisions.slice(0, 15)) {
        const edges = d.edges.map((e) => `${e.relation}: ${e.target}`).join(', ')
        const props = this.formatEntityProps(d)
        sections.push(`- **${d.title}** (${d.id}) [${d.status}]${edges ? ` → ${edges}` : ''}`)
        if (props) sections.push(`  ${props}`)
      }
      sections.push('')
    }

    // Open questions
    const questions = entities.filter((e) => e.type === 'question' && e.status !== 'archived')
    if (questions.length > 0) {
      sections.push('## Questions\n')
      for (const q of questions.slice(0, 15)) {
        const props = this.formatEntityProps(q)
        sections.push(`- **${q.title}** (${q.id}) [${q.status}]`)
        if (props) sections.push(`  ${props}`)
      }
      sections.push('')
    }

    // Milestones
    const milestones = entities.filter((e) => e.type === 'milestone' && e.status !== 'archived')
    if (milestones.length > 0) {
      sections.push('## Milestones\n')
      for (const m of milestones.slice(0, 10)) {
        const deadline = m.properties.deadline || m.properties.target || ''
        sections.push(`- **${m.title}** (${m.id}) [${m.status}]${deadline ? ` — ${deadline}` : ''}`)
      }
      sections.push('')
    }

    // Directions
    const directions = entities.filter((e) => e.type === 'direction' && e.status !== 'archived')
    if (directions.length > 0) {
      sections.push('## Directions\n')
      for (const d of directions.slice(0, 5)) {
        sections.push(`- **${d.title}** (${d.id})`)
        if (d.properties.rationale) sections.push(`  Rationale: ${d.properties.rationale}`)
      }
      sections.push('')
    }

    // People
    const people = entities.filter((e) => e.type === 'person' && e.status === 'active')
    if (people.length > 0) {
      sections.push('## People\n')
      for (const p of people.slice(0, 15)) {
        const role = p.properties.role ? ` — ${p.properties.role}` : ''
        sections.push(`- **${p.title}**${role} (${p.id})`)
      }
      sections.push('')
    }

    // Repos
    const repos = entities.filter((e) => e.type === 'repo')
    if (repos.length > 0) {
      sections.push('## Repositories\n')
      for (const r of repos) {
        const stack = r.properties.stack ? ` [${r.properties.stack}]` : ''
        sections.push(`- **${r.title}** (${r.id})${stack}`)
      }
      sections.push('')
    }

    // Source files to read
    const sourcePaths = new Set<string>()
    for (const e of entities) {
      for (const key of ['path', 'notes_path', 'profile_path', 'source_path', 'repo_path', 'filePath']) {
        const val = e.properties[key]
        if (val && typeof val === 'string') sourcePaths.add(val)
      }
    }

    if (sourcePaths.size > 0) {
      sections.push('## Source Files\n')
      sections.push('These files contain detailed context. Read them for deeper understanding:\n')
      for (const p of [...sourcePaths].sort()) {
        sections.push(`- \`${p}\``)
      }
      sections.push('')
    }

    // Stats
    sections.push(`## Stats\n`)
    if (project) {
      sections.push(`- Project entities: ${entities.length} (of ${allEntities.length} total)`)
    } else {
      sections.push(`- Total entities: ${entities.length}`)
    }
    sections.push(`- Total events: ${events.length}`)
    sections.push(`- Last updated: ${events.length > 0 ? events[events.length - 1].ts : 'never'}`)

    return sections.join('\n')
  }

  private formatEntityProps(entity: KBEntity): string {
    const skip = new Set(['source', 'source_path', 'path', 'notes_path', 'profile_path', 'repo_path', 'filePath'])
    const props = Object.entries(entity.properties)
      .filter(([k]) => !skip.has(k))
      .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
    return props.length > 0 ? props.join(' | ') : ''
  }

  // --- Project Master Document ---

  async generateProjectDoc(
    projectId: string,
    breadth: 'narrow' | 'medium' | 'wide' = 'medium'
  ): Promise<{ content: string; filePath: string }> {
    const allEntities = await this.listEntities()
    const project = allEntities.find((e) => e.id === projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)

    // Weighted traversal — replaces v1 uniform 2-hop BFS that pulled in too
    // many off-topic entities through any shared meeting/person. Now edges
    // are scored by relation type, hop count and confidence.
    const config = BREADTH_PRESETS[breadth]
    const related = relatedEntityIds(projectId, allEntities, config)
    const entities = allEntities.filter((e) => related.has(e.id) && e.id !== projectId)
    const now = new Date().toISOString()

    const lines: string[] = []

    // Header
    lines.push(`# ${project.title}`)
    lines.push('')
    lines.push(`> Auto-generated project index by Orka KB — Last updated: ${now.split('T')[0]}`)
    lines.push(`> Entity: \`${project.id}\` | Status: **${project.status}**`)
    lines.push('')

    // Project overview
    if (project.properties.description) lines.push(`**Description:** ${project.properties.description}`)
    if (project.properties.owner) lines.push(`**Owner:** ${project.properties.owner}`)
    if (project.properties.target_release) lines.push(`**Target Release:** ${project.properties.target_release}`)
    if (project.properties.repo_path) lines.push(`**Repository:** \`${project.properties.repo_path}\``)
    if (project.properties.status_detail) lines.push(`**Status Detail:** ${project.properties.status_detail}`)
    lines.push('')

    lines.push('---')
    lines.push('')

    // Sub-work items (v2 tier types) — tasks, spikes, bugs scoped to this project
    const tasks = entities.filter((e) => e.type === 'task')
    const spikes = entities.filter((e) => e.type === 'spike')
    const bugs = entities.filter((e) => e.type === 'bug')
    if (tasks.length + spikes.length + bugs.length > 0) {
      lines.push('## Work Items')
      lines.push('')
      for (const t of tasks) {
        const check = t.status === 'done' ? '[x]' : t.status === 'cancelled' ? '[~]' : '[ ]'
        const status = t.status !== 'todo' && t.status !== 'done' ? ` _(${t.status})_` : ''
        const owner = t.properties.owner ? ` — ${t.properties.owner}` : ''
        lines.push(`- ${check} **[task]** ${t.title}${status}${owner}`)
      }
      for (const s of spikes) {
        const check = s.status === 'concluded' ? '[x]' : s.status === 'cancelled' ? '[~]' : '[ ]'
        const status = ` _(${s.status})_`
        lines.push(`- ${check} **[spike]** ${s.title}${status}`)
      }
      for (const b of bugs) {
        const check = b.status === 'fixed' ? '[x]' : b.status === 'wontfix' || b.status === 'duplicate' ? '[~]' : '[ ]'
        const status = ` _(${b.status})_`
        lines.push(`- ${check} **[bug]** ${b.title}${status}`)
      }
      lines.push('')
    }

    // Decisions
    const decisions = entities.filter((e) => e.type === 'decision')
    if (decisions.length > 0) {
      lines.push('## Decisions')
      lines.push('')
      for (const d of decisions) {
        const status = d.status !== 'active' ? ` _(${d.status})_` : ''
        lines.push(`- **${d.title}**${status}`)
        if (d.properties.source) lines.push(`  - Source: ${d.properties.source}`)
        if (d.properties.source_path) lines.push(`  - Reference: [\`${d.properties.source_path}\`](${d.properties.source_path})`)
        if (d.properties.confidence) lines.push(`  - Confidence: ${d.properties.confidence}`)
      }
      lines.push('')
    }

    // Open questions — only truly active/open ones, never resolved/archived
    const questions = entities.filter(
      (e) => e.type === 'question' && e.status !== 'resolved' && e.status !== 'archived' && e.status !== 'answered'
    )
    if (questions.length > 0) {
      lines.push('## Open Questions')
      lines.push('')
      for (const q of questions) {
        const status = q.status !== 'active' ? ` _(${q.status})_` : ''
        lines.push(`- [ ] **${q.title}**${status}`)
        if (q.properties.owner) lines.push(`  - Owner: ${q.properties.owner}`)
        if (q.properties.source_path) lines.push(`  - Reference: [\`${q.properties.source_path}\`](${q.properties.source_path})`)
      }
      lines.push('')
    }

    // Resolved questions
    const resolved = entities.filter(
      (e) => e.type === 'question' && (e.status === 'resolved' || e.status === 'answered' || e.status === 'archived')
    )
    if (resolved.length > 0) {
      lines.push('## Resolved Questions')
      lines.push('')
      for (const q of resolved) {
        lines.push(`- [x] **${q.title}**`)
        if (q.properties.resolution) lines.push(`  - Resolution: ${q.properties.resolution}`)
      }
      lines.push('')
    }

    // Milestones
    const milestones = entities.filter((e) => e.type === 'milestone')
    if (milestones.length > 0) {
      lines.push('## Milestones')
      lines.push('')
      for (const m of milestones) {
        const deadline = m.properties.deadline || m.properties.target || ''
        const check = m.status === 'resolved' ? '[x]' : '[ ]'
        lines.push(`- ${check} **${m.title}**${deadline ? ` — ${deadline}` : ''}`)
      }
      lines.push('')
    }

    // People
    const people = entities.filter((e) => e.type === 'person')
    if (people.length > 0) {
      lines.push('## People')
      lines.push('')
      for (const p of people) {
        const role = p.properties.role ? ` — ${p.properties.role}` : ''
        const profileLink = p.properties.profile_path ? ` → [\`${p.properties.profile_path}\`](${p.properties.profile_path})` : ''
        lines.push(`- **${p.title}**${role}${profileLink}`)
      }
      lines.push('')
    }

    // Meetings
    const meetings = entities.filter((e) => e.type === 'meeting')
    if (meetings.length > 0) {
      lines.push('## Meetings')
      lines.push('')
      for (const m of meetings) {
        const date = m.properties.date || m.created.split('T')[0]
        const notesLink = m.properties.notes_path ? ` → [\`${m.properties.notes_path}\`](${m.properties.notes_path})` : ''
        lines.push(`- **${m.title}** (${date})${notesLink}`)
      }
      lines.push('')
    }

    // Repos
    const repos = entities.filter((e) => e.type === 'repo')
    if (repos.length > 0) {
      lines.push('## Repositories')
      lines.push('')
      for (const r of repos) {
        const stack = r.properties.stack ? ` [${r.properties.stack}]` : ''
        lines.push(`- **${r.title}**${stack}`)
      }
      lines.push('')
    }

    // Artifacts
    const artifacts = entities.filter((e) => e.type === 'artifact' && e.status !== 'archived')
    if (artifacts.length > 0) {
      lines.push('## Artifacts & Documents')
      lines.push('')
      for (const a of artifacts) {
        const link = a.properties.path ? ` → [\`${a.properties.path}\`](${a.properties.path})` : ''
        lines.push(`- **${a.title}**${link}`)
      }
      lines.push('')
    }

    // Directions
    const directions = entities.filter((e) => e.type === 'direction')
    if (directions.length > 0) {
      lines.push('## Directions')
      lines.push('')
      for (const d of directions) {
        lines.push(`- **${d.title}**`)
        if (d.properties.rationale) lines.push(`  - ${d.properties.rationale}`)
      }
      lines.push('')
    }

    lines.push('---')
    lines.push('')
    lines.push(`_This document is auto-generated by \`orka kb project-doc ${projectId}\`. Do not edit manually — changes will be overwritten._`)

    const content = lines.join('\n')

    // Determine file path
    const projectPath = project.properties.path ? String(project.properties.path) : null
    let docPath: string

    if (projectPath) {
      // Write inside the project folder
      const fullDir = path.join(this.projectPath, projectPath)
      await fs.ensureDir(fullDir)
      docPath = path.join(projectPath, 'INDEX.md')
    } else {
      // Fallback: write in .claude-orka/.orka-kb/views/
      docPath = path.join('.claude-orka', '.orka-kb', 'views', `${projectId}-index.md`)
    }

    const fullPath = path.join(this.projectPath, docPath)
    await fs.writeFile(fullPath, content, 'utf-8')

    // Update project entity with master_doc property
    await this.updateEntity(projectId, {
      properties: { master_doc: docPath },
      actor: 'cli',
    })

    return { content, filePath: docPath }
  }

  // --- Sync (rebuild from events) ---

  async sync(): Promise<void> {
    const events = await this.readEvents()
    const entityMap = new Map<string, KBEntity>()

    for (const event of events) {
      switch (event.type) {
        case 'entity.created': {
          const data = event.data as {
            type: KBEntityType
            title: string
            status: KBEntityStatus
            properties: Record<string, unknown>
          }
          entityMap.set(event.entityId!, {
            id: event.entityId!,
            type: data.type,
            title: data.title,
            status: data.status || 'active',
            created: event.ts,
            updated: event.ts,
            properties: data.properties || {},
            edges: [],
            tags: (event.data.tags as string[]) || [],
            history: [{ ts: event.ts, event: event.id, summary: 'Created' }],
          })
          break
        }

        case 'entity.updated': {
          const entity = entityMap.get(event.entityId!)
          if (!entity) break

          const changes = event.data as Record<string, unknown>
          for (const [key, value] of Object.entries(changes)) {
            if (key === 'status') {
              entity.status = (value as { to: string }).to as KBEntityStatus
            } else if (key === 'title') {
              entity.title = (value as { to: string }).to
            } else if (key.startsWith('property.')) {
              const prop = key.replace('property.', '')
              entity.properties[prop] = (value as { to: unknown }).to
            } else if (key === 'tag.add') {
              const tag = value as string
              if (!entity.tags.includes(tag)) entity.tags.push(tag)
            } else if (key === 'tag.remove') {
              entity.tags = entity.tags.filter((t) => t !== value)
            }
          }

          entity.updated = event.ts
          entity.history.push({ ts: event.ts, event: event.id, summary: `Updated` })
          break
        }

        case 'entity.archived': {
          const entity = entityMap.get(event.entityId!)
          if (!entity) break
          entity.status = 'archived'
          entity.updated = event.ts
          entity.history.push({ ts: event.ts, event: event.id, summary: 'Archived' })
          break
        }

        case 'edge.created': {
          const entity = entityMap.get(event.entityId!)
          if (!entity) break
          const data = event.data as {
            relation: string
            target: string
            qualifiers?: import('../models').KBEdgeQualifiers | null
          }
          const qualifiers: import('../models').KBEdgeQualifiers = {
            at: event.ts,
            by: event.actor,
            source: event.id,
            ...(data.qualifiers || {}),
          }
          entity.edges.push({
            relation: data.relation,
            target: data.target,
            since: event.ts,
            eventRef: event.id,
            qualifiers,
          })
          entity.updated = event.ts
          entity.history.push({
            ts: event.ts,
            event: event.id,
            summary: `Linked to ${data.target} via "${data.relation}"`,
          })
          break
        }

        case 'edge.removed': {
          const entity = entityMap.get(event.entityId!)
          if (!entity) break
          const { relation, target } = event.data as { relation: string; target: string }
          entity.edges = entity.edges.filter(
            (e) => !(e.relation === relation && e.target === target)
          )
          entity.updated = event.ts
          break
        }

        // --- v1 → v2 migration events (P9) ---
        // These describe semantic transformations (type rename, status fix,
        // relation rewrite, qualifier backfill) that must be replayable so
        // that `kb sync` produces the same v2 state as the live migration did.
        case 'kb.migration.action': {
          const entity = entityMap.get(event.entityId!)
          if (!entity) break
          const a = event.data as {
            kind: string
            before: Record<string, unknown>
            after: Record<string, unknown>
          }
          switch (a.kind) {
            case 'reclassify_type': {
              entity.type = String(a.after.type) as KBEntityType
              const tag = String(a.after.tag)
              if (tag && !entity.tags.includes(tag)) entity.tags.push(tag)
              break
            }
            case 'normalize_status': {
              entity.status = String(a.after.status) as KBEntityStatus
              break
            }
            case 'rewrite_relation': {
              const oldRel = String(a.before.relation)
              const target = String(a.before.target)
              const newRel = String(a.after.relation)
              const edge = entity.edges.find(
                (e) => e.relation === oldRel && e.target === target
              )
              if (edge) edge.relation = newRel
              break
            }
            case 'backfill_qualifiers': {
              const target = String(a.before.target)
              const relation = String(a.before.relation)
              const edge = entity.edges.find(
                (e) => e.relation === relation && e.target === target
              )
              if (edge && !edge.qualifiers) {
                edge.qualifiers = a.after.qualifiers as KBEdge['qualifiers']
              }
              break
            }
            case 'backfill_property': {
              const prop = String(a.after.property)
              const value = a.after.value
              if (!entity.properties[prop]) {
                entity.properties[prop] = value
              }
              break
            }
          }
          entity.updated = event.ts
          break
        }

        // Reclassification — entity gets a new id and type. Entries in
        // entityMap are renamed and any edges in OTHER entities that targeted
        // the old id are rewritten. Subsequent edge.created events that
        // reference the new id (post-migration writes) just work.
        case 'kb.migration.reclassified': {
          const data = event.data as {
            old_id: string
            new_id: string
            old_type: string
            new_type: string
          }
          const entity = entityMap.get(data.old_id)
          if (entity) {
            entity.id = data.new_id
            entity.type = data.new_type as KBEntityType
            entity.updated = event.ts
            entity.history.push({
              ts: event.ts,
              event: event.id,
              summary: `Reclassified from ${data.old_type} to ${data.new_type}`,
            })
            // Move under new key
            entityMap.delete(data.old_id)
            entityMap.set(data.new_id, entity)
          }
          // Rewrite edges in every other entity that pointed to old id
          for (const e of entityMap.values()) {
            for (const edge of e.edges) {
              if (edge.target === data.old_id) {
                edge.target = data.new_id
              }
            }
          }
          break
        }

        // entity.flagged events are validation breadcrumbs for `kb lint`.
        // They don't change entity state — handled at lint time, ignored here.
        case 'entity.flagged':
        case 'kb.migration.start':
        case 'kb.migration.complete':
        case 'kb.migration.error':
          break
      }
    }

    // Write all entities
    await fs.emptyDir(this.entitiesPath)
    for (const entity of entityMap.values()) {
      await this.writeEntity(entity)
    }

    // Generate views
    await this.generateViews(entityMap, events)
  }

  // --- Migration ---

  async migrate(): Promise<KBEvent[]> {
    const generatedEvents: KBEvent[] = []

    // 1. Create repo entity for this project
    const projectName = path.basename(this.projectPath)
    const repoEntity = await this.addEntity('repo', projectName, {
      actor: 'migration',
      properties: { path: this.projectPath },
    })
    generatedEvents.push(
      (await this.getEntityHistory(repoEntity.id))[0]
    )

    // 2. Try to extract people from git log
    try {
      const { stdout } = await execa('git', ['log', '--format=%aN <%aE>', '--all'], {
        cwd: this.projectPath,
      })

      const contributors = new Set<string>()
      for (const line of stdout.split('\n')) {
        if (line.trim()) contributors.add(line.trim())
      }

      for (const contributor of Array.from(contributors).slice(0, 20)) {
        const nameMatch = contributor.match(/^(.+?)\s*<(.+)>$/)
        if (nameMatch) {
          const entity = await this.addEntity('person', nameMatch[1], {
            actor: 'migration',
            properties: { email: nameMatch[2] },
            // v2: use 'relates-to' instead of deprecated 'contributes-to'.
            // Role can be added later as a qualifier (P4) once edge metadata
            // is in place: relates-to{role: 'contributor'}.
            edges: [{ relation: 'relates-to', target: repoEntity.id }],
          })
          generatedEvents.push(
            (await this.getEntityHistory(entity.id))[0]
          )
        }
      }
    } catch {
      // Not a git repo or git not available
    }

    // 3. Scan for key docs
    const docFiles = ['README.md', 'CLAUDE.md', 'docs/ARCHITECTURE.md', 'ARCHITECTURE.md']
    for (const docFile of docFiles) {
      const fullPath = path.join(this.projectPath, docFile)
      if (await fs.pathExists(fullPath)) {
        const entity = await this.addEntity('artifact', docFile, {
          actor: 'migration',
          properties: { filePath: docFile, description: `Project doc: ${docFile}` },
          // v2: use 'references' (artifact → repo) instead of deprecated 'part-of'.
          edges: [{ relation: 'references', target: repoEntity.id }],
        })
        generatedEvents.push(
          (await this.getEntityHistory(entity.id))[0]
        )
      }
    }

    await this.sync()
    return generatedEvents
  }

  // --- Private Helpers ---

  private async readEvents(): Promise<KBEvent[]> {
    if (!await fs.pathExists(this.eventsPath)) return []

    const content = await fs.readFile(this.eventsPath, 'utf-8')
    const events: KBEvent[] = []

    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // skip malformed lines
      }
    }

    return events
  }

  private async writeEntity(entity: KBEntity): Promise<void> {
    const filePath = path.join(this.entitiesPath, `${entity.id}.json`)
    await fs.writeJson(filePath, entity, { spaces: 2 })
  }

  /**
   * Cheap refresh of views/index.json after a single mutation.
   * Keeps the UI / API in sync without full sync() (which also rewrites
   * context.md, graph.dot, timeline.md — those still go through sync()).
   * Failures are swallowed so a transient FS error never breaks a write.
   */
  private async refreshIndex(): Promise<void> {
    try {
      if (!await fs.pathExists(this.viewsPath)) {
        await fs.ensureDir(this.viewsPath)
      }
      const index = await this.buildIndex()
      await fs.writeJson(path.join(this.viewsPath, 'index.json'), index, { spaces: 2 })
    } catch {
      // Swallow — index can be rebuilt on next sync()/getIndex() call
    }
  }

  private async buildIndex(): Promise<KBIndex> {
    const entities = await this.listEntities()
    const events = await this.readEvents()

    const index: KBIndex = {
      project: path.basename(this.projectPath),
      generatedAt: new Date().toISOString(),
      stats: {
        entities: entities.length,
        edges: entities.reduce((sum, e) => sum + e.edges.length, 0),
        events: events.length,
        byType: {},
      },
      entities: {},
      edges: [],
    }

    for (const entity of entities) {
      index.stats.byType[entity.type] = (index.stats.byType[entity.type] || 0) + 1
      index.entities[entity.id] = {
        type: entity.type,
        title: entity.title,
        status: entity.status,
      }
      for (const edge of entity.edges) {
        index.edges.push({
          source: entity.id,
          relation: edge.relation,
          target: edge.target,
        })
      }
    }

    return index
  }

  private async generateViews(
    entityMap: Map<string, KBEntity>,
    events: KBEvent[]
  ): Promise<void> {
    // index.json
    const entities = Array.from(entityMap.values())
    const index: KBIndex = {
      project: path.basename(this.projectPath),
      generatedAt: new Date().toISOString(),
      stats: {
        entities: entities.length,
        edges: entities.reduce((sum, e) => sum + e.edges.length, 0),
        events: events.length,
        byType: {},
      },
      entities: {},
      edges: [],
    }

    for (const entity of entities) {
      index.stats.byType[entity.type] = (index.stats.byType[entity.type] || 0) + 1
      index.entities[entity.id] = {
        type: entity.type,
        title: entity.title,
        status: entity.status,
      }
      for (const edge of entity.edges) {
        index.edges.push({
          source: entity.id,
          relation: edge.relation,
          target: edge.target,
        })
      }
    }

    await fs.writeJson(path.join(this.viewsPath, 'index.json'), index, { spaces: 2 })

    // context.md
    const context = await this.generateContext()
    await fs.writeFile(path.join(this.viewsPath, 'context.md'), context, 'utf-8')

    // graph.dot
    const dot = await this.exportGraph('dot')
    await fs.writeFile(path.join(this.viewsPath, 'graph.dot'), dot, 'utf-8')

    // timeline.md
    const timeline = this.buildTimelineMd(events)
    await fs.writeFile(path.join(this.viewsPath, 'timeline.md'), timeline, 'utf-8')
  }

  private buildTimelineMd(events: KBEvent[]): string {
    const lines: string[] = ['# Timeline\n']

    let currentDate = ''
    for (const evt of events) {
      const date = evt.ts.split('T')[0]
      if (date !== currentDate) {
        currentDate = date
        lines.push(`\n## ${date}\n`)
      }

      const time = evt.ts.split('T')[1]?.slice(0, 5) || ''
      const entityRef = evt.entityId ? ` \`${evt.entityId}\`` : ''
      lines.push(`- **${time}** ${evt.type}${entityRef} — ${evt.actor}`)
    }

    return lines.join('\n')
  }
}
