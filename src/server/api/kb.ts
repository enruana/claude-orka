/**
 * Knowledge Base API Router
 */

import { Router } from 'express'
import { KnowledgeBaseManager } from '../../core/KnowledgeBaseManager'
import { KB_STATUSES, KB_TRANSITIONS } from '../../models/kb-registry'
import { logger } from '../../utils'

export const kbRouter = Router()

/**
 * GET /api/kb/schema - Valid statuses + allowed transitions per entity type.
 * Static (no project) — single source of truth for status-selector UIs.
 */
kbRouter.get('/schema', (_req, res) => {
  res.json({ statuses: KB_STATUSES, transitions: KB_TRANSITIONS })
})

function getManager(projectPath: string): KnowledgeBaseManager {
  return new KnowledgeBaseManager(projectPath)
}

function decodeProject(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

/**
 * GET /api/kb/status - Check KB initialization and stats
 */
kbRouter.get('/status', async (req, res) => {
  try {
    const projectPath = decodeProject(req.query.project as string)
    const manager = getManager(projectPath)

    if (!manager.isInitialized()) {
      res.json({ initialized: false })
      return
    }

    const index = await manager.getIndex()
    res.json({ initialized: true, stats: index.stats })
  } catch (error: any) {
    logger.error('KB status error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/kb/entities - List entities
 */
kbRouter.get('/entities', async (req, res) => {
  try {
    const projectPath = decodeProject(req.query.project as string)
    const manager = getManager(projectPath)

    if (!manager.isInitialized()) {
      res.status(404).json({ error: 'KB not initialized' })
      return
    }

    const entities = await manager.listEntities({
      type: req.query.type as string | undefined,
      status: req.query.status as string | undefined,
      tag: req.query.tag as string | undefined,
    })

    res.json(entities)
  } catch (error: any) {
    logger.error('KB list entities error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/kb/entities/:id - Get entity
 */
kbRouter.get('/entities/:id', async (req, res) => {
  try {
    const projectPath = decodeProject(req.query.project as string)
    const manager = getManager(projectPath)

    const entity = await manager.getEntity(req.params.id)
    if (!entity) {
      res.status(404).json({ error: 'Entity not found' })
      return
    }

    res.json(entity)
  } catch (error: any) {
    logger.error('KB get entity error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/kb/entities - Create entity
 */
kbRouter.post('/entities', async (req, res) => {
  try {
    const projectPath = decodeProject(req.query.project as string)
    const manager = getManager(projectPath)

    if (!manager.isInitialized()) {
      res.status(404).json({ error: 'KB not initialized' })
      return
    }

    const { type, title, status, properties, tags, edges } = req.body
    const entity = await manager.addEntity(type, title, {
      status,
      properties,
      tags,
      edges,
      actor: 'api',
    })

    res.status(201).json(entity)
  } catch (error: any) {
    logger.error('KB create entity error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * PATCH /api/kb/entities/:id - Update entity
 */
kbRouter.patch('/entities/:id', async (req, res) => {
  try {
    const projectPath = decodeProject(req.query.project as string)
    const manager = getManager(projectPath)

    const { status, title, properties, addTags, removeTags } = req.body
    const entity = await manager.updateEntity(req.params.id, {
      status,
      title,
      properties,
      addTags,
      removeTags,
      actor: 'api',
    })

    res.json(entity)
  } catch (error: any) {
    logger.error('KB update entity error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/kb/quick-action
 *
 * Apply a one-shot mutation on an entity from an EXTERNAL link — e.g. a link
 * embedded in a Google Calendar event description so the user can flip a
 * task's status straight from their calendar / Gmail. Returns a small styled
 * HTML page so it is clickable from anywhere.
 *
 * Query params:
 *   project — base64-encoded project path (same encoding as the rest of /api/kb)
 *   id      — entity id
 *   op      — currently only `set-status`
 *   value   — target status (for `set-status`)
 */
kbRouter.get('/quick-action', async (req, res) => {
  const sendPage = (
    code: number,
    opts: { ok: boolean; title: string; message: string; entityId?: string; encodedProject?: string }
  ): void => {
    res.status(code).type('html').send(renderQuickActionPage(opts))
  }

  try {
    const encodedProject = String(req.query.project || '')
    const id = String(req.query.id || '')
    const op = String(req.query.op || '')
    const value = String(req.query.value || '')

    if (!encodedProject || !id || !op) {
      sendPage(400, { ok: false, title: 'Missing parameters', message: 'project, id and op are required.' })
      return
    }

    const projectPath = decodeProject(encodedProject)
    const manager = getManager(projectPath)

    if (!manager.isInitialized()) {
      sendPage(404, { ok: false, title: 'KB not initialized', message: `No KB found at ${projectPath}.` })
      return
    }

    if (op === 'set-status') {
      if (!value) {
        sendPage(400, { ok: false, title: 'Missing value', message: 'A target status is required for set-status.' })
        return
      }
      const entity = await manager.updateEntity(id, { status: value, actor: 'calendar-link' })
      sendPage(200, {
        ok: true,
        title: `Status → ${entity.status}`,
        message: `${entity.title} is now marked as "${entity.status}".`,
        entityId: entity.id,
        encodedProject,
      })
      return
    }

    sendPage(400, { ok: false, title: 'Unknown operation', message: `Operation "${op}" is not supported.` })
  } catch (error: any) {
    logger.error('KB quick-action error:', error)
    res.status(500).type('html').send(renderQuickActionPage({
      ok: false,
      title: 'Action failed',
      message: error?.message || 'Unknown error',
    }))
  }
})

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  )
}

function renderQuickActionPage(opts: {
  ok: boolean
  title: string
  message: string
  entityId?: string
  encodedProject?: string
}): string {
  const back = opts.encodedProject && opts.entityId
    ? `<a class="orka-back" href="/projects/${escapeHtml(opts.encodedProject)}/kb?entity=${encodeURIComponent(opts.entityId)}">Open in Orka →</a>`
    : `<a class="orka-back" href="/dashboard">Back to dashboard →</a>`

  const accent = opts.ok ? '#a6e3a1' : '#f38ba8'
  const badge = opts.ok ? '✓ Done' : '⚠ Error'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)} · Orka</title>
<style>
  body { background:#1e1e2e; color:#cdd6f4; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; margin:0; padding:32px 20px; min-height:100vh; box-sizing:border-box; display:flex; align-items:center; justify-content:center; }
  .card { background:#181825; border:1px solid #313244; border-radius:12px; padding:28px 26px; max-width:440px; width:100%; box-shadow:0 8px 30px rgba(0,0,0,0.4); }
  .badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:600; background:${accent}22; color:${accent}; border:1px solid ${accent}55; margin-bottom:14px; letter-spacing:0.3px; }
  h1 { margin:0 0 8px; font-size:22px; }
  p { margin:0 0 18px; color:#bac2de; line-height:1.45; }
  .orka-back { display:inline-block; color:#89b4fa; text-decoration:none; font-weight:500; }
  .orka-back:hover { text-decoration:underline; }
  .footer { margin-top:22px; padding-top:14px; border-top:1px solid #313244; font-size:12px; color:#7f849c; }
</style>
</head>
<body>
<div class="card">
  <span class="badge">${badge}</span>
  <h1>${escapeHtml(opts.title)}</h1>
  <p>${escapeHtml(opts.message)}</p>
  ${back}
  <div class="footer">Triggered from an external link · Orka Knowledge Base</div>
</div>
</body>
</html>`
}

/**
 * POST /api/kb/edges - Create edge
 */
kbRouter.post('/edges', async (req, res) => {
  try {
    const projectPath = decodeProject(req.query.project as string)
    const manager = getManager(projectPath)

    const { source, relation, target } = req.body
    const edge = await manager.addEdge(source, relation, target, 'api')

    res.status(201).json(edge)
  } catch (error: any) {
    logger.error('KB create edge error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/kb/timeline - Get events
 */
kbRouter.get('/timeline', async (req, res) => {
  try {
    const projectPath = decodeProject(req.query.project as string)
    const manager = getManager(projectPath)

    const events = await manager.getTimeline({
      since: req.query.since as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    })

    res.json(events)
  } catch (error: any) {
    logger.error('KB timeline error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/kb/graph - Export graph
 */
kbRouter.get('/graph', async (req, res) => {
  try {
    const projectPath = decodeProject(req.query.project as string)
    const manager = getManager(projectPath)

    const format = (req.query.format as string) || 'json'
    const output = await manager.exportGraph(format as 'dot' | 'json')

    if (format === 'dot') {
      res.type('text/vnd.graphviz').send(output)
    } else {
      res.json(JSON.parse(output))
    }
  } catch (error: any) {
    logger.error('KB graph error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/kb/context - AI-optimized context
 */
kbRouter.get('/context', async (req, res) => {
  try {
    const projectPath = decodeProject(req.query.project as string)
    const manager = getManager(projectPath)
    const projectId = req.query.projectId as string | undefined

    const context = await manager.generateContext(projectId)
    res.type('text/markdown').send(context)
  } catch (error: any) {
    logger.error('KB context error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/kb/project-doc/:id - Generate/update project master doc
 */
kbRouter.post('/project-doc/:id', async (req, res) => {
  try {
    const projectPath = decodeProject(req.query.project as string)
    const manager = getManager(projectPath)

    const result = await manager.generateProjectDoc(req.params.id)
    res.json({ success: true, filePath: result.filePath })
  } catch (error: any) {
    logger.error('KB project-doc error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/kb/sync - Rebuild from events
 */
kbRouter.post('/sync', async (req, res) => {
  try {
    const projectPath = decodeProject(req.query.project as string)
    const manager = getManager(projectPath)

    await manager.sync()
    const index = await manager.getIndex()

    res.json({ success: true, stats: index.stats })
  } catch (error: any) {
    logger.error('KB sync error:', error)
    res.status(500).json({ error: error.message })
  }
})
