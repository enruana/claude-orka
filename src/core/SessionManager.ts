import { StateManager } from './StateManager'
import { getGlobalStateManager } from './GlobalStateManager'
import { Session, Fork, SessionFilters, SessionLayout } from '../models'
import {
  TmuxCommands,
  logger,
  claudeSessionFileExists,
  getSessionContextSummary,
  findLatestSessionFromIndex,
  getSessionFileMtime,
  discoverBranchSessions,
} from '../utils'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs-extra'
import { spawn } from 'child_process'
import execa from 'execa'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Module-level throttle for untracked-panes sync. Each API request creates a new
// SessionManager, so this needs to be shared across instances.
const LAST_UNTRACKED_SYNC = new Map<string, number>()
const UNTRACKED_SYNC_INTERVAL_MS = 8000

/**
 * Opciones para inicializar Claude
 */
interface InitOptions {
  type: 'new' | 'resume' | 'fork' | 'continue' | 'new-fallback'
  sessionId?: string // Para new and new-fallback
  resumeSessionId?: string // Para resume y continue
  parentSessionId?: string // Para fork
  forkSessionId?: string // Pre-generated session ID for fork (eliminates detection wait)
  sessionName?: string // Para contexto en el prompt
  forkName?: string // Para forks
  contextSummary?: string // Context summary for enhanced resume prompts
}

/**
 * Opciones para crear una sesión
 */
export interface CreateSessionOptions {
  name?: string
  openTerminal?: boolean
  continueFromClaudeSession?: string // Claude session ID to continue from
}

/**
 * Gestiona sesiones de Claude Code usando tmux
 */
export class SessionManager {
  private stateManager: StateManager
  private projectPath: string

  constructor(projectPath: string) {
    this.projectPath = projectPath
    this.stateManager = new StateManager(projectPath)
  }

  /**
   * Initialize el manager
   */
  async initialize(): Promise<void> {
    await this.stateManager.initialize()
  }

  /**
   * Obtener el state
   */
  async getState() {
    return await this.stateManager.getState()
  }

  // ==========================================
  // SESIONES
  // ==========================================

  /**
   * Crear una nueva sesión de Claude Code
   */
  async createSession(options: CreateSessionOptions = {}): Promise<Session> {
    const { name, openTerminal = true, continueFromClaudeSession } = options

    const sessionId = uuidv4()
    const sessionName = name || `Session-${Date.now()}`
    const tmuxSessionId = `orka-${sessionId}`

    logger.info(`Creating session: ${sessionName}`)
    if (continueFromClaudeSession) {
      logger.info(`Continuing from Claude session: ${continueFromClaudeSession}`)
    }

    // 1. Create tmux session
    await TmuxCommands.createSession(tmuxSessionId, this.projectPath)

    if (openTerminal) {
      await TmuxCommands.openTerminalWindow(tmuxSessionId)
    }

    await sleep(2000)

    // 2. Obtener pane ID
    const paneId = await TmuxCommands.getMainPaneId(tmuxSessionId)
    logger.debug(`Main pane ID: ${paneId}`)

    // 2.5. Set a stable orka label for the main pane
    await TmuxCommands.setPaneLabel(paneId, 'main')

    // 3. Inicializar Claude - nueva sesión o continuar desde existente
    let claudeSessionId: string

    if (continueFromClaudeSession) {
      // Continuar desde sesión de Claude existente
      claudeSessionId = continueFromClaudeSession
      await this.initializeClaude(paneId, {
        type: 'continue',
        resumeSessionId: continueFromClaudeSession,
        sessionName: sessionName,
      })
    } else {
      // Nueva sesión de Claude
      claudeSessionId = uuidv4()
      await this.initializeClaude(paneId, {
        type: 'new',
        sessionId: claudeSessionId,
        sessionName: sessionName,
      })
    }

    // 4. Start ttyd web terminal
    const ttydResult = await this.startTtyd(tmuxSessionId)

    // 5. Crear y guardar session
    const session: Session = {
      id: sessionId,
      name: sessionName,
      tmuxSessionId,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      main: {
        claudeSessionId,
        tmuxPaneId: paneId,
        status: 'active',
      },
      forks: [],
      ttydPort: ttydResult?.port,
      ttydPid: ttydResult?.pid,
    }

    await this.stateManager.addSession(session)
    logger.info(`Session created: ${sessionName} (${sessionId})`)

    return session
  }

  /**
   * Restaurar una sesión guardada
   */
  async resumeSession(sessionId: string, openTerminal = true): Promise<Session> {
    // Refresh stored claudeSessionIds BEFORE we read the session, so any
    // mid-conversation rotations (/clear, /compact, etc.) that happened
    // since the last save are reflected in the `claude --resume <id>`
    // calls below. This is the single most important step for preventing
    // context loss across reboots — see SessionManager.syncSessionIds.
    try {
      await this.syncSessionIds(sessionId)
    } catch (err: any) {
      logger.warn(`[resumeSession] syncSessionIds failed (non-fatal): ${err?.message || err}`)
    }

    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    logger.info(`Resuming session: ${session.name}`)

    const tmuxSessionId = `orka-${sessionId}`

    // Check if tmux session actually exists (regardless of saved status)
    const tmuxExists = await TmuxCommands.sessionExists(tmuxSessionId)

    if (tmuxExists) {
      logger.info(`Tmux session exists, reconnecting...`)

      // Session exists in tmux, just reconnect
      if (openTerminal) {
        await TmuxCommands.openTerminalWindow(tmuxSessionId)
      }

      // Start ttyd if not already running or if process is dead
      let needsNewTtyd = !session.ttydPid
      if (session.ttydPid) {
        // Check if the process is actually running
        try {
          process.kill(session.ttydPid, 0) // Signal 0 just checks if process exists
        } catch {
          // Process is not running
          logger.info(`Previous ttyd process (PID: ${session.ttydPid}) is no longer running`)
          needsNewTtyd = true
        }
      }
      if (needsNewTtyd) {
        const ttydResult = await this.startTtyd(tmuxSessionId)
        if (ttydResult) {
          session.ttydPort = ttydResult.port
          session.ttydPid = ttydResult.pid
        }
      }

      // Update status to active if it was saved
      if (session.status === 'saved') {
        const paneId = await TmuxCommands.getMainPaneId(tmuxSessionId)
        session.main.tmuxPaneId = paneId
        session.main.status = 'active'
        session.status = 'active'
        session.lastActivity = new Date().toISOString()
      }

      // Check and restore active/saved forks that are missing their pane
      const forks = session.forks || []
      const forksToRestore = forks.filter((f) =>
        (f.status === 'active' || f.status === 'saved') && !f.tmuxPaneId
      )
      if (forksToRestore.length > 0) {
        logger.info(`Restoring ${forksToRestore.length} fork pane(s)...`)
        for (const fork of forksToRestore) {
          try {
            await this.resumeFork(sessionId, fork.id)
          } catch (error) {
            logger.warn(`Failed to restore fork ${fork.name}: ${error}`)
          }
        }
      }

      await this.stateManager.replaceSession(session)

      return session
    }

    // Tmux session doesn't exist - need to recover
    logger.info(`Tmux session not found, recovering from Claude session...`)

    // 1. Create new tmux session
    await TmuxCommands.createSession(tmuxSessionId, this.projectPath)

    // 1.5. Re-apply Orka theme (in case it wasn't applied)
    await TmuxCommands.applyOrkaTheme(tmuxSessionId, this.projectPath)

    if (openTerminal) {
      await TmuxCommands.openTerminalWindow(tmuxSessionId)
    }

    await sleep(2000)

    // 2. Get pane ID
    const paneId = await TmuxCommands.getMainPaneId(tmuxSessionId)

    // 2.5. Re-apply the main pane's stable orka label
    await TmuxCommands.setPaneLabel(paneId, session.main.label || 'main')

    // 3. Validate Claude session exists before resuming
    const claudeSessionId = session.main.claudeSessionId
    const sessionFileExists = await claudeSessionFileExists(this.projectPath, claudeSessionId)

    // Get context summary (try live first, fall back to cached)
    let contextSummary = await getSessionContextSummary(this.projectPath, claudeSessionId)
    if (!contextSummary) {
      contextSummary = session.main.lastContextSummary || null
    }

    if (sessionFileExists) {
      // Session file exists - resume normally with enhanced prompt
      logger.info(`Claude session file found, resuming with context...`)
      await this.initializeClaude(paneId, {
        type: 'resume',
        resumeSessionId: claudeSessionId,
        sessionName: session.name,
        contextSummary: contextSummary || undefined,
      })
    } else {
      // Session file missing - try to find latest session for project (e.g. after /clear)
      logger.warn(`Claude session file not found for ${claudeSessionId}`)
      const latestSession = await findLatestSessionFromIndex(this.projectPath, claudeSessionId)

      if (latestSession) {
        // Found a newer session - resume from that instead
        logger.info(`Found newer session ${latestSession.sessionId}, resuming from it...`)
        const latestSummary = latestSession.summary || contextSummary
        session.main.claudeSessionId = latestSession.sessionId
        await this.initializeClaude(paneId, {
          type: 'resume',
          resumeSessionId: latestSession.sessionId,
          sessionName: session.name,
          contextSummary: latestSummary || undefined,
        })
      } else {
        // No session found at all - create fresh with context
        logger.warn(`No Claude session found, creating new session with context recovery...`)
        const newClaudeSessionId = uuidv4()
        session.main.claudeSessionId = newClaudeSessionId
        await this.initializeClaude(paneId, {
          type: 'new-fallback',
          sessionId: newClaudeSessionId,
          sessionName: session.name,
          contextSummary: contextSummary || undefined,
        })
      }
    }

    // 4. Start ttyd web terminal
    const ttydResult = await this.startTtyd(tmuxSessionId)

    // 5. Update session
    session.tmuxSessionId = tmuxSessionId
    session.main.tmuxPaneId = paneId
    session.main.status = 'active'
    session.status = 'active'
    session.lastActivity = new Date().toISOString()
    session.ttydPort = ttydResult?.port
    session.ttydPid = ttydResult?.pid

    await this.stateManager.replaceSession(session)

    // 5. Resume only active or saved forks (not closed or merged)
    const forks = session.forks || []
    const forksToRestore = forks.filter((f) => f.status === 'active' || f.status === 'saved')
    if (forksToRestore.length > 0) {
      logger.info(`Restoring ${forksToRestore.length} fork(s)...`)
      for (const fork of forksToRestore) {
        await this.resumeFork(sessionId, fork.id)
      }
    }

    // 6. Recreate manually-created panes. Content is NOT preserved — we only
    //    restore the pane layout so the user's workspace looks familiar.
    await this.recreateUntrackedPanes(sessionId)

    // 7. Re-apply the saved tmux layout so the window keeps the arrangement
    //    the user chose (grid / columns / rows / main) instead of the
    //    cascade of vertical splits the recreation produces.
    if (session.layout) {
      await TmuxCommands.selectLayout(session.tmuxSessionId, session.layout)
    }

    logger.info(`Session resumed: ${session.name}`)

    return session
  }

  /**
   * Recreate manually-created panes (saved via syncUntrackedPanes on close).
   * Just splits the window for each saved pane and cd's to the saved path.
   * Pane IDs change on recovery — we update the state with new IDs.
   */
  private async recreateUntrackedPanes(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session || !session.untrackedPanes?.length) return

    logger.info(`Recreating ${session.untrackedPanes.length} untracked pane(s)...`)

    const updated: typeof session.untrackedPanes = []
    for (const pane of session.untrackedPanes) {
      try {
        const cwd = pane.currentPath || this.projectPath
        const newPaneId = await TmuxCommands.splitPaneWithCwd(session.tmuxSessionId, cwd, false)
        // Re-apply the saved label so renamed panes survive a resume.
        if (pane.label) {
          await TmuxCommands.setPaneLabel(newPaneId, pane.label)
        }
        updated.push({
          tmuxPaneId: newPaneId,
          currentPath: pane.currentPath,
          currentCommand: pane.currentCommand,
          createdAt: pane.createdAt,
          label: pane.label,
        })
      } catch (err: any) {
        logger.warn(`Failed to recreate untracked pane: ${err.message}`)
      }
    }

    session.untrackedPanes = updated
    await this.stateManager.replaceSession(session)
  }

  /**
   * Detach a session (save state, keep tmux running)
   * Processes continue running in background, can be reattached with resume
   */
  async detachSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    logger.info(`Detaching session: ${session.name}`)

    // 0. Sync manually-created panes so the layout is restored on resume
    await this.syncUntrackedPanes(sessionId)

    // 1. Stop ttyd web terminal
    if (session.ttydPid || session.ttydPort) {
      await this.stopTtyd(session.ttydPid || 0, session.ttydPort)
    }

    // 2. Cache context summaries before detaching
    try {
      const mainSummary = await getSessionContextSummary(this.projectPath, session.main.claudeSessionId)
      if (mainSummary) {
        session.main.lastContextSummary = mainSummary
        logger.debug(`Cached main context summary on detach: "${mainSummary}"`)
      }
    } catch (error) {
      logger.debug(`Could not cache main context summary: ${error}`)
    }

    for (const fork of session.forks) {
      if (fork.status === 'active') {
        try {
          const forkSummary = await getSessionContextSummary(this.projectPath, fork.claudeSessionId)
          if (forkSummary) {
            fork.lastContextSummary = forkSummary
            logger.debug(`Cached fork "${fork.name}" context summary on detach: "${forkSummary}"`)
          }
        } catch (error) {
          logger.debug(`Could not cache fork context summary: ${error}`)
        }
      }
    }

    // 3. Keep tmux session alive (processes continue running)
    // Just clear pane IDs but don't kill anything

    // 4. Update state - mark as saved but keep tmux running
    session.main.status = 'saved'
    session.main.tmuxPaneId = undefined
    session.status = 'saved'
    session.lastActivity = new Date().toISOString()
    session.ttydPort = undefined
    session.ttydPid = undefined

    // Clear fork pane IDs but don't close them
    for (const fork of session.forks) {
      if (fork.status === 'active') {
        fork.tmuxPaneId = undefined
      }
    }

    await this.stateManager.replaceSession(session)
    logger.info(`Session detached: ${session.name} (tmux still running)`)
  }

  /**
   * Close a session (stop everything, kill tmux)
   * All processes are terminated but session remains in state for recovery
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    logger.info(`Closing session: ${session.name}`)

    // 0. Sync manually-created panes so the layout is restored on resume
    await this.syncUntrackedPanes(sessionId)

    // 1. Stop ttyd web terminal
    if (session.ttydPid || session.ttydPort) {
      await this.stopTtyd(session.ttydPid || 0, session.ttydPort)
    }

    // 2. Kill tmux session (this kills all panes and processes)
    if (session.tmuxSessionId) {
      try {
        await TmuxCommands.killSession(session.tmuxSessionId)
        logger.info(`Killed tmux session: ${session.tmuxSessionId}`)
      } catch (error) {
        logger.debug(`Tmux session may already be dead: ${error}`)
      }
    }

    // 3. Cache context summaries before closing
    try {
      const mainSummary = await getSessionContextSummary(this.projectPath, session.main.claudeSessionId)
      if (mainSummary) {
        session.main.lastContextSummary = mainSummary
        logger.debug(`Cached main context summary: "${mainSummary}"`)
      }
    } catch (error) {
      logger.debug(`Could not cache main context summary: ${error}`)
    }

    for (const fork of session.forks) {
      if (fork.status === 'active' || fork.status === 'saved') {
        try {
          const forkSummary = await getSessionContextSummary(this.projectPath, fork.claudeSessionId)
          if (forkSummary) {
            fork.lastContextSummary = forkSummary
            logger.debug(`Cached fork "${fork.name}" context summary: "${forkSummary}"`)
          }
        } catch (error) {
          logger.debug(`Could not cache fork context summary: ${error}`)
        }
      }
    }

    // 4. Update state - mark as saved, clear all pane IDs
    session.main.status = 'saved'
    session.main.tmuxPaneId = undefined
    session.status = 'saved'
    session.lastActivity = new Date().toISOString()
    session.ttydPort = undefined
    session.ttydPid = undefined

    // Mark active forks as saved and clear pane IDs
    for (const fork of session.forks) {
      if (fork.status === 'active') {
        fork.status = 'saved'
        fork.tmuxPaneId = undefined
      }
    }

    await this.stateManager.replaceSession(session)
    logger.info(`Session closed: ${session.name}`)
  }

  /**
   * Eliminar una sesión permanentemente
   */
  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    logger.info(`Deleting session: ${session.name}`)

    // Cerrar si está activa (stops ttyd, closes forks)
    if (session.status === 'active') {
      await this.closeSession(sessionId)
    }

    // Kill tmux session permanently
    if (session.tmuxSessionId) {
      try {
        await TmuxCommands.killSession(session.tmuxSessionId)
        logger.info(`Killed tmux session: ${session.tmuxSessionId}`)
      } catch (error) {
        logger.debug(`Tmux session may already be dead: ${error}`)
      }
    }

    // Eliminar del state
    await this.stateManager.deleteSession(sessionId)
    logger.info(`Session deleted: ${session.name}`)
  }

  /**
   * Listar sesiones con filtros opcionales
   */
  async listSessions(filters?: SessionFilters): Promise<Session[]> {
    const sessions = await this.stateManager.listSessions(filters)
    // Throttled background sync of untracked panes for active sessions, so manually-
    // created tmux panes (e.g. via Ctrl-B " or right-click split) get persisted into
    // state.json without requiring a close/detach. Fire-and-forget — never block list.
    for (const s of sessions) {
      if (s.status === 'active') {
        this.syncUntrackedPanesThrottled(s.id).catch(() => {})
      }
    }
    return sessions
  }

  private async syncUntrackedPanesThrottled(sessionId: string): Promise<void> {
    const now = Date.now()
    const last = LAST_UNTRACKED_SYNC.get(sessionId) || 0
    if (now - last < UNTRACKED_SYNC_INTERVAL_MS) return
    LAST_UNTRACKED_SYNC.set(sessionId, now)
    await this.syncUntrackedPanes(sessionId)
  }

  /**
   * Obtener una sesión por ID
   */
  async getSession(sessionId: string): Promise<Session | null> {
    return await this.stateManager.getSession(sessionId)
  }

  /**
   * Sync session IDs for an Orka session by pairing each branch (main +
   * active forks) with the freshest Claude session JSONL on disk.
   *
   * Why this exists: Claude Code rotates its session id on `/clear`,
   * `/compact`, and a few other internal triggers, but Orka's
   * `claudeSessionId` never gets refreshed unless this runs. After a
   * reboot, `claude --resume <stored-id>` then loads an ancient snapshot
   * and the user perceives this as "lost context".
   *
   * Strategy:
   *  - Build an ordered list of branches to assign: main first, then
   *    forks oldest-first (so the freshest unassigned session goes to
   *    main, the next to the oldest fork, etc — matches the typical
   *    pattern where the user does `/clear` on main most often).
   *  - Hand that list to `discoverBranchSessions` which scans every
   *    `<sessionId>.jsonl` in the project's Claude folder, sorts by
   *    mtime, and matches greedily — preferring to keep a branch's
   *    stored id if it's still the freshest, otherwise promoting the
   *    newest unclaimed session.
   *  - For any branch whose chosen id differs from the stored one,
   *    update state.json and log the rotation.
   *
   * Safe to call repeatedly; idempotent. Replaces the older heuristic
   * that depended on `sessions-index.json`, which Claude Code removed.
   */
  async syncSessionIds(sessionId: string): Promise<{ mainChanged: boolean; forksChanged: string[] } | null> {
    // Project-wide sync: build the branch list from EVERY Orka session in
    // the project and match them in one greedy pass. Ordering by session
    // `lastActivity` (most recent first) ensures the active session
    // claims the freshest jsonls before dormant ones get a chance —
    // critical when many Orka sessions share a project (e.g. MoxiWorks
    // with Execution + Tracking + Learning).
    const allSessions = await this.listSessions()
    if (allSessions.length === 0) return null

    type Entry = {
      session: Session
      branchKey: 'main' | string
      storedId: string
      activitySince: string
      isMain: boolean
    }

    const orderedSessions = [...allSessions].sort(
      (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
    )

    const branchKeys: Array<{ key: string; storedId: string; storedMtime: number | null; activitySince: string }> = []
    const entries: Entry[] = []
    for (const s of orderedSessions) {
      // main first within a session — most rotations happen there
      const mainKey = `${s.id}::main`
      entries.push({ session: s, branchKey: 'main', storedId: s.main.claudeSessionId, activitySince: s.createdAt, isMain: true })
      branchKeys.push({
        key: mainKey,
        storedId: s.main.claudeSessionId,
        storedMtime: await getSessionFileMtime(this.projectPath, s.main.claudeSessionId),
        activitySince: s.createdAt,
      })
      const forks = s.forks
        .filter((f) => f.status === 'active' || f.status === 'saved')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      for (const f of forks) {
        const forkKey = `${s.id}::${f.id}`
        entries.push({ session: s, branchKey: f.id, storedId: f.claudeSessionId, activitySince: f.createdAt, isMain: false })
        branchKeys.push({
          key: forkKey,
          storedId: f.claudeSessionId,
          storedMtime: await getSessionFileMtime(this.projectPath, f.claudeSessionId),
          activitySince: f.createdAt,
        })
      }
    }

    // existingIds is empty here — the pool is the whole project. The
    // matcher uses `branchKeys` directly to know which ids are ours.
    const matches = await discoverBranchSessions(this.projectPath, branchKeys, new Set())

    // Apply matches per-session, saving each session at most once.
    const dirtySessions = new Set<string>()
    let requestedMainChanged = false
    const requestedForksChanged: string[] = []

    for (const e of entries) {
      const key = e.isMain ? `${e.session.id}::main` : `${e.session.id}::${e.branchKey}`
      const m = matches.get(key)
      if (!m || m.sessionId === e.storedId) continue

      if (e.isMain) {
        if (e.session.main.claudeSessionId !== m.sessionId) {
          logger.info(`[syncSessionIds] ${e.session.name} main: ${e.storedId.slice(0, 8)}… → ${m.sessionId.slice(0, 8)}…`)
          e.session.main.claudeSessionId = m.sessionId
          if (m.summary) e.session.main.lastContextSummary = m.summary
          dirtySessions.add(e.session.id)
          if (e.session.id === sessionId) requestedMainChanged = true
        }
      } else {
        const fork = e.session.forks.find((f) => f.id === e.branchKey)
        if (fork && fork.claudeSessionId !== m.sessionId) {
          logger.info(`[syncSessionIds] ${e.session.name} fork "${fork.name}": ${fork.claudeSessionId.slice(0, 8)}… → ${m.sessionId.slice(0, 8)}…`)
          fork.claudeSessionId = m.sessionId
          if (m.summary) fork.lastContextSummary = m.summary
          dirtySessions.add(e.session.id)
          if (e.session.id === sessionId) requestedForksChanged.push(fork.id)
        }
      }
    }

    // Persist each session whose ids we touched.
    for (const sid of dirtySessions) {
      const s = orderedSessions.find((x) => x.id === sid)
      if (!s) continue
      s.lastActivity = new Date().toISOString()
      await this.stateManager.replaceSession(s)
    }

    if (dirtySessions.has(sessionId)) {
      return { mainChanged: requestedMainChanged, forksChanged: requestedForksChanged }
    }
    return null
  }

  // ==========================================
  // FORKS
  // ==========================================

  /**
   * Crear un fork (rama de conversación)
   */
  async createFork(
    sessionId: string,
    name?: string,
    parentId: string = 'main',
    vertical = false
  ): Promise<Fork> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const forkId = uuidv4()
    const forkClaudeSessionId = uuidv4() // Pre-generate the Claude session ID
    const forkName = name || `Fork-${session.forks.length + 1}`

    logger.info(`Creating fork: ${forkName} from parent ${parentId} in session ${session.name}`)

    // Find parent's claudeSessionId
    let parentClaudeSessionId: string
    if (parentId === 'main') {
      parentClaudeSessionId = session.main.claudeSessionId
    } else {
      const parentFork = session.forks.find((f) => f.id === parentId)
      if (!parentFork) {
        throw new Error(`Parent fork ${parentId} not found`)
      }
      parentClaudeSessionId = parentFork.claudeSessionId
    }

    logger.debug(`Parent Claude session ID: ${parentClaudeSessionId}`)
    logger.debug(`Pre-generated fork Claude session ID: ${forkClaudeSessionId}`)

    // 1. Capturar estado actual de panes ANTES del split
    const panesBeforeSplit = await TmuxCommands.listPanes(session.tmuxSessionId)
    logger.debug(`Panes before split: ${panesBeforeSplit.join(', ')}`)

    // 2. Crear split en tmux
    await TmuxCommands.splitPane(session.tmuxSessionId, vertical)
    await sleep(1000)

    // 3. Obtener panes DESPUÉS del split y encontrar el nuevo
    const panesAfterSplit = await TmuxCommands.listPanes(session.tmuxSessionId)
    logger.debug(`Panes after split: ${panesAfterSplit.join(', ')}`)

    // Encontrar el pane nuevo (el que no existía antes)
    const newPanes = panesAfterSplit.filter(pane => !panesBeforeSplit.includes(pane))
    if (newPanes.length === 0) {
      throw new Error('Failed to create new pane - no new pane detected after split')
    }
    const forkPaneId = newPanes[0]
    logger.debug(`Fork pane ID (new pane detected): ${forkPaneId}`)

    // 2.5. Set the fork pane's stable orka label
    await TmuxCommands.setPaneLabel(forkPaneId, forkName)

    // 3. Start Claude fork con session ID pre-generado (no need to detect!)
    await this.initializeClaude(forkPaneId, {
      type: 'fork',
      parentSessionId: parentClaudeSessionId,
      forkSessionId: forkClaudeSessionId,
      forkName: forkName,
    })

    // 4. Crear fork con el ID pre-generado (no waiting for detection!)
    const fork: Fork = {
      id: forkId,
      name: forkName,
      parentId: parentId,
      claudeSessionId: forkClaudeSessionId, // ✅ Pre-generated ID
      tmuxPaneId: forkPaneId,
      status: 'active',
      createdAt: new Date().toISOString(),
    }

    session.forks.push(fork)
    session.lastActivity = new Date().toISOString()
    await this.stateManager.replaceSession(session)

    // Re-apply the chosen layout so the freshly-added pane fits the grid /
    // columns / rows arrangement instead of shrinking the previous split.
    if (session.layout) {
      await TmuxCommands.selectLayout(session.tmuxSessionId, session.layout)
    }

    logger.info(`Fork created: ${forkName} (${forkId}) with Claude session ${forkClaudeSessionId}`)
    return fork
  }

  /**
   * Restaurar un fork guardado
   */
  async resumeFork(sessionId: string, forkId: string): Promise<Fork> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const fork = session.forks.find((f) => f.id === forkId)
    if (!fork) {
      throw new Error(`Fork ${forkId} not found`)
    }

    logger.info(`Resuming fork: ${fork.name}`)

    // Check if fork pane already exists (fork is active)
    if (fork.status === 'active' && fork.tmuxPaneId) {
      try {
        // Verify pane still exists in tmux
        const allPanes = await TmuxCommands.listPanes(session.tmuxSessionId)
        if (allPanes.includes(fork.tmuxPaneId)) {
          logger.info(`Fork pane already exists, no need to resume`)
          return fork
        }
      } catch (error) {
        logger.warn(`Fork was marked active but pane not found, recreating...`)
      }
    }

    // 1. Capturar estado actual de panes ANTES del split
    const panesBeforeSplit = await TmuxCommands.listPanes(session.tmuxSessionId)
    logger.debug(`Panes before split (resume): ${panesBeforeSplit.join(', ')}`)

    // 2. Crear split en tmux
    await TmuxCommands.splitPane(session.tmuxSessionId, false)
    await sleep(1000)

    // 3. Obtener panes DESPUÉS del split y encontrar el nuevo
    const panesAfterSplit = await TmuxCommands.listPanes(session.tmuxSessionId)
    logger.debug(`Panes after split (resume): ${panesAfterSplit.join(', ')}`)

    // Encontrar el pane nuevo (el que no existía antes)
    const newPanes = panesAfterSplit.filter(pane => !panesBeforeSplit.includes(pane))
    if (newPanes.length === 0) {
      throw new Error('Failed to create new pane for fork resume - no new pane detected after split')
    }
    const forkPaneId = newPanes[0]
    logger.debug(`Fork pane ID (resume, new pane detected): ${forkPaneId}`)

    // 4. Re-apply the fork pane's stable orka label
    await TmuxCommands.setPaneLabel(forkPaneId, fork.name)

    // 5. Validate fork session exists before resuming
    const forkSessionExists = await claudeSessionFileExists(this.projectPath, fork.claudeSessionId)

    // Get context summary (try live first, fall back to cached)
    let forkContextSummary = await getSessionContextSummary(this.projectPath, fork.claudeSessionId)
    if (!forkContextSummary) {
      forkContextSummary = fork.lastContextSummary || null
    }

    if (forkSessionExists) {
      // Fork session file exists - resume normally
      await this.initializeClaude(forkPaneId, {
        type: 'resume',
        resumeSessionId: fork.claudeSessionId,
        sessionName: fork.name,
        contextSummary: forkContextSummary || undefined,
      })
    } else {
      // Fork session file missing - re-fork from parent
      logger.warn(`Fork session file not found for ${fork.claudeSessionId}, re-forking from parent...`)

      let parentClaudeSessionId: string
      if (fork.parentId === 'main') {
        parentClaudeSessionId = session.main.claudeSessionId
      } else {
        const parentFork = session.forks.find((f) => f.id === fork.parentId)
        parentClaudeSessionId = parentFork?.claudeSessionId || session.main.claudeSessionId
      }

      // Check if parent session exists
      const parentExists = await claudeSessionFileExists(this.projectPath, parentClaudeSessionId)
      if (parentExists) {
        // Re-fork from parent with new session ID
        const newForkSessionId = uuidv4()
        fork.claudeSessionId = newForkSessionId
        await this.initializeClaude(forkPaneId, {
          type: 'fork',
          parentSessionId: parentClaudeSessionId,
          forkSessionId: newForkSessionId,
          forkName: fork.name,
        })
        logger.info(`Fork re-created from parent with new session ${newForkSessionId}`)
      } else {
        // Parent also missing - create fresh session with context
        logger.warn(`Parent session also missing, creating fresh fork session...`)
        const newForkSessionId = uuidv4()
        fork.claudeSessionId = newForkSessionId
        await this.initializeClaude(forkPaneId, {
          type: 'new-fallback',
          sessionId: newForkSessionId,
          sessionName: fork.name,
          contextSummary: forkContextSummary || undefined,
        })
      }
    }

    // 6. Update fork
    fork.tmuxPaneId = forkPaneId
    fork.status = 'active'

    session.lastActivity = new Date().toISOString()
    await this.stateManager.replaceSession(session)

    logger.info(`Fork resumed: ${fork.name}`)
    return fork
  }

  /**
   * Cerrar un fork
   */
  async closeFork(sessionId: string, forkId: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const fork = session.forks.find((f) => f.id === forkId)
    if (!fork) {
      throw new Error(`Fork ${forkId} not found`)
    }

    logger.info(`Closing fork: ${fork.name}`)

    // Matar el pane de tmux si existe (Claude session persiste)
    if (fork.tmuxPaneId) {
      try {
        await TmuxCommands.killPane(fork.tmuxPaneId)
      } catch (error) {
        // Pane may already be dead, that's fine
        logger.debug(`Pane ${fork.tmuxPaneId} may already be dead: ${error}`)
      }
    }

    // Actualizar estado
    fork.status = 'closed'
    fork.tmuxPaneId = undefined

    session.lastActivity = new Date().toISOString()
    await this.stateManager.replaceSession(session)

    logger.info(`Fork closed: ${fork.name}`)
  }

  /**
   * Eliminar un fork permanentemente
   */
  async deleteFork(sessionId: string, forkId: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const forkIndex = session.forks.findIndex((f) => f.id === forkId)
    if (forkIndex === -1) {
      throw new Error(`Fork ${forkId} not found`)
    }

    const fork = session.forks[forkIndex]
    logger.info(`Deleting fork: ${fork.name}`)

    // Cerrar si está activo
    if (fork.status === 'active') {
      await this.closeFork(sessionId, forkId)
    }

    // Eliminar del array
    session.forks.splice(forkIndex, 1)
    session.lastActivity = new Date().toISOString()
    await this.stateManager.replaceSession(session)

    logger.info(`Fork deleted: ${fork.name}`)
  }

  // ==========================================
  // COMANDOS
  // ==========================================

  /**
   * Enviar comando a main
   */
  async sendToMain(sessionId: string, command: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    if (!session.main.tmuxPaneId) {
      throw new Error('Main pane is not active')
    }

    logger.info(`Sending command to main: ${command}`)
    await TmuxCommands.sendKeys(session.main.tmuxPaneId, command)
    await TmuxCommands.sendEnter(session.main.tmuxPaneId)

    session.lastActivity = new Date().toISOString()
    await this.stateManager.replaceSession(session)
  }

  /**
   * Enviar comando a un fork
   */
  async sendToFork(sessionId: string, forkId: string, command: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const fork = session.forks.find((f) => f.id === forkId)
    if (!fork) {
      throw new Error(`Fork ${forkId} not found`)
    }

    if (!fork.tmuxPaneId) {
      throw new Error('Fork pane is not active')
    }

    logger.info(`Sending command to fork ${fork.name}: ${command}`)
    await TmuxCommands.sendKeys(fork.tmuxPaneId, command)
    await TmuxCommands.sendEnter(fork.tmuxPaneId)

    session.lastActivity = new Date().toISOString()
    await this.stateManager.replaceSession(session)
  }

  // ==========================================
  // EXPORT & MERGE
  // ==========================================

  /**
   * Generar export de un fork con resumen
   * Envía un prompt a Claude pidiendo que genere resumen y exporte
   */
  async generateForkExport(sessionId: string, forkId: string): Promise<string> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const fork = session.forks.find((f) => f.id === forkId)
    if (!fork) {
      throw new Error(`Fork ${forkId} not found`)
    }

    logger.info(`Generating export for fork: ${fork.name}`)

    // Path del export
    const exportsDir = path.join(this.projectPath, '.claude-orka', 'exports')
    await fs.ensureDir(exportsDir)

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const exportName = `fork-${fork.name}-${timestamp}.md`
    const relativeExportPath = `.claude-orka/exports/${exportName}`
    const absoluteExportPath = path.join(this.projectPath, relativeExportPath)

    // Prompt for Claude
    const prompt = `
Please generate a complete summary of this fork conversation "${fork.name}" and save it to the file:
\`${absoluteExportPath}\`

The summary should include:

## Executive Summary
- What was attempted to achieve in this fork
- Why this exploration branch was created

## Changes Made
- Detailed list of changes, modified files, written code
- Technical decisions made

## Results
- What works correctly
- What problems were encountered
- What remains pending

## Recommendations
- Suggested next steps
- How to integrate this to main
- Important considerations

Write the summary in Markdown format and save it to the specified file.
`.trim()

    // Send to Claude
    if (!fork.tmuxPaneId) {
      throw new Error('Fork pane is not active. Cannot send export command.')
    }

    await TmuxCommands.sendKeys(fork.tmuxPaneId, prompt)
    await TmuxCommands.sendEnter(fork.tmuxPaneId)

    // Save path in fork
    fork.contextPath = relativeExportPath
    await this.stateManager.replaceSession(session)

    logger.info(`Export generation requested`)
    logger.info(`  Filename: ${exportName}`)
    logger.info(`  Relative path (saved in state): ${relativeExportPath}`)
    logger.info(`  Absolute path (sent to Claude): ${absoluteExportPath}`)
    logger.warn('IMPORTANT: Wait for Claude to complete before calling merge()')

    return relativeExportPath
  }

  /**
   * Hacer merge de un fork a main
   * PREREQUISITO: Debes llamar a generateForkExport() primero y esperar
   */
  async mergeFork(sessionId: string, forkId: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const fork = session.forks.find((f) => f.id === forkId)
    if (!fork) {
      throw new Error(`Fork ${forkId} not found`)
    }

    if (!fork.contextPath) {
      throw new Error(
        'Fork does not have an exported context. Call generateForkExport() first.'
      )
    }

    // Find parent target for merge
    const parentId = fork.parentId
    const parentName = parentId === 'main' ? 'MAIN' : session.forks.find(f => f.id === parentId)?.name || parentId
    logger.info(`Merging fork ${fork.name} to parent ${parentName}`)

    // Get parent's tmux pane
    let parentTmuxPaneId: string | undefined
    if (parentId === 'main') {
      parentTmuxPaneId = session.main.tmuxPaneId
    } else {
      const parentFork = session.forks.find((f) => f.id === parentId)
      if (!parentFork) {
        throw new Error(`Parent fork ${parentId} not found`)
      }
      parentTmuxPaneId = parentFork.tmuxPaneId
    }

    if (!parentTmuxPaneId) {
      throw new Error(`Parent ${parentName} is not active. Cannot send merge command.`)
    }

    // Verificar que el archivo existe
    let contextPath = fork.contextPath
    let fullPath = path.join(this.projectPath, contextPath)
    let exists = await fs.pathExists(fullPath)

    // Si el archivo específico no existe, buscar el export más reciente
    if (!exists) {
      logger.warn(`Export file not found: ${contextPath}. Looking for most recent export...`)

      const exportsDir = path.join(this.projectPath, '.claude-orka', 'exports')
      const files = await fs.readdir(exportsDir)
      const forkExports = files
        .filter(f => f.startsWith(`fork-${fork.name}-`) && f.endsWith('.md'))
        .sort()
        .reverse()

      if (forkExports.length > 0) {
        contextPath = `.claude-orka/exports/${forkExports[0]}`
        fullPath = path.join(this.projectPath, contextPath)
        exists = await fs.pathExists(fullPath)
        logger.info(`Using most recent export: ${contextPath}`)
      }
    }

    if (!exists) {
      throw new Error(
        `No export file found for fork "${fork.name}". Please run Export first and wait for Claude to complete.`
      )
    }

    // Send merge prompt to parent
    const mergePrompt = `
I have completed work on the fork "${fork.name}".
Please read the file \`${contextPath}\` which contains:
1. An executive summary of the work completed
2. The complete context of the fork conversation

Analyze the content and help me integrate the changes and learnings from the fork into this conversation.
`.trim()

    await TmuxCommands.sendKeys(parentTmuxPaneId, mergePrompt)
    await TmuxCommands.sendEnter(parentTmuxPaneId)

    // Update fork as merged
    fork.status = 'merged'
    fork.mergedToMain = true
    fork.mergedAt = new Date().toISOString()

    // Close fork pane if active
    if (fork.tmuxPaneId) {
      try {
        await TmuxCommands.killPane(fork.tmuxPaneId)
      } catch (error) {
        // Pane may already be dead, that's fine
        logger.debug(`Pane ${fork.tmuxPaneId} may already be dead: ${error}`)
      }
      fork.tmuxPaneId = undefined
    }

    session.lastActivity = new Date().toISOString()
    await this.stateManager.replaceSession(session)

    logger.info(`Fork ${fork.name} merged to main`)
  }

  /**
   * Export manual de un fork (deprecated - usa generateForkExport)
   */
  async exportFork(sessionId: string, forkId: string): Promise<string> {
    logger.warn('exportFork() is deprecated. Use generateForkExport() instead.')
    return await this.generateForkExport(sessionId, forkId)
  }

  // ==========================================
  // UI METHODS
  // ==========================================

  /**
   * Save node position for UI persistence
   * @param sessionId Session ID
   * @param nodeId Node ID ('main' or fork id)
   * @param position Position {x, y}
   */
  async saveNodePosition(sessionId: string, nodeId: string, position: { x: number; y: number }): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    // Initialize nodePositions if not exists
    if (!session.nodePositions) {
      session.nodePositions = {}
    }

    // Save position
    session.nodePositions[nodeId] = position

    await this.stateManager.replaceSession(session)
    logger.debug(`Node position saved: ${nodeId} -> (${position.x}, ${position.y})`)
  }

  /**
   * Select/focus a branch in the tmux session
   * This activates the corresponding pane in tmux
   * @param sessionId Session ID
   * @param branchId Branch ID ('main' or fork id)
   */
  async selectBranch(sessionId: string, branchId: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    let paneId: string | undefined

    if (branchId === 'main') {
      paneId = session.main.tmuxPaneId
      if (!paneId) {
        throw new Error(`Main branch does not have an active pane`)
      }
    } else {
      const fork = session.forks.find((f) => f.id === branchId)
      if (!fork) {
        throw new Error(`Fork ${branchId} not found in session ${sessionId}`)
      }
      if (!fork.tmuxPaneId) {
        throw new Error(`Fork ${branchId} does not have an active pane`)
      }
      paneId = fork.tmuxPaneId
    }

    await TmuxCommands.selectPane(paneId)
    logger.debug(`Branch selected: ${branchId} (pane: ${paneId})`)
  }

  /**
   * Sync manually-created tmux panes into session state.
   * Scans all panes in tmux, filters out known main + forks, and saves any
   * leftover panes into session.untrackedPanes so the layout is recreated on
   * next resume. Safe to call any time; no-op if tmux session is gone.
   */
  async syncUntrackedPanes(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) return

    try {
      const panes = await TmuxCommands.listPanesDetailed(session.tmuxSessionId)
      const knownPaneIds = new Set<string>()
      if (session.main.tmuxPaneId) knownPaneIds.add(session.main.tmuxPaneId)
      for (const fork of session.forks) {
        if (fork.tmuxPaneId) knownPaneIds.add(fork.tmuxPaneId)
      }

      // Backfill @orka_label on the main + fork panes when missing. Panes
      // created before this feature existed (or any that lost the option)
      // get their label restored here without needing a session resume.
      for (const p of panes) {
        if (p.label) continue
        if (p.paneId === session.main.tmuxPaneId) {
          await TmuxCommands.setPaneLabel(p.paneId, session.main.label || 'main')
        } else {
          const fork = session.forks.find((f) => f.tmuxPaneId === p.paneId)
          if (fork) await TmuxCommands.setPaneLabel(p.paneId, fork.name)
        }
      }

      const untracked: NonNullable<typeof session.untrackedPanes> = []
      for (const p of panes.filter((p) => !knownPaneIds.has(p.paneId))) {
        // Preserve createdAt + label if we had this pane before
        const existing = (session.untrackedPanes || []).find(
          (u) => u.tmuxPaneId === p.paneId
        )
        // Label precedence: the live tmux @orka_label wins (it reflects any
        // rename done via the API/UI), then a previously-persisted label,
        // then a default derived from the working directory.
        const defaultLabel = p.currentPath
          ? p.currentPath.split('/').filter(Boolean).pop() || 'shell'
          : 'shell'
        const label = p.label || existing?.label || defaultLabel
        // If tmux doesn't have the label yet, apply it so the pane border
        // shows something meaningful for manually-created panes too.
        if (!p.label && label) {
          await TmuxCommands.setPaneLabel(p.paneId, label)
        }
        untracked.push({
          tmuxPaneId: p.paneId,
          currentPath: p.currentPath,
          currentCommand: p.currentCommand,
          createdAt: existing?.createdAt || new Date().toISOString(),
          label,
        })
      }

      session.untrackedPanes = untracked
      await this.stateManager.replaceSession(session)
      logger.debug(`Synced ${untracked.length} untracked pane(s) for session ${sessionId}`)
    } catch (error: any) {
      // tmux session probably gone — leave any previously-saved untrackedPanes intact
      logger.debug(`syncUntrackedPanes skipped: ${error.message}`)
    }
  }

  /**
   * Rename a tmux pane's label — the `@orka_label` user option rendered in
   * the pane border. Persists the new label to state.json so it survives a
   * session resume: into `main.label`, `fork.name`, or the matching
   * `untrackedPanes` entry, depending on which branch owns the pane.
   *
   * @param sessionId Orka session id
   * @param paneId    tmux pane id (e.g. %3); when omitted the currently
   *                  active pane of the session is used
   * @param label     new label text (trimmed; must be non-empty)
   * @returns the pane id that was relabeled
   */
  async renamePaneLabel(sessionId: string, paneId: string | undefined, label: string): Promise<string> {
    const session = await this.getSession(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    const clean = label.trim()
    if (!clean) throw new Error('Label cannot be empty')

    const targetPane = paneId || await TmuxCommands.getActivePane(session.tmuxSessionId)
    if (!targetPane) throw new Error('Could not resolve a target pane')

    await TmuxCommands.setPaneLabel(targetPane, clean)

    // Persist to whichever branch owns this pane.
    if (session.main.tmuxPaneId === targetPane) {
      session.main.label = clean
    } else {
      const fork = session.forks.find((f) => f.tmuxPaneId === targetPane)
      if (fork) {
        fork.name = clean
      } else {
        const up = (session.untrackedPanes || []).find((u) => u.tmuxPaneId === targetPane)
        if (up) up.label = clean
        // If the pane isn't in state yet (freshly-created untracked pane),
        // the tmux label is still applied; the next syncUntrackedPanes will
        // read it back from @orka_label and persist it.
      }
    }
    await this.stateManager.replaceSession(session)
    logger.info(`Pane ${targetPane} relabeled to "${clean}"`)
    return targetPane
  }

  /**
   * Change a session's tmux pane layout (grid / columns / rows / main) and
   * persist the choice to state.json so it is re-applied on every resume.
   * Applies immediately when the tmux session is running.
   *
   * @param sessionId Orka session id
   * @param layout    one of the SessionLayout values
   */
  async setSessionLayout(sessionId: string, layout: SessionLayout): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    session.layout = layout
    await this.stateManager.replaceSession(session)

    // Apply live if the tmux session exists; harmless no-op otherwise.
    if (await TmuxCommands.sessionExists(session.tmuxSessionId)) {
      await TmuxCommands.selectLayout(session.tmuxSessionId, layout)
    }
    logger.info(`Session ${sessionId} layout set to "${layout}"`)
  }

  /**
   * Get the currently active branch in the tmux session
   * @param sessionId Session ID
   * @returns Branch ID ('main' or fork id) or null if not found
   */
  async getActiveBranch(sessionId: string): Promise<string | null> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    // Get the active pane in tmux
    const activePaneId = await TmuxCommands.getActivePane(session.tmuxSessionId)
    if (!activePaneId) {
      return null
    }

    // Check if it's the main pane
    if (session.main.tmuxPaneId === activePaneId) {
      return 'main'
    }

    // Check forks
    const fork = session.forks.find((f) => f.tmuxPaneId === activePaneId)
    if (fork) {
      return fork.id
    }

    // Manual pane not yet synced — return the raw pane id prefixed so the
    // capture API can still fetch its content. Format: 'untracked:<paneId>'.
    return `untracked:${activePaneId}`
  }

  // ==========================================
  // TTYD WEB TERMINAL
  // ==========================================

  /**
   * Start ttyd web terminal for a tmux session
   * Uses GlobalStateManager to find an available port
   * @returns Object with port and pid, or null if ttyd is not available
   */
  private async startTtyd(tmuxSessionId: string): Promise<{ port: number; pid: number } | null> {
    try {
      // Check if ttyd is available
      await execa('which', ['ttyd'])
    } catch {
      logger.warn('ttyd not found, skipping web terminal')
      return null
    }

    try {
      // Get next available port from GlobalStateManager
      const globalState = await getGlobalStateManager()
      const port = await globalState.getNextTtydPort()

      // Start ttyd in background
      // Note: ttyd -t option format is "key=value"
      const ttydProcess = spawn(
        'ttyd',
        [
          '-W',  // Writable (allow input)
          '-p', port.toString(),
          // Terminal appearance (small font for mobile)
          '-t', 'fontSize=10',
          '-t', 'fontFamily=monospace',
          '-t', 'cursorBlink=true',
          // Keyboard handling
          '-t', 'macOptionIsMeta=true',
          '-t', 'scrollOnUserInput=true',
          'tmux', 'attach', '-t', tmuxSessionId
        ],
        {
          detached: true,
          stdio: 'ignore',
        }
      )

      ttydProcess.unref()

      const pid = ttydProcess.pid
      if (!pid) {
        logger.warn('Failed to get ttyd process ID')
        return null
      }

      logger.info(`Started ttyd web terminal on port ${port} (PID: ${pid})`)
      logger.info(`Access at: http://localhost:${port}`)

      return { port, pid }
    } catch (error) {
      logger.warn(`Failed to start ttyd: ${error}`)
      return null
    }
  }

  /**
   * Stop ttyd web terminal by PID
   */
  private async stopTtyd(pid: number, port?: number): Promise<void> {
    logger.info(`Stopping ttyd (PID: ${pid}, port: ${port})...`)

    // Try to kill by PID using system kill command (more reliable for detached processes)
    try {
      await execa('kill', ['-TERM', pid.toString()])
      logger.info(`Stopped ttyd via kill command (PID: ${pid})`)
      return
    } catch (error) {
      logger.debug(`Could not kill ttyd by PID ${pid}: ${error}`)
    }

    // Fallback: kill by port using lsof
    try {
      const { stdout } = await execa('lsof', ['-t', `-i:${port}`])
      const pids = stdout.trim().split('\n').filter(p => p)
      for (const p of pids) {
        try {
          await execa('kill', ['-TERM', p])
          logger.info(`Stopped ttyd via port lookup (PID: ${p})`)
        } catch (e) {
          // Continue trying other PIDs
        }
      }
    } catch (error) {
      logger.debug(`Could not find ttyd process on port ${port}: ${error}`)
    }
  }

  // ==========================================
  // HELPERS PRIVADOS
  // ==========================================

  /**
   * Initialize Claude en un pane con prompt inicial
   */
  private async initializeClaude(paneId: string, options: InitOptions): Promise<void> {
    const { type, sessionId, resumeSessionId, parentSessionId, forkSessionId, sessionName, forkName, contextSummary } = options

    // 1. cd al proyecto
    await TmuxCommands.sendKeys(paneId, `cd ${this.projectPath}`)
    await TmuxCommands.sendEnter(paneId)
    await sleep(500)

    // 2. Build command based on type
    let command = ''
    // Helper to escape double quotes for shell safety
    const escapeQuotes = (s: string) => s.replace(/"/g, '\\"')

    switch (type) {
      case 'new': {
        const newPrompt = `Hello, this is a new main session called "${escapeQuotes(sessionName || '')}". We are working on the project.`
        command = `claude --session-id ${sessionId} "${newPrompt}"`
        break
      }

      case 'resume': {
        let resumePrompt: string
        if (contextSummary) {
          resumePrompt = `Resuming session "${escapeQuotes(sessionName || '')}". Context from previous work: ${escapeQuotes(contextSummary)}. Please continue where we left off.`
        } else {
          resumePrompt = `Resuming session "${escapeQuotes(sessionName || '')}". Please review CLAUDE.md and continue where we left off.`
        }
        command = `claude --resume ${resumeSessionId} "${resumePrompt}"`
        break
      }

      case 'continue': {
        const continuePrompt = `Continuing previous conversation in Orka session "${escapeQuotes(sessionName || '')}".`
        command = `claude --resume ${resumeSessionId} "${continuePrompt}"`
        break
      }

      case 'fork': {
        const forkPrompt = `This is a fork called "${escapeQuotes(forkName || '')}". Keep in mind we are exploring an alternative to the main conversation.`
        // Use --session-id to pre-set the fork's session ID (eliminates need to detect from history)
        command = `claude --resume ${parentSessionId} --fork-session --session-id ${forkSessionId} "${forkPrompt}"`
        break
      }

      case 'new-fallback': {
        // Session was lost - create fresh with context recovery
        let fallbackPrompt: string
        if (contextSummary) {
          fallbackPrompt = `This is session "${escapeQuotes(sessionName || '')}" being recovered. Previous context: ${escapeQuotes(contextSummary)}. The previous session was lost. Please read CLAUDE.md and continue where we left off.`
        } else {
          fallbackPrompt = `This is session "${escapeQuotes(sessionName || '')}" being recovered. The previous session was lost. Please read CLAUDE.md and let me know how I can help.`
        }
        command = `claude --session-id ${sessionId} "${fallbackPrompt}"`
        break
      }
    }

    logger.info(`Executing: ${command}`)
    await TmuxCommands.sendKeys(paneId, command)
    await TmuxCommands.sendEnter(paneId)

    // 3. Esperar a que Claude inicie (reducido porque ya no detectamos session ID)
    await sleep(2000) // 2 segundos para que Claude inicie
  }
}

// ============================================================
// System Terminal (standalone tmux terminal for dashboard)
// ============================================================

const SYSTEM_TERMINAL_SESSION = 'orka-system-terminal'

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function startSystemTerminal(): Promise<{ port: number }> {
  const globalState = await getGlobalStateManager()
  const existing = globalState.getSystemTerminal()

  // Reuse existing if process is alive
  if (existing && isProcessAlive(existing.ttydPid)) {
    logger.info(`System terminal already running on port ${existing.ttydPort}`)
    return { port: existing.ttydPort }
  }

  // Clean up stale entry if any
  if (existing) {
    logger.info('Cleaning up stale system terminal entry')
    await globalState.clearSystemTerminal()
  }

  // Check ttyd is available
  try {
    await execa('which', ['ttyd'])
  } catch {
    throw new Error('ttyd not found. Run: orka prepare')
  }

  // Create tmux session (or reuse if it exists)
  try {
    await execa('tmux', ['has-session', '-t', SYSTEM_TERMINAL_SESSION])
    logger.info('System tmux session already exists')
  } catch {
    await execa('tmux', ['new-session', '-d', '-s', SYSTEM_TERMINAL_SESSION])
    logger.info('Created system tmux session')
  }

  // Get next available port
  const port = await globalState.getNextTtydPort()

  // Spawn ttyd
  const ttydProcess = spawn(
    'ttyd',
    [
      '-W', '-p', port.toString(),
      '-t', 'fontSize=10',
      '-t', 'fontFamily=monospace',
      '-t', 'cursorBlink=true',
      '-t', 'macOptionIsMeta=true',
      '-t', 'scrollOnUserInput=true',
      'tmux', 'attach', '-t', SYSTEM_TERMINAL_SESSION,
    ],
    { detached: true, stdio: 'ignore' }
  )
  ttydProcess.unref()

  const pid = ttydProcess.pid
  if (!pid) {
    throw new Error('Failed to start ttyd for system terminal')
  }

  await globalState.setSystemTerminal({
    tmuxSessionId: SYSTEM_TERMINAL_SESSION,
    ttydPort: port,
    ttydPid: pid,
  })

  logger.info(`System terminal started on port ${port} (PID: ${pid})`)
  return { port }
}

export async function stopSystemTerminal(): Promise<void> {
  const globalState = await getGlobalStateManager()
  const existing = globalState.getSystemTerminal()

  if (existing) {
    // Kill ttyd
    if (isProcessAlive(existing.ttydPid)) {
      try {
        process.kill(existing.ttydPid, 'SIGTERM')
        logger.info(`Killed system terminal ttyd (PID: ${existing.ttydPid})`)
      } catch (err: any) {
        logger.warn(`Failed to kill ttyd: ${err.message}`)
      }
    }

    // Kill tmux session
    try {
      await execa('tmux', ['kill-session', '-t', SYSTEM_TERMINAL_SESSION])
      logger.info('Killed system tmux session')
    } catch {
      // Session may not exist
    }

    await globalState.clearSystemTerminal()
  }
}
