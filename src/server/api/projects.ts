import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getGlobalStateManager } from '../../core/GlobalStateManager'
import { ClaudeOrka } from '../../core/ClaudeOrka'
import { StateManager, getOrkaVersion } from '../../core/StateManager'
import { TmuxCommands } from '../../utils/tmux'
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

    // Apply updated tmux config to all active sessions
    try {
      const state = await stateManager.read()
      const activeSessions = state.sessions.filter(s => s.status === 'active')
      for (const session of activeSessions) {
        try {
          await TmuxCommands.applyOrkaTheme(session.tmuxSessionId, projectPath)
          logger.info(`Reloaded tmux config for session ${session.tmuxSessionId}`)
        } catch (err: any) {
          logger.warn(`Failed to reload tmux config for session ${session.tmuxSessionId}: ${err.message}`)
        }
      }
    } catch (err: any) {
      logger.warn(`Failed to reload tmux config for active sessions: ${err.message}`)
    }

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
// Task routes (CRUD for project tasks/todos)
// Uses ?project= query param (same pattern as sessions/files/git)
// because base64-encoded paths contain '/' which breaks path params.
// ============================================================

/** Helper to extract and decode the project query param */
function getProjectPath(req: any, res: any): string | null {
  const encoded = req.query.project as string
  if (!encoded) {
    res.status(400).json({ error: 'project query param is required (base64 encoded path)' })
    return null
  }
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

/**
 * GET /api/projects/tasks?project=ENCODED
 * List all tasks for a project
 */
projectsRouter.get('/tasks', async (req, res) => {
  try {
    const projectPath = getProjectPath(req, res)
    if (!projectPath) return

    const stateManager = new StateManager(projectPath)
    const tasks = await stateManager.listTasks()
    res.json(tasks)
  } catch (error: any) {
    logger.error('Failed to list tasks:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/projects/tasks?project=ENCODED
 * Create a new task
 * Body: { title: string }
 */
projectsRouter.post('/tasks', async (req, res) => {
  try {
    const projectPath = getProjectPath(req, res)
    if (!projectPath) return

    const { title } = req.body

    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'title is required' })
      return
    }

    const stateManager = new StateManager(projectPath)
    const task = {
      id: uuidv4(),
      title: title.trim(),
      completed: false,
      createdAt: new Date().toISOString(),
    }
    await stateManager.addTask(task)
    res.status(201).json(task)
  } catch (error: any) {
    logger.error('Failed to create task:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * PATCH /api/projects/tasks/:taskId?project=ENCODED
 * Update a task
 * Body: { title?: string, completed?: boolean }
 */
projectsRouter.patch('/tasks/:taskId', async (req, res) => {
  try {
    const projectPath = getProjectPath(req, res)
    if (!projectPath) return

    const { taskId } = req.params
    const { title, completed } = req.body

    const stateManager = new StateManager(projectPath)
    const updated = await stateManager.updateTask(taskId, { title, completed })
    res.json(updated)
  } catch (error: any) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message })
      return
    }
    logger.error('Failed to update task:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /api/projects/tasks/:taskId?project=ENCODED
 * Delete a task
 */
projectsRouter.delete('/tasks/:taskId', async (req, res) => {
  try {
    const projectPath = getProjectPath(req, res)
    if (!projectPath) return

    const { taskId } = req.params

    const stateManager = new StateManager(projectPath)
    await stateManager.deleteTask(taskId)
    res.json({ success: true })
  } catch (error: any) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message })
      return
    }
    logger.error('Failed to delete task:', error)
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
