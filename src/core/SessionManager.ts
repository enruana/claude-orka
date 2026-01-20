import { StateManager } from './StateManager'
import { Session, Fork, SessionFilters } from '../models'
import { TmuxCommands, logger } from '../utils'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import fs from 'fs-extra'
import { spawn } from 'child_process'
import execa from 'execa'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Default port for ttyd web terminal
const TTYD_DEFAULT_PORT = 4444

/**
 * Opciones para inicializar Claude
 */
interface InitOptions {
  type: 'new' | 'resume' | 'fork' | 'continue'
  sessionId?: string // Para new
  resumeSessionId?: string // Para resume y continue
  parentSessionId?: string // Para fork
  forkSessionId?: string // Pre-generated session ID for fork (eliminates detection wait)
  sessionName?: string // Para contexto en el prompt
  forkName?: string // Para forks
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

    // 2.5. Set pane title for main branch
    await TmuxCommands.setPaneTitle(paneId, `🎭 MAIN`)

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

    // Launch UI
    if (openTerminal) {
      await this.launchUI(sessionId)
    }

    return session
  }

  /**
   * Restaurar una sesión guardada
   */
  async resumeSession(sessionId: string, openTerminal = true): Promise<Session> {
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
        await this.launchUI(sessionId)
      }

      // Start ttyd if not already running
      if (!session.ttydPid) {
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

    // 2.5. Set pane title for main branch
    await TmuxCommands.setPaneTitle(paneId, `🎭 MAIN`)

    // 3. Resume Claude session (Claude handles context automatically)
    await this.initializeClaude(paneId, {
      type: 'resume',
      resumeSessionId: session.main.claudeSessionId,
      sessionName: session.name,
    })

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

    logger.info(`Session resumed: ${session.name}`)

    // Launch UI
    if (openTerminal) {
      await this.launchUI(sessionId)
    }

    return session
  }

  /**
   * Close a session (save and kill tmux)
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    logger.info(`Closing session: ${session.name}`)

    // 1. Close all active forks
    const activeForks = session.forks.filter((f) => f.status === 'active')
    for (const fork of activeForks) {
      await this.closeFork(sessionId, fork.id)
    }

    // 2. Stop ttyd web terminal
    if (session.ttydPid || session.ttydPort) {
      await this.stopTtyd(session.ttydPid || 0, session.ttydPort || TTYD_DEFAULT_PORT)
    }

    // 3. Kill tmux session (Claude session persists automatically)
    if (session.tmuxSessionId) {
      await TmuxCommands.killSession(session.tmuxSessionId)
    }

    // 4. Update state
    session.main.status = 'saved'
    session.main.tmuxPaneId = undefined
    session.status = 'saved'
    session.lastActivity = new Date().toISOString()
    session.ttydPort = undefined
    session.ttydPid = undefined

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

    // Cerrar si está activa
    if (session.status === 'active') {
      await this.closeSession(sessionId)
    }

    // Eliminar del state
    await this.stateManager.deleteSession(sessionId)
    logger.info(`Session deleted: ${session.name}`)
  }

  /**
   * Listar sesiones con filtros opcionales
   */
  async listSessions(filters?: SessionFilters): Promise<Session[]> {
    return await this.stateManager.listSessions(filters)
  }

  /**
   * Obtener una sesión por ID
   */
  async getSession(sessionId: string): Promise<Session | null> {
    return await this.stateManager.getSession(sessionId)
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

    // 1. Crear split en tmux
    await TmuxCommands.splitPane(session.tmuxSessionId, vertical)
    await sleep(1000)

    // 2. Obtener nuevo pane ID (último pane creado)
    const allPanes = await TmuxCommands.listPanes(session.tmuxSessionId)
    const forkPaneId = allPanes[allPanes.length - 1]
    logger.debug(`Fork pane ID: ${forkPaneId}`)

    // 2.5. Set pane title to show fork name
    await TmuxCommands.setPaneTitle(forkPaneId, `🔀 ${forkName}`)

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

    // 1. Crear split en tmux
    await TmuxCommands.splitPane(session.tmuxSessionId, false)
    await sleep(1000)

    // 2. Obtener nuevo pane ID
    const allPanes = await TmuxCommands.listPanes(session.tmuxSessionId)
    const forkPaneId = allPanes[allPanes.length - 1]

    // 2.5. Set pane title to show fork name
    await TmuxCommands.setPaneTitle(forkPaneId, `🔀 ${fork.name}`)

    // 3. Restaurar Claude fork session (Claude maneja el contexto)
    await this.initializeClaude(forkPaneId, {
      type: 'resume',
      resumeSessionId: fork.claudeSessionId,
      sessionName: fork.name,
    })

    // 4. Actualizar fork
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
      await TmuxCommands.killPane(fork.tmuxPaneId)
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
      await TmuxCommands.killPane(fork.tmuxPaneId)
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

  // ==========================================
  // TTYD WEB TERMINAL
  // ==========================================

  /**
   * Start ttyd web terminal for a tmux session
   * @returns Object with port and pid, or null if ttyd is not available
   */
  private async startTtyd(tmuxSessionId: string, port: number = TTYD_DEFAULT_PORT): Promise<{ port: number; pid: number } | null> {
    try {
      // Check if ttyd is available
      await execa('which', ['ttyd'])
    } catch {
      logger.warn('ttyd not found, skipping web terminal')
      return null
    }

    try {
      // Check if port is already in use
      try {
        await execa('lsof', ['-i', `:${port}`])
        // Port is in use, try to find the ttyd process for this session
        logger.warn(`Port ${port} is already in use, ttyd may already be running`)
        return null
      } catch {
        // Port is free, continue
      }

      // Start ttyd in background
      const ttydProcess = spawn(
        'ttyd',
        [
          '-W',  // Writable (allow input)
          '-p', port.toString(),
          '-t', 'fontSize=14',
          '-t', 'theme={"background":"#1e1e2e","foreground":"#cdd6f4"}',
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
  private async stopTtyd(pid: number, port: number = TTYD_DEFAULT_PORT): Promise<void> {
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
    const { type, sessionId, resumeSessionId, parentSessionId, forkSessionId, sessionName, forkName } = options

    // 1. cd al proyecto
    await TmuxCommands.sendKeys(paneId, `cd ${this.projectPath}`)
    await TmuxCommands.sendEnter(paneId)
    await sleep(500)

    // 2. Build command based on type
    let command = ''

    switch (type) {
      case 'new':
        const newPrompt = `Hello, this is a new main session called "${sessionName}". We are working on the project.`
        command = `claude --session-id ${sessionId} "${newPrompt}"`
        break

      case 'resume':
        const resumePrompt = `Resuming session "${sessionName}".`
        command = `claude --resume ${resumeSessionId} "${resumePrompt}"`
        break

      case 'continue':
        const continuePrompt = `Continuing previous conversation in Orka session "${sessionName}".`
        command = `claude --resume ${resumeSessionId} "${continuePrompt}"`
        break

      case 'fork':
        const forkPrompt = `This is a fork called "${forkName}". Keep in mind we are exploring an alternative to the main conversation.`
        // Use --session-id to pre-set the fork's session ID (eliminates need to detect from history)
        command = `claude --resume ${parentSessionId} --fork-session --session-id ${forkSessionId} "${forkPrompt}"`
        break
    }

    logger.info(`Executing: ${command}`)
    await TmuxCommands.sendKeys(paneId, command)
    await TmuxCommands.sendEnter(paneId)

    // 3. Esperar a que Claude inicie (reducido porque ya no detectamos session ID)
    await sleep(2000) // 2 segundos para que Claude inicie
  }

  /**
   * Launch Electron UI for a session
   */
  private async launchUI(sessionId: string): Promise<void> {
    try {
      // Try to find electron executable (same method as orka doctor)
      let electronPath: string
      try {
        const result = await execa('which', ['electron'])
        electronPath = result.stdout.trim()
        if (!electronPath) {
          throw new Error('Electron path is empty')
        }
      } catch (error) {
        logger.warn('Electron not found in PATH, skipping UI launch')
        logger.warn('Install Electron with: npm install -g electron')
        return
      }

      // Get the path to the compiled main.js
      // The __dirname varies depending on how the code is executed:
      //
      // 1. Via CLI (bundled with esbuild):
      //    __dirname = /path/to/node_modules/@enruana/claude-orka/dist
      //    We need:    /path/to/node_modules/@enruana/claude-orka/dist/electron/main/main.js
      //    Relative:   ./electron/main/main.js
      //
      // 2. Via SDK (not bundled, TypeScript compiled):
      //    __dirname = /path/to/node_modules/@enruana/claude-orka/dist/src/core
      //    We need:    /path/to/node_modules/@enruana/claude-orka/dist/electron/main/main.js
      //    Relative:   ../../electron/main/main.js
      //
      // 3. Development (from source):
      //    __dirname = /path/to/claude-orka/src/core
      //    We need:    /path/to/claude-orka/dist/electron/main/main.js
      //    Relative:   ../../dist/electron/main/main.js

      const possiblePaths = [
        // Via CLI (bundled): dist -> ./electron/main/main.js
        path.join(__dirname, './electron/main/main.js'),
        // Via SDK: dist/src/core -> ../../electron/main/main.js
        path.join(__dirname, '../../electron/main/main.js'),
        // Development: src/core -> ../../dist/electron/main/main.js
        path.join(__dirname, '../../dist/electron/main/main.js'),
      ]

      let mainPath: string | null = null
      for (const p of possiblePaths) {
        const resolvedPath = path.resolve(p)
        if (fs.existsSync(resolvedPath)) {
          mainPath = resolvedPath
          logger.debug(`Found Electron main.js at: ${resolvedPath}`)
          break
        }
      }

      // Check if the main.js exists
      if (!mainPath) {
        const resolvedPaths = possiblePaths.map(p => path.resolve(p))
        logger.warn(`Electron main.js not found. Tried paths: ${resolvedPaths.join(', ')}`)
        logger.warn(`Current __dirname: ${__dirname}`)
        logger.warn('Skipping UI launch')
        return
      }

      // Launch Electron detached
      const electronProcess = spawn(
        electronPath,
        [mainPath, '--session-id', sessionId, '--project-path', this.projectPath],
        {
          detached: true,
          stdio: 'ignore',
        }
      )

      electronProcess.unref()

      logger.info(`Launched UI for session ${sessionId}`)
    } catch (error) {
      logger.warn(`Failed to launch UI: ${error}`)
      // Don't throw - UI is optional
    }
  }
}
