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
    // Tmux pane id — set by the hook curl command via `-H "X-Tmux-Pane: $TMUX_PANE"`.
    // Empty string when Claude is invoked outside tmux.
    const tmuxPaneId = String(req.headers['x-tmux-pane'] || '').trim()

    if (!event || !claudeSessionId) {
      logger.warn(`hook: missing event or session_id (event=${event}, sid=${claudeSessionId})`)
      res.json({ ok: true, skipped: 'missing event or session_id' })
      return
    }

    // SessionStart with source clear|compact rotates the branch's stored
    // claudeSessionId — this is the ONLY reliable rotation signal.
    // Handled independently of the (sessionId → orka branch) lookup that
    // the other events use, because after rotation the payload's session_id
    // is the NEW id which is not yet in Orka state.
    if (event === 'SessionStart') {
      const source = String(payload.source || 'startup')
      await handleSessionStart({ tmuxPaneId, cwd, claudeSessionId, source })
      res.json({ ok: true })
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
 * Handle a Claude SessionStart hook event.
 *
 * Semantics by `source`:
 *  - `startup` / `resume` — Claude just launched. The new session id
 *    should equal what Orka pre-set via `--session-id` or `--resume`.
 *    If it doesn't AND we can identify the branch, log the mismatch;
 *    no id rewrite (Orka's state is the intended source of truth for
 *    freshly-started conversations).
 *  - `clear` / `compact` — Claude minted a NEW session id and started
 *    writing to a NEW jsonl. Update the branch's `claudeSessionId` to
 *    this new id so `claude --resume` later loads the correct content.
 *
 * Branch identification (in order of precedence):
 *  1. tmux pane id — deterministic, survives id rotation.
 *  2. previous claudeSessionId lookup — used as fallback when the pane
 *     header is missing (e.g. Claude run outside tmux). Only works
 *     BEFORE the rotation is committed to state.
 */
async function handleSessionStart(opts: {
  tmuxPaneId: string
  cwd: string
  claudeSessionId: string
  source: string
}): Promise<void> {
  const { tmuxPaneId, cwd, claudeSessionId, source } = opts
  const isRotation = source === 'clear' || source === 'compact'

  // Primary path: identify the branch by tmux pane id. Only works when
  // Claude runs inside tmux (which is always true for Orka-managed
  // sessions — Orka spawns Claude inside `orka-<uuid>` tmux sessions).
  const target = tmuxPaneId ? await findSessionByTmuxPane(tmuxPaneId) : null

  if (!target) {
    if (isRotation) {
      logger.warn(
        `hook: SessionStart[${source}] for ${claudeSessionId.slice(0, 8)}… but ` +
        `no Orka branch matched pane="${tmuxPaneId}" cwd="${cwd}" — rotation LOST. ` +
        `Ensure the SessionStart hook is installed for this project.`
      )
    } else {
      logger.debug(`hook: SessionStart[${source}] for ${claudeSessionId.slice(0, 8)}… (no Orka branch)`)
    }
    return
  }

  const { sm, sessionId, branch } = target
  const session = await sm.getSession(sessionId)
  if (!session) return

  const currentStoredId = branch === 'main'
    ? session.main.claudeSessionId
    : session.forks.find((f) => f.id === branch)?.claudeSessionId

  if (currentStoredId === claudeSessionId) {
    // Common case for startup/resume — the id matches what Orka pre-set.
    logger.debug(`hook: SessionStart[${source}] for ${session.name}/${branch} — id unchanged`)
    return
  }

  if (!isRotation) {
    // Non-rotation events (startup/resume) with a mismatched id: log and
    // do NOT overwrite. This could indicate Orka's spawn command didn't
    // take effect (e.g. --session-id was ignored) or the user replaced
    // the terminal with a stray `claude` invocation. Overwriting here
    // would masquerade any real bug.
    logger.warn(
      `hook: SessionStart[${source}] for ${session.name}/${branch}: ` +
      `payload id ${claudeSessionId.slice(0, 8)}… != stored ${(currentStoredId || 'none').slice(0, 8)}… — ignoring`
    )
    return
  }

  // Rotation: commit the new id.
  if (branch === 'main') {
    session.main.claudeSessionId = claudeSessionId
  } else {
    const fork = session.forks.find((f) => f.id === branch)
    if (!fork) return
    fork.claudeSessionId = claudeSessionId
  }
  session.lastActivity = new Date().toISOString()
  await sm.replaceSession(session)
  logger.info(
    `hook: SessionStart[${source}] rotated ${session.name}/${branch}: ` +
    `${(currentStoredId || 'none').slice(0, 8)}… → ${claudeSessionId.slice(0, 8)}…`
  )
}

/** Find the Orka session + branch owning a given tmux pane id.
 *  Scans all registered projects; pane ids are globally unique within
 *  a single tmux server, so no cwd disambiguation is needed. */
async function findSessionByTmuxPane(
  tmuxPaneId: string
): Promise<{ sm: StateManager; sessionId: string; branch: string } | null> {
  if (!tmuxPaneId) return null
  const global = await getGlobalStateManager()
  const projects = global.getProjects()

  for (const project of projects) {
    try {
      const sm = new StateManager(project.path)
      const sessions = await sm.getAllSessions()
      for (const session of sessions) {
        if (session.main.tmuxPaneId === tmuxPaneId) {
          return { sm, sessionId: session.id, branch: 'main' }
        }
        const fork = session.forks.find((f) => f.tmuxPaneId === tmuxPaneId)
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

    // syncSessionIds is intentionally NOT called on GET anymore — the
    // legacy greedy matcher caused cross-session contamination in
    // projects with multiple Orka sessions. Rotation tracking now
    // happens deterministically via the SessionStart hook receiver.

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
 * GET /api/sessions/:sessionId/verify?project=<base64-path>
 *
 * Audit each branch (main + active/saved forks) of the session and
 * report any contamination symptoms:
 *  - missing:  the stored `claudeSessionId` has no `.jsonl` on disk.
 *  - mismatched-cwd: the jsonl exists but its recorded cwd does not
 *    match the Orka project path (proof the id was assigned from a
 *    conversation started elsewhere).
 *  - duplicate: the id is also claimed by another branch (main or fork)
 *    across ANY Orka session in the project — hard evidence that the
 *    old greedy sync cross-wired two branches to the same conversation.
 *
 * Read-only. Use `POST /reset-claude-id` on a specific branch to remedy.
 */
sessionsRouter.get('/:sessionId/verify', async (req, res) => {
  try {
    const { sessionId } = req.params
    const encodedPath = req.query.project as string
    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }
    const projectPath = decodeProjectPath(encodedPath)

    const [{ claudeSessionFileExists, listProjectSessions }, { StateManager: SM }] = await Promise.all([
      import('../../utils/claude-history'),
      import('../../core/StateManager'),
    ])

    const sm = new SM(projectPath)
    await sm.initialize()
    const session = await sm.getSession(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Build a map of id → owning branches across ALL Orka sessions in
    // this project so we can flag cross-branch duplicates.
    const allSessions = await sm.getAllSessions()
    const idOwners = new Map<string, Array<{ sessionName: string; branch: string }>>()
    for (const s of allSessions) {
      if (s.main.claudeSessionId) {
        const arr = idOwners.get(s.main.claudeSessionId) || []
        arr.push({ sessionName: s.name, branch: 'main' })
        idOwners.set(s.main.claudeSessionId, arr)
      }
      for (const f of s.forks) {
        if (f.status !== 'active' && f.status !== 'saved') continue
        if (!f.claudeSessionId) continue
        const arr = idOwners.get(f.claudeSessionId) || []
        arr.push({ sessionName: s.name, branch: f.name || f.id })
        idOwners.set(f.claudeSessionId, arr)
      }
    }

    // Index jsonls by id for cwd lookup.
    const jsonls = await listProjectSessions(projectPath)
    const jsonlByCwd = new Map(jsonls.map((e) => [e.sessionId, e.projectPath] as const))

    interface BranchReport {
      branch: 'main' | string
      name: string
      claudeSessionId: string
      status: string
      issues: string[]
      duplicateOwners?: Array<{ sessionName: string; branch: string }>
      recordedCwd?: string
    }

    const branches: BranchReport[] = []
    const push = (b: BranchReport) => branches.push(b)

    const audit = async (branchKey: 'main' | string, name: string, id: string, status: string) => {
      const issues: string[] = []
      let recordedCwd: string | undefined
      let dupOwners: BranchReport['duplicateOwners']

      if (!id) {
        issues.push('missing-id')
      } else {
        const exists = await claudeSessionFileExists(projectPath, id)
        if (!exists) issues.push('missing')
        const cwd = jsonlByCwd.get(id)
        if (cwd) {
          recordedCwd = cwd
          if (cwd !== projectPath) issues.push('mismatched-cwd')
        }
        const owners = idOwners.get(id) || []
        if (owners.length > 1) {
          issues.push('duplicate')
          dupOwners = owners
        }
      }

      push({ branch: branchKey, name, claudeSessionId: id, status, issues, duplicateOwners: dupOwners, recordedCwd })
    }

    await audit('main', session.main.label || 'main', session.main.claudeSessionId, session.main.status || 'active')
    for (const f of session.forks) {
      if (f.status !== 'active' && f.status !== 'saved') continue
      await audit(f.id, f.name, f.claudeSessionId, f.status)
    }

    const healthy = branches.every((b) => b.issues.length === 0)
    res.json({ sessionId, name: session.name, healthy, branches })
  } catch (error: any) {
    logger.error('Failed to verify session:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/branches/:branchId/reset-claude-id?project=<base64-path>
 *
 * Wipe a branch's stored `claudeSessionId` and assign a fresh uuid.
 * The next `resumeSession` will detect no jsonl for the fresh id and
 * fall back to creating a new Claude conversation for that branch
 * (`new-fallback` prompt path, which honors cached `lastContextSummary`).
 * Intended remedy for branches flagged as `duplicate` or `mismatched-cwd`
 * by `/verify`.
 *
 * `branchId` is `'main'` for the session's main branch, or a fork id.
 */
sessionsRouter.post('/:sessionId/branches/:branchId/reset-claude-id', async (req, res) => {
  try {
    const { sessionId, branchId } = req.params
    const encodedPath = req.query.project as string
    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }
    const projectPath = decodeProjectPath(encodedPath)

    const [{ v4: uuidv4 }, { StateManager: SM }] = await Promise.all([
      import('uuid'),
      import('../../core/StateManager'),
    ])
    const sm = new SM(projectPath)
    await sm.initialize()
    const session = await sm.getSession(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    const oldId: string | undefined = branchId === 'main'
      ? session.main.claudeSessionId
      : session.forks.find((f) => f.id === branchId)?.claudeSessionId

    const newId = uuidv4()
    if (branchId === 'main') {
      session.main.claudeSessionId = newId
      session.main.lastContextSummary = undefined
    } else {
      const fork = session.forks.find((f) => f.id === branchId)
      if (!fork) {
        res.status(404).json({ error: `Fork ${branchId} not found` })
        return
      }
      fork.claudeSessionId = newId
      fork.lastContextSummary = undefined
    }
    session.lastActivity = new Date().toISOString()
    await sm.replaceSession(session)

    logger.info(
      `reset-claude-id: ${session.name}/${branchId}: ` +
      `${(oldId || 'none').slice(0, 8)}… → ${newId.slice(0, 8)}… (next resume creates fresh Claude conversation)`
    )
    res.json({ ok: true, oldClaudeSessionId: oldId, newClaudeSessionId: newId })
  } catch (error: any) {
    logger.error('Failed to reset claude id:', error)
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
 * POST /api/sessions/save-all?project=<base64-path>
 * Save a lossless snapshot of every session in the project so it can be
 * resumed later without state drift. Runs syncSessionIds +
 * syncUntrackedPanes + refreshes lastContextSummary for each branch, then
 * persists. Does not stop live processes (unlike detach/close). Registered
 * BEFORE /:sessionId/save so Express matches the literal segment first.
 */
sessionsRouter.post('/save-all', async (req, res) => {
  try {
    const encodedPath = req.query.project as string
    if (!encodedPath) {
      res.status(400).json({ error: 'project query param is required' })
      return
    }

    const projectPath = decodeProjectPath(encodedPath)
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()

    const result = await orka.saveAllSessions()
    res.json(result)
  } catch (error: any) {
    logger.error('Failed to save all sessions:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:sessionId/save?project=<base64-path>
 * Save a lossless snapshot of one session. See `saveSessionSnapshot` for
 * exactly what it refreshes.
 */
sessionsRouter.post('/:sessionId/save', async (req, res) => {
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

    const result = await orka.saveSessionSnapshot(sessionId)
    res.json(result)
  } catch (error: any) {
    logger.error('Failed to save session snapshot:', error)
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
