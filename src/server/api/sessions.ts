import { Router } from 'express'
import { ClaudeOrka } from '../../core/ClaudeOrka'
import { getGlobalStateManager } from '../../core/GlobalStateManager'
import { StateManager } from '../../core/StateManager'
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
 * POST /api/sessions/hook
 *
 * Receiver for Claude Code session-watcher hooks. Installed in every
 * Orka-managed project's `.claude/settings.json` (see
 * `src/server/session-watcher-hooks.ts`). Claude POSTs its hook payload as
 * raw JSON; we map `session_id` back to one of our Orka sessions and update
 * the persisted `waitingForInput` flag so the dashboard knows which session
 * is blocked on the user.
 *
 * Hook events handled (`?event=<name>` and/or payload `hook_event_name`):
 *   - Notification     → may set the flag (filtered by message content)
 *   - UserPromptSubmit → clears the flag (user just sent input)
 *   - PreToolUse       → clears the flag (Claude resumed work)
 *
 * Always responds 200 — we never want a hook failure to surface back into
 * Claude's session and disturb the user.
 */
sessionsRouter.post('/hook', async (req, res) => {
  try {
    const payload = (req.body || {}) as Record<string, unknown>
    const event = String(req.query.event || payload.hook_event_name || payload.event_type || '')
    const claudeSessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
    const message = typeof payload.message === 'string' ? payload.message : undefined

    if (!event || !claudeSessionId) {
      logger.warn(`hook: missing event or session_id (event=${event}, sid=${claudeSessionId})`)
      res.json({ ok: true, skipped: 'missing event or session_id' })
      return
    }

    const target = await findSessionByClaudeId(claudeSessionId, cwd)
    if (!target) {
      // Not every Claude session belongs to an Orka session — silently ignore.
      logger.debug(`hook: ${event} for ${claudeSessionId.slice(0, 8)}… (no matching Orka session)`)
      res.json({ ok: true, skipped: 'no matching session' })
      return
    }

    logger.info(`hook: ${event} for session ${target.sessionId.slice(0, 8)}… (${target.branch})${message ? ` — "${message.slice(0, 80)}"` : ''}`)

    const { sm, sessionId, branch } = target
    if (event === 'Notification') {
      if (isUserBlockingMessage(message)) {
        await sm.updateSession(sessionId, {
          waitingForInput: true,
          waitingSince: new Date().toISOString(),
          waitingMessage: message,
          waitingBranch: branch,
        })
      }
      // Non-blocking notifications (idle 60s reminders) are intentionally
      // ignored to avoid false positives.
    } else if (event === 'UserPromptSubmit' || event === 'PreToolUse') {
      await sm.updateSession(sessionId, {
        waitingForInput: false,
        waitingSince: undefined,
        waitingMessage: undefined,
        waitingBranch: undefined,
      })
    }

    res.json({ ok: true })
  } catch (error: any) {
    // Never propagate to Claude — log and ack.
    logger.warn(`session-watcher hook: ${error?.message || error}`)
    res.json({ ok: true, error: error?.message || String(error) })
  }
})

/**
 * POST /api/sessions/:sessionId/acknowledge-waiting?project=<base64>
 *
 * Manual ack: the user opened the session in the UI, so clear the
 * `waitingForInput` flag regardless of whether Claude has resumed yet.
 */
sessionsRouter.post('/:sessionId/acknowledge-waiting', async (req, res) => {
  try {
    const encodedPath = req.query.project as string | undefined
    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }
    const projectPath = decodeProjectPath(encodedPath)
    const sm = new StateManager(projectPath)
    await sm.updateSession(req.params.sessionId, {
      waitingForInput: false,
      waitingSince: undefined,
      waitingMessage: undefined,
      waitingBranch: undefined,
    })
    res.json({ ok: true })
  } catch (error: any) {
    logger.warn(`acknowledge-waiting: ${error?.message || error}`)
    res.status(500).json({ error: error?.message || String(error) })
  }
})

/** Heuristic: only treat Notification events that look like a real
 *  permission/decision prompt as "waiting for input". Filters out the
 *  60-second idle reminder which would otherwise produce false positives. */
function isUserBlockingMessage(message?: string): boolean {
  if (!message) return true // be conservative if Claude omits text
  const m = message.toLowerCase()
  return (
    m.includes('permission') ||
    m.includes('needs your') ||
    m.includes('needs input') ||
    m.includes('approve') ||
    m.includes('approval') ||
    m.includes('decision') ||
    m.includes('decide') ||
    m.includes('waiting for') ||
    m.includes('confirm')
  )
}

/** Find which Orka project + session owns a given Claude session id.
 *  Uses cwd as a fast prefix-match shortcut when present, otherwise scans
 *  all registered projects. Returns the StateManager so the caller can
 *  persist updates without re-loading. */
async function findSessionByClaudeId(
  claudeSessionId: string,
  cwd: string
): Promise<{ sm: StateManager; sessionId: string; branch: string } | null> {
  const global = await getGlobalStateManager()
  const projects = global.getProjects()

  // Prioritize the project whose path is an ancestor of cwd (cheap & precise).
  const ordered = [...projects].sort((a, b) => {
    const ac = cwd && cwd.startsWith(a.path) ? 1 : 0
    const bc = cwd && cwd.startsWith(b.path) ? 1 : 0
    return bc - ac
  })

  for (const project of ordered) {
    try {
      const sm = new StateManager(project.path)
      const sessions = await sm.getAllSessions()
      for (const session of sessions) {
        if (session.main.claudeSessionId === claudeSessionId) {
          return { sm, sessionId: session.id, branch: 'main' }
        }
        const fork = session.forks.find((f) => f.claudeSessionId === claudeSessionId)
        if (fork) {
          return { sm, sessionId: session.id, branch: fork.id }
        }
      }
    } catch {
      // Project state may be unreadable mid-init — skip and continue.
    }
  }
  return null
}

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
 * Automatically syncs session IDs for active sessions (detects /clear, crashes, etc.)
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

    // Auto-sync session IDs for active sessions (non-blocking best-effort)
    try {
      const syncResult = await orka.syncSessionIds(sessionId)
      if (syncResult) {
        logger.info(`Session ${sessionId} IDs synced: main=${syncResult.mainChanged}, forks=${syncResult.forksChanged.join(',')}`)
      }
    } catch (syncError) {
      logger.debug(`Session sync skipped: ${syncError}`)
    }

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
 * POST /api/sessions/:sessionId/sync?project=<base64-path>
 * Explicitly sync session IDs (detect /clear, crashes, etc.)
 */
sessionsRouter.post('/:sessionId/sync', async (req, res) => {
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

    const result = await orka.syncSessionIds(sessionId)

    res.json({ synced: !!result, changes: result })
  } catch (error: any) {
    logger.error('Failed to sync session IDs:', error)
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

/**
 * POST /api/sessions/:sessionId/pane-label
 * Rename a tmux pane's label (the `@orka_label` shown in the pane border).
 * Body: { project: string (base64), label: string, paneId?: string }
 * When `paneId` is omitted the session's active pane is relabeled.
 */
sessionsRouter.post('/:sessionId/pane-label', async (req, res) => {
  try {
    const { sessionId } = req.params
    const { project: encodedPath, label, paneId } = req.body || {}

    if (!encodedPath) {
      res.status(400).json({ error: 'project is required (base64 encoded path)' })
      return
    }
    if (typeof label !== 'string' || !label.trim()) {
      res.status(400).json({ error: 'label is required and must be non-empty' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    const relabeledPane = await orka.renamePaneLabel(
      sessionId,
      typeof paneId === 'string' && paneId ? paneId : undefined,
      label
    )

    res.json({ ok: true, paneId: relabeledPane, label: label.trim() })
  } catch (error: any) {
    logger.error('Failed to set pane label:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/pane-zoom
 * Toggle zoom on a tmux pane — server-side equivalent of the `prefix + z`
 * keybind. Body: { project: string (base64), paneId?: string }
 * When `paneId` is omitted the session's currently-active pane is used.
 * Response: { ok: true, paneId, zoomed: boolean }
 */
sessionsRouter.post('/:sessionId/pane-zoom', async (req, res) => {
  try {
    const { sessionId } = req.params
    const { project: encodedPath, paneId } = req.body || {}

    if (!encodedPath) {
      res.status(400).json({ error: 'project is required (base64 encoded path)' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    const result = await orka.togglePaneZoom(
      sessionId,
      typeof paneId === 'string' && paneId ? paneId : undefined
    )

    res.json({ ok: true, ...result })
  } catch (error: any) {
    logger.error('Failed to toggle pane zoom:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/layout
 * Change the session's tmux pane arrangement. Applied immediately and
 * persisted so it is re-applied on every resume.
 * Body: { project: string (base64), layout: SessionLayout }
 */
const VALID_LAYOUTS = ['tiled', 'even-horizontal', 'even-vertical', 'main-vertical']
sessionsRouter.post('/:sessionId/layout', async (req, res) => {
  try {
    const { sessionId } = req.params
    const { project: encodedPath, layout } = req.body || {}

    if (!encodedPath) {
      res.status(400).json({ error: 'project is required (base64 encoded path)' })
      return
    }
    if (!VALID_LAYOUTS.includes(layout)) {
      res.status(400).json({ error: `layout must be one of: ${VALID_LAYOUTS.join(', ')}` })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    await orka.setSessionLayout(sessionId, layout)

    res.json({ ok: true, layout })
  } catch (error: any) {
    logger.error('Failed to set session layout:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/sessions/:sessionId/capture?project=<base64>&branch=<main|forkId>&lines=<n>
 * Capture the content of the tmux pane for a given branch (main or fork).
 * If branch omitted, captures whichever pane is currently active in tmux.
 */
sessionsRouter.get('/:sessionId/capture', async (req, res) => {
  try {
    const { sessionId } = req.params
    const encodedPath = req.query.project as string
    const branch = (req.query.branch as string) || ''
    const lines = parseInt((req.query.lines as string) || '300', 10)

    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    const session = await orka.getSession(sessionId)
    if (!session) {
      res.status(404).json({ error: 'session not found' })
      return
    }

    // Resolve branch → paneId
    let paneId: string | undefined
    const targetBranch = branch || (await orka.getActiveBranch(sessionId)) || 'main'

    if (targetBranch === 'main') {
      paneId = session.main?.tmuxPaneId
    } else if (targetBranch.startsWith('untracked:')) {
      // Manual pane — pane id embedded after the prefix
      paneId = targetBranch.slice('untracked:'.length)
    } else {
      const fork = session.forks.find((f) => f.id === targetBranch)
      paneId = fork?.tmuxPaneId
      if (!paneId) {
        // Maybe it's an untrackedPane id saved in state
        const untracked = session.untrackedPanes?.find((u) => u.tmuxPaneId === targetBranch)
        paneId = untracked?.tmuxPaneId
      }
    }

    if (!paneId) {
      res.status(404).json({ error: `No pane found for branch '${targetBranch}'` })
      return
    }

    const wantAnsi = req.query.ansi === 'true' || req.query.ansi === '1'
    const { TmuxCommands } = await import('../../utils/tmux')
    const text = wantAnsi
      ? await TmuxCommands.capturePaneAnsi(paneId, -lines)
      : await TmuxCommands.capturePane(paneId, -lines)

    res.json({ text, paneId, branch: targetBranch, ansi: wantAnsi })
  } catch (error: any) {
    logger.error('Failed to capture pane:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/send-text
 * Send text to a session's tmux pane (types it + Enter)
 */
sessionsRouter.post('/:sessionId/send-text', async (req, res) => {
  try {
    const projectPath = decodeProjectPath(req.query.project as string)
    const { sessionId } = req.params
    const { text, branch } = req.body

    if (!text) {
      res.status(400).json({ error: 'text is required' })
      return
    }

    const orka = new ClaudeOrka(projectPath)
    const session = await orka.getSession(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Determine pane: main or fork
    let paneId = session.main?.tmuxPaneId
    if (branch && branch !== 'main') {
      const fork = session.forks?.find((f: any) => f.id === branch)
      if (fork?.tmuxPaneId) paneId = fork.tmuxPaneId
    }

    if (!paneId) {
      res.status(400).json({ error: 'No active pane found' })
      return
    }

    const { TmuxCommands } = await import('../../utils/tmux')
    await TmuxCommands.sendKeys(paneId, text)
    await TmuxCommands.sendEnter(paneId)

    res.json({ success: true, paneId })
  } catch (error: any) {
    logger.error('Failed to send text:', error)
    res.status(500).json({ error: error.message })
  }
})
