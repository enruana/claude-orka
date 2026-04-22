/**
 * Knowledge Base API Router
 */

import { Router } from 'express'
import { KnowledgeBaseManager } from '../../core/KnowledgeBaseManager'
import { logger } from '../../utils'

export const kbRouter = Router()

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
