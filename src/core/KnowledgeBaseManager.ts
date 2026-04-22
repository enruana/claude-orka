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
} from '../models'

const KB_DIR = path.join('.claude-orka', '.orka-kb')
const EVENTS_FILE = 'events.jsonl'
const ENTITIES_DIR = 'entities'
const VIEWS_DIR = 'views'

const TYPE_PREFIXES: Record<string, string> = {
  decision: 'dec',
  meeting: 'mtg',
  question: 'qst',
  person: 'per',
  direction: 'dir',
  repo: 'rep',
  artifact: 'art',
  milestone: 'mil',
  context: 'ctx',
  project: 'prj',
}

function generateId(type: string): string {
  const prefix = TYPE_PREFIXES[type] || type.slice(0, 3)
  return `${prefix}-${nanoid(8)}`
}

export interface AddEntityOptions {
  status?: KBEntityStatus
  properties?: Record<string, unknown>
  tags?: string[]
  edges?: Array<{ relation: string; target: string }>
  actor?: string
}

export interface UpdateEntityOptions {
  status?: KBEntityStatus
  title?: string
  properties?: Record<string, unknown>
  addTags?: string[]
  removeTags?: string[]
  actor?: string
}

export class KnowledgeBaseManager {
  private projectPath: string
  private kbPath: string
  private eventsPath: string
  private entitiesPath: string
  private viewsPath: string

  constructor(projectPath: string) {
    this.projectPath = projectPath
    this.kbPath = path.join(projectPath, KB_DIR)
    this.eventsPath = path.join(this.kbPath, EVENTS_FILE)
    this.entitiesPath = path.join(this.kbPath, ENTITIES_DIR)
    this.viewsPath = path.join(this.kbPath, VIEWS_DIR)
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

    const event = await this.appendEvent({
      type: 'entity.created',
      entityId: id,
      actor,
      data: { type, title, status: opts.status || 'active', properties: opts.properties || {}, tags: opts.tags || [] },
      refs: opts.edges?.map((e) => e.target),
    })

    const entity: KBEntity = {
      id,
      type,
      title,
      status: opts.status || 'active',
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
        await this.addEdge(id, edge.relation, edge.target, actor)
      }
      // Re-read entity after edges were added
      const updated = await this.getEntity(id)
      if (updated) return updated
    }

    return entity
  }

  async updateEntity(id: string, opts: UpdateEntityOptions): Promise<KBEntity> {
    const entity = await this.getEntity(id)
    if (!entity) {
      throw new Error(`Entity not found: ${id}`)
    }

    const now = new Date().toISOString()
    const actor = opts.actor || 'cli'
    const changes: Record<string, unknown> = {}

    if (opts.status && opts.status !== entity.status) {
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
    actor = 'cli'
  ): Promise<KBEdge> {
    const source = await this.getEntity(sourceId)
    if (!source) throw new Error(`Entity not found: ${sourceId}`)

    const target = await this.getEntity(targetId)
    if (!target) throw new Error(`Entity not found: ${targetId}`)

    const now = new Date().toISOString()

    const event = await this.appendEvent({
      type: 'edge.created',
      entityId: sourceId,
      actor,
      data: { relation, target: targetId },
      refs: [targetId],
    })

    const edge: KBEdge = {
      relation,
      target: targetId,
      since: now,
      eventRef: event.id,
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
  }

  // --- Queries ---

  async getEntity(id: string): Promise<KBEntity | null> {
    const filePath = path.join(this.entitiesPath, `${id}.json`)
    if (!await fs.pathExists(filePath)) return null
    return fs.readJson(filePath)
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

      entities.push(entity)
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

  async generateContext(projectId?: string): Promise<string> {
    const allEntities = await this.listEntities()
    const events = await this.readEvents()

    // If project filter, compute related entities (2-hop BFS)
    let entities = allEntities
    let project: KBEntity | undefined

    if (projectId) {
      project = allEntities.find((e) => e.id === projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)

      const related = new Set<string>([projectId])
      const adjacency = new Map<string, Set<string>>()
      for (const e of allEntities) {
        if (!adjacency.has(e.id)) adjacency.set(e.id, new Set())
        for (const edge of e.edges) {
          adjacency.get(e.id)!.add(edge.target)
          if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set())
          adjacency.get(edge.target)!.add(e.id)
        }
      }
      const queue = [projectId]
      const visited = new Set([projectId])
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
          const { relation, target } = event.data as { relation: string; target: string }
          entity.edges.push({ relation, target, since: event.ts, eventRef: event.id })
          entity.updated = event.ts
          entity.history.push({
            ts: event.ts,
            event: event.id,
            summary: `Linked to ${target} via "${relation}"`,
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
            edges: [{ relation: 'contributes-to', target: repoEntity.id }],
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
          properties: { filePath: docFile },
          edges: [{ relation: 'part-of', target: repoEntity.id }],
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
