import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getGlobalStateManager } from '../../core/GlobalStateManager'
import { ClaudeOrka } from '../../core/ClaudeOrka'
import { startSystemTerminal, stopSystemTerminal } from '../../core/SessionManager'
import { StateManager, getOrkaVersion } from '../../core/StateManager'
import { TmuxCommands } from '../../utils/tmux'
import { KnowledgeBaseManager } from '../../core/KnowledgeBaseManager'
import { getSkillsSourcePath } from '../../utils/paths'
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
// System Terminal (standalone tmux terminal for dashboard)
// ============================================================

/**
 * POST /api/projects/system-terminal
 * Create or return existing system terminal
 */
projectsRouter.post('/system-terminal', async (_req, res) => {
  try {
    const result = await startSystemTerminal()
    res.json(result)
  } catch (error: any) {
    logger.error('Failed to start system terminal:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /api/projects/system-terminal
 * Stop and clean up system terminal
 */
projectsRouter.delete('/system-terminal', async (_req, res) => {
  try {
    await stopSystemTerminal()
    res.json({ success: true })
  } catch (error: any) {
    logger.error('Failed to stop system terminal:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/projects/system-terminal/capture?lines=<n>&ansi=<0|1>
 * Capture the content of the system terminal's tmux pane. The system
 * terminal is a single-pane session named `orka-system-terminal`; tmux's
 * `-t` target accepts a session name and captures its active pane.
 */
projectsRouter.get('/system-terminal/capture', async (req, res) => {
  try {
    const globalState = await getGlobalStateManager()
    const info = globalState.getSystemTerminal()
    if (!info) {
      res.status(404).json({ error: 'System terminal is not running' })
      return
    }

    const lines = parseInt((req.query.lines as string) || '300', 10)
    const wantAnsi = req.query.ansi === 'true' || req.query.ansi === '1'
    const target = info.tmuxSessionId

    const text = wantAnsi
      ? await TmuxCommands.capturePaneAnsi(target, -lines)
      : await TmuxCommands.capturePane(target, -lines)

    res.json({ text, target, ansi: wantAnsi })
  } catch (error: any) {
    logger.error('Failed to capture system terminal:', error)
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

    // Initialize Knowledge Base if not already present
    try {
      const kbManager = new KnowledgeBaseManager(projectPath)
      if (!kbManager.isInitialized()) {
        await kbManager.initialize()
        logger.info(`Knowledge Base initialized for project: ${projectPath}`)
      }
    } catch (err: any) {
      logger.warn(`Failed to initialize KB for project: ${err.message}`)
    }

    // Install Claude Code skills if missing
    try {
      await installSkillsToProject(projectPath)
    } catch (err: any) {
      logger.warn(`Failed to install skills for project: ${err.message}`)
    }

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
// PINS — KB entity shortcuts surfaced in the floating action button
// ============================================================

/**
 * GET /api/projects/pins?project=ENCODED
 * List all pinned KB entities for the current project. Ordered by
 * pinnedAt DESC so the FAB can render top-first without extra work.
 */
projectsRouter.get('/pins', async (req, res) => {
  try {
    const projectPath = getProjectPath(req, res)
    if (!projectPath) return

    const stateManager = new StateManager(projectPath)
    const pins = await stateManager.listPins()
    // Sort DESC by pinnedAt — new pins bubble to the top of the FAB.
    pins.sort((a, b) => (a.pinnedAt < b.pinnedAt ? 1 : -1))
    res.json(pins)
  } catch (error: any) {
    logger.error('Failed to list pins:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/projects/pins?project=ENCODED
 * Pin a KB entity to the FAB. Body: { entityId, title, type, folderPath }.
 * Idempotent — re-pinning refreshes the denormalized fields and bumps
 * `pinnedAt`. Response is the persisted pin.
 */
projectsRouter.post('/pins', async (req, res) => {
  try {
    const projectPath = getProjectPath(req, res)
    if (!projectPath) return

    const { entityId, title, type, folderPath } = req.body
    if (typeof entityId !== 'string' || !entityId.trim()) {
      res.status(400).json({ error: 'entityId is required' })
      return
    }
    if (typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: 'title is required' })
      return
    }
    if (typeof type !== 'string' || !type.trim()) {
      res.status(400).json({ error: 'type is required' })
      return
    }
    if (typeof folderPath !== 'string' || !folderPath.trim()) {
      res.status(400).json({ error: 'folderPath is required' })
      return
    }

    const pin = {
      entityId: entityId.trim(),
      title: title.trim(),
      type: type.trim(),
      folderPath: folderPath.trim(),
      pinnedAt: new Date().toISOString(),
    }

    const stateManager = new StateManager(projectPath)
    await stateManager.addPin(pin)
    res.status(201).json(pin)
  } catch (error: any) {
    logger.error('Failed to add pin:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /api/projects/pins/:entityId?project=ENCODED
 * Unpin an entity by id.
 */
projectsRouter.delete('/pins/:entityId', async (req, res) => {
  try {
    const projectPath = getProjectPath(req, res)
    if (!projectPath) return

    const { entityId } = req.params

    const stateManager = new StateManager(projectPath)
    await stateManager.deletePin(entityId)
    res.json({ success: true })
  } catch (error: any) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message })
      return
    }
    logger.error('Failed to delete pin:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============================================================
// Document Review Comments
// ============================================================

/**
 * GET /api/projects/comments?project=ENCODED
 * List all comments for a project
 */
projectsRouter.get('/comments', async (req, res) => {
  try {
    const projectPath = getProjectPath(req, res)
    if (!projectPath) return

    const stateManager = new StateManager(projectPath)
    const comments = await stateManager.listComments()
    res.json(comments)
  } catch (error: any) {
    logger.error('Failed to list comments:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/projects/comments?project=ENCODED
 * Create a new comment
 * Body: { filePath, startLine, endLine, selectedText, body }
 */
projectsRouter.post('/comments', async (req, res) => {
  try {
    const projectPath = getProjectPath(req, res)
    if (!projectPath) return

    const { filePath, startLine, endLine, selectedText, body } = req.body

    if (!filePath || !body || startLine === undefined || endLine === undefined) {
      res.status(400).json({ error: 'filePath, startLine, endLine, and body are required' })
      return
    }

    const comment = {
      id: uuidv4(),
      filePath,
      startLine: Number(startLine),
      endLine: Number(endLine),
      selectedText: selectedText || '',
      body,
      resolved: false,
      createdAt: new Date().toISOString(),
    }

    const stateManager = new StateManager(projectPath)
    await stateManager.addComment(comment)
    res.status(201).json(comment)
  } catch (error: any) {
    logger.error('Failed to create comment:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * PATCH /api/projects/comments/:commentId?project=ENCODED
 * Update a comment
 */
projectsRouter.patch('/comments/:commentId', async (req, res) => {
  try {
    const projectPath = getProjectPath(req, res)
    if (!projectPath) return

    const { commentId } = req.params
    const { body, resolved } = req.body

    const stateManager = new StateManager(projectPath)
    const updated = await stateManager.updateComment(commentId, { body, resolved })
    res.json(updated)
  } catch (error: any) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message })
      return
    }
    logger.error('Failed to update comment:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /api/projects/comments/:commentId?project=ENCODED
 * Delete a comment
 */
projectsRouter.delete('/comments/:commentId', async (req, res) => {
  try {
    const projectPath = getProjectPath(req, res)
    if (!projectPath) return

    const { commentId } = req.params

    const stateManager = new StateManager(projectPath)
    await stateManager.deleteComment(commentId)
    res.json({ success: true })
  } catch (error: any) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message })
      return
    }
    logger.error('Failed to delete comment:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============================================================
// Less specific routes come AFTER the more specific ones
// ============================================================

/**
 * PATCH /api/projects/:encodedPath
 * Update project metadata (name, group)
 * Body: { name?: string, group?: string | null }
 */
projectsRouter.patch('/:encodedPath', async (req, res) => {
  try {
    const projectPath = Buffer.from(req.params.encodedPath, 'base64').toString('utf-8')
    const { name, group } = req.body

    const globalState = await getGlobalStateManager()
    const updated = await globalState.updateProject(projectPath, { name, group })

    if (!updated) {
      res.status(404).json({ error: 'Project not found' })
      return
    }

    res.json(updated)
  } catch (error: any) {
    logger.error('Failed to update project:', error)
    res.status(500).json({ error: error.message })
  }
})

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

/**
 * Install Claude Code skills into a project's .claude/skills/.
 *
 * Handles both the current directory-based format (`<name>/SKILL.md` with
 * YAML frontmatter — required by the Claude Code skill discovery) and the
 * legacy flat `.md` format left over from older Orka versions. Legacy flat
 * files matching a name we now ship as a directory are removed so the
 * project ends up with a single, discoverable skill per name.
 *
 * Claude Code looks for custom skills in `.claude/skills/` (per project)
 * or `~/.claude/skills/` (global).
 */
async function installSkillsToProject(projectPath: string): Promise<void> {
  const skillsDir = path.join(projectPath, '.claude', 'skills')
  await fs.ensureDir(skillsDir)

  const skillsSource = getSkillsSourcePath()
  if (!skillsSource) {
    logger.warn('Skills source not found — cannot install skills')
    return
  }

  const entries = await fs.readdir(skillsSource, { withFileTypes: true })
  let installedDirs = 0
  let installedFiles = 0
  let cleanedLegacy = 0

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Directory skill (new format): copy the whole tree, overwrite so
      // frontmatter / body updates flow through on Sync.
      const srcDir = path.join(skillsSource, entry.name)
      const destDir = path.join(skillsDir, entry.name)
      await fs.copy(srcDir, destDir, { overwrite: true })
      installedDirs++

      // Nuke any legacy flat file with the same base name so the two
      // don't coexist (Claude Code would index only one, and users would
      // be confused which won).
      const legacyFlat = path.join(skillsDir, `${entry.name}.md`)
      if (await fs.pathExists(legacyFlat)) {
        await fs.remove(legacyFlat)
        cleanedLegacy++
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Flat legacy source — copy as-is. We still support this for
      // one-off skills that don't warrant a folder.
      await fs.copy(path.join(skillsSource, entry.name), path.join(skillsDir, entry.name))
      installedFiles++
    }
  }

  if (installedDirs + installedFiles > 0) {
    logger.info(
      `Installed ${installedDirs} directory skill(s) + ${installedFiles} file skill(s) in ${skillsDir}` +
      (cleanedLegacy ? ` (cleaned ${cleanedLegacy} legacy flat file(s))` : '')
    )
  }
}
