import { Router } from 'express'
import { getGlobalStateManager } from '../../core/GlobalStateManager'
import { ClaudeOrka } from '../../core/ClaudeOrka'
import { StateManager, getOrkaVersion } from '../../core/StateManager'
import { logger } from '../../utils'
import fs from 'fs-extra'
import path from 'path'

export const projectsRouter = Router()

/**
 * GET /api/projects
 * List all registered projects with their session counts
 */
projectsRouter.get('/', async (_req, res) => {
  try {
    const globalState = await getGlobalStateManager()
    const projects = globalState.getProjects()

    // Enrich projects with session info
    const enrichedProjects = await Promise.all(
      projects.map(async (project) => {
        try {
          const orka = new ClaudeOrka(project.path)
          await orka.initialize()
          const sessions = await orka.listSessions()

          return {
            ...project,
            initialized: true,
            sessionCount: sessions.length,
            activeSessions: sessions.filter(s => s.status === 'active').length,
          }
        } catch {
          return {
            ...project,
            initialized: false,
            sessionCount: 0,
            activeSessions: 0,
          }
        }
      })
    )

    res.json(enrichedProjects)
  } catch (error: any) {
    logger.error('Failed to list projects:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/projects
 * Register a new project
 * Body: { path: string, name?: string }
 */
projectsRouter.post('/', async (req, res) => {
  try {
    const { path: projectPath, name } = req.body

    if (!projectPath) {
      res.status(400).json({ error: 'path is required' })
      return
    }

    const globalState = await getGlobalStateManager()

    // Check if path exists
    if (!await fs.pathExists(projectPath)) {
      res.status(400).json({ error: 'Project path does not exist' })
      return
    }

    // Register the project
    const project = await globalState.registerProject(projectPath, name)

    // Initialize .claude-orka if not exists
    const orkaDir = path.join(projectPath, '.claude-orka')
    if (!await fs.pathExists(orkaDir)) {
      const orka = new ClaudeOrka(projectPath)
      await orka.initialize()
      logger.info(`Initialized .claude-orka in ${projectPath}`)
    }

    res.status(201).json(project)
  } catch (error: any) {
    logger.error('Failed to register project:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============================================================
// IMPORTANT: More specific routes MUST come BEFORE /:encodedPath
// Otherwise Express will match /:encodedPath for everything
// ============================================================

/**
 * GET /api/projects/:encodedPath/version
 * Check if project version is outdated
 */
projectsRouter.get('/:encodedPath/version', async (req, res) => {
  try {
    const projectPath = Buffer.from(req.params.encodedPath, 'base64').toString('utf-8')

    const stateManager = new StateManager(projectPath)
    const versionInfo = await stateManager.checkVersion()

    res.json(versionInfo)
  } catch (error: any) {
    logger.error('Failed to check project version:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/projects/:encodedPath/reinitialize
 * Reinitialize a project (update version, refresh configs)
 */
projectsRouter.post('/:encodedPath/reinitialize', async (req, res) => {
  try {
    const projectPath = Buffer.from(req.params.encodedPath, 'base64').toString('utf-8')

    const stateManager = new StateManager(projectPath)
    await stateManager.reinitialize()

    const currentVersion = await getOrkaVersion()

    res.json({
      success: true,
      version: currentVersion,
      message: `Project reinitialized to Orka v${currentVersion}`,
    })
  } catch (error: any) {
    logger.error('Failed to reinitialize project:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/projects/:encodedPath/initialize
 * Initialize .claude-orka directory in a project
 */
projectsRouter.post('/:encodedPath/initialize', async (req, res) => {
  try {
    const projectPath = Buffer.from(req.params.encodedPath, 'base64').toString('utf-8')

    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    res.json({ success: true, path: path.join(projectPath, '.claude-orka') })
  } catch (error: any) {
    logger.error('Failed to initialize project:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============================================================
// Less specific routes come AFTER the more specific ones
// ============================================================

/**
 * GET /api/projects/:encodedPath
 * Get a specific project by its path (base64 encoded)
 */
projectsRouter.get('/:encodedPath', async (req, res) => {
  try {
    const projectPath = Buffer.from(req.params.encodedPath, 'base64').toString('utf-8')
    const globalState = await getGlobalStateManager()

    const project = globalState.getProject(projectPath)
    if (!project) {
      res.status(404).json({ error: 'Project not found' })
      return
    }

    // Get sessions
    try {
      const orka = new ClaudeOrka(projectPath)
      await orka.initialize()
      const sessions = await orka.listSessions()

      res.json({
        ...project,
        initialized: true,
        sessions,
      })
    } catch {
      res.json({
        ...project,
        initialized: false,
        sessions: [],
      })
    }
  } catch (error: any) {
    logger.error('Failed to get project:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /api/projects/:encodedPath
 * Unregister a project (does not delete files)
 */
projectsRouter.delete('/:encodedPath', async (req, res) => {
  try {
    const projectPath = Buffer.from(req.params.encodedPath, 'base64').toString('utf-8')
    const globalState = await getGlobalStateManager()

    const removed = await globalState.unregisterProject(projectPath)
    if (!removed) {
      res.status(404).json({ error: 'Project not found' })
      return
    }

    res.json({ success: true })
  } catch (error: any) {
    logger.error('Failed to unregister project:', error)
    res.status(500).json({ error: error.message })
  }
})
