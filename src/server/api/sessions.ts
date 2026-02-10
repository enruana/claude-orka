import { Router } from 'express'
import { ClaudeOrka } from '../../core/ClaudeOrka'
import { getGlobalStateManager } from '../../core/GlobalStateManager'
import { logger } from '../../utils'

export const sessionsRouter = Router()

/**
 * Helper to decode project path from base64
 */
function decodeProjectPath(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

/**
 * GET /api/sessions?project=<base64-path>
 * List all sessions for a project
 */
sessionsRouter.get('/', async (req, res) => {
  try {
    const encodedPath = req.query.project as string
    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required (base64 encoded path)' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    const sessions = await orka.listSessions()
    res.json(sessions)
  } catch (error: any) {
    logger.error('Failed to list sessions:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions
 * Create a new session
 * Body: { project: string (base64), name?: string, continueFromClaudeSession?: string }
 */
sessionsRouter.post('/', async (req, res) => {
  try {
    const { project: encodedPath, name, continueFromClaudeSession } = req.body

    if (!encodedPath) {
      res.status(400).json({ error: 'project is required (base64 encoded path)' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const globalState = await getGlobalStateManager()

    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    // Create session without opening terminal window (we're web-based now)
    const session = await orka.createSession({
      name,
      openTerminal: false,
      continueFromClaudeSession,
    })

    // Update last opened
    await globalState.touchProject(projectPath)

    res.status(201).json(session)
  } catch (error: any) {
    logger.error('Failed to create session:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/sessions/:sessionId?project=<base64-path>
 * Get a specific session
 */
sessionsRouter.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params
    const encodedPath = req.query.project as string

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    const session = await orka.getSession(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    res.json(session)
  } catch (error: any) {
    logger.error('Failed to get session:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/resume?project=<base64-path>
 * Resume a session
 */
sessionsRouter.post('/:sessionId/resume', async (req, res) => {
  try {
    const { sessionId } = req.params
    const encodedPath = req.query.project as string

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const globalState = await getGlobalStateManager()
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    // Resume without opening terminal window
    const session = await orka.resumeSession(sessionId, false)

    // Update last opened
    await globalState.touchProject(projectPath)

    res.json(session)
  } catch (error: any) {
    logger.error('Failed to resume session:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/detach?project=<base64-path>
 * Detach a session (keeps tmux running in background)
 */
sessionsRouter.post('/:sessionId/detach', async (req, res) => {
  try {
    const { sessionId } = req.params
    const encodedPath = req.query.project as string

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    await orka.detachSession(sessionId)

    res.json({ success: true })
  } catch (error: any) {
    logger.error('Failed to detach session:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/close?project=<base64-path>
 * Close a session (kills tmux and all processes)
 */
sessionsRouter.post('/:sessionId/close', async (req, res) => {
  try {
    const { sessionId } = req.params
    const encodedPath = req.query.project as string

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    await orka.closeSession(sessionId)

    res.json({ success: true })
  } catch (error: any) {
    logger.error('Failed to close session:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /api/sessions/:sessionId?project=<base64-path>
 * Delete a session permanently
 */
sessionsRouter.delete('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params
    const encodedPath = req.query.project as string

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    await orka.deleteSession(sessionId)

    res.json({ success: true })
  } catch (error: any) {
    logger.error('Failed to delete session:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/forks?project=<base64-path>
 * Create a fork
 * Body: { name?: string, parentId?: string }
 */
sessionsRouter.post('/:sessionId/forks', async (req, res) => {
  try {
    const { sessionId } = req.params
    const encodedPath = req.query.project as string
    const { name, parentId } = req.body

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    const fork = await orka.createFork(sessionId, name, parentId)

    res.status(201).json(fork)
  } catch (error: any) {
    logger.error('Failed to create fork:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/forks/:forkId/close?project=<base64-path>
 * Close a fork
 */
sessionsRouter.post('/:sessionId/forks/:forkId/close', async (req, res) => {
  try {
    const { sessionId, forkId } = req.params
    const encodedPath = req.query.project as string

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    await orka.closeFork(sessionId, forkId)

    res.json({ success: true })
  } catch (error: any) {
    logger.error('Failed to close fork:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/forks/:forkId/export?project=<base64-path>
 * Export a fork
 */
sessionsRouter.post('/:sessionId/forks/:forkId/export', async (req, res) => {
  try {
    const { sessionId, forkId } = req.params
    const encodedPath = req.query.project as string

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    const exportPath = await orka.generateForkExport(sessionId, forkId)

    res.json({ success: true, exportPath })
  } catch (error: any) {
    logger.error('Failed to export fork:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/forks/:forkId/merge?project=<base64-path>
 * Merge a fork
 */
sessionsRouter.post('/:sessionId/forks/:forkId/merge', async (req, res) => {
  try {
    const { sessionId, forkId } = req.params
    const encodedPath = req.query.project as string

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    await orka.merge(sessionId, forkId)

    res.json({ success: true })
  } catch (error: any) {
    logger.error('Failed to merge fork:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/select-branch?project=<base64-path>
 * Select/focus a branch in the tmux session
 * Body: { branchId: string }
 */
sessionsRouter.post('/:sessionId/select-branch', async (req, res) => {
  try {
    const { sessionId } = req.params
    const encodedPath = req.query.project as string
    const { branchId } = req.body

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    if (!branchId) {
      res.status(400).json({ error: 'branchId is required in body' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    await orka.selectBranch(sessionId, branchId)

    res.json({ success: true })
  } catch (error: any) {
    logger.error('Failed to select branch:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/restart?project=<base64-path>
 * Restart a session (close and resume - useful to reload hooks)
 */
sessionsRouter.post('/:sessionId/restart', async (req, res) => {
  try {
    const { sessionId } = req.params
    const encodedPath = req.query.project as string

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const globalState = await getGlobalStateManager()
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    // Close the session first
    logger.info(`Restarting session ${sessionId} in ${projectPath}`)
    await orka.closeSession(sessionId)

    // Small delay to ensure cleanup
    await new Promise(resolve => setTimeout(resolve, 500))

    // Resume the session
    const session = await orka.resumeSession(sessionId, false)

    // Update last opened
    await globalState.touchProject(projectPath)

    logger.info(`Session ${sessionId} restarted successfully`)
    res.json(session)
  } catch (error: any) {
    logger.error('Failed to restart session:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/sessions/:sessionId/active-branch?project=<base64-path>
 * Get the currently active branch in the tmux session
 */
sessionsRouter.get('/:sessionId/active-branch', async (req, res) => {
  try {
    const { sessionId } = req.params
    const encodedPath = req.query.project as string

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    const activeBranch = await orka.getActiveBranch(sessionId)

    res.json({ activeBranch })
  } catch (error: any) {
    logger.error('Failed to get active branch:', error)
    res.status(500).json({ error: error.message })
  }
})
