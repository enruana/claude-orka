import { StateManager } from './StateManager'
import { Session, Fork, SessionFilters } from '../models'
import { TmuxCommands, logger, getExistingSessionIds, detectNewSessionId } from '../utils'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs-extra'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Opciones para inicializar Claude
 */
interface InitOptions {
  type: 'new' | 'resume' | 'fork'
  sessionId?: string // Para new
  resumeSessionId?: string // Para resume
  parentSessionId?: string // Para fork
  sessionName?: string // Para contexto en el prompt
  forkName?: string // Para forks
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
   * Inicializar el manager
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
  async createSession(name?: string, openTerminal = true): Promise<Session> {
    const sessionId = uuidv4()
    const sessionName = name || `Session-${Date.now()}`
    const tmuxSessionId = `orka-${sessionId}`

    logger.info(`Creating session: ${sessionName}`)

    // 1. Crear sesión tmux
    await TmuxCommands.createSession(tmuxSessionId, this.projectPath)

    if (openTerminal) {
      await TmuxCommands.openTerminalWindow(tmuxSessionId)
    }

    await sleep(2000)

    // 2. Obtener pane ID
    const paneId = await TmuxCommands.getMainPaneId(tmuxSessionId)
    logger.debug(`Main pane ID: ${paneId}`)

    // 3. Generar Claude session ID y crear sesión con prompt inicial
    const claudeSessionId = uuidv4()
    await this.initializeClaude(paneId, {
      type: 'new',
      sessionId: claudeSessionId,
      sessionName: sessionName,
    })

    // 4. Crear y guardar session
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
    }

    await this.stateManager.addSession(session)
    logger.info(`Session created: ${sessionName} (${sessionId})`)

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

    // 1. Crear nueva tmux session
    await TmuxCommands.createSession(tmuxSessionId, this.projectPath)

    if (openTerminal) {
      await TmuxCommands.openTerminalWindow(tmuxSessionId)
    }

    await sleep(2000)

    // 2. Obtener pane ID
    const paneId = await TmuxCommands.getMainPaneId(tmuxSessionId)

    // 3. Restaurar Claude session (Claude maneja el contexto automáticamente)
    await this.initializeClaude(paneId, {
      type: 'resume',
      resumeSessionId: session.main.claudeSessionId,
      sessionName: session.name,
    })

    // 4. Actualizar session
    session.tmuxSessionId = tmuxSessionId
    session.main.tmuxPaneId = paneId
    session.main.status = 'active'
    session.status = 'active'
    session.lastActivity = new Date().toISOString()

    await this.stateManager.replaceSession(session)

    // 5. Restaurar forks no mergeados
    const forksToRestore = session.forks.filter((f) => f.status !== 'merged')
    if (forksToRestore.length > 0) {
      logger.info(`Restoring ${forksToRestore.length} fork(s)...`)
      for (const fork of forksToRestore) {
        await this.resumeFork(sessionId, fork.id)
      }
    }

    logger.info(`Session resumed: ${session.name}`)
    return session
  }

  /**
   * Cerrar una sesión (guardar y matar tmux)
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    logger.info(`Closing session: ${session.name}`)

    // 1. Cerrar todos los forks activos
    const activeForks = session.forks.filter((f) => f.status === 'active')
    for (const fork of activeForks) {
      await this.closeFork(sessionId, fork.id)
    }

    // 2. Matar tmux session (Claude session persiste automáticamente)
    if (session.tmuxSessionId) {
      await TmuxCommands.killSession(session.tmuxSessionId)
    }

    // 3. Actualizar state
    session.main.status = 'saved'
    session.main.tmuxPaneId = undefined
    session.status = 'saved'
    session.lastActivity = new Date().toISOString()

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
  async createFork(sessionId: string, name?: string, vertical = false): Promise<Fork> {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const forkId = uuidv4()
    const forkName = name || `Fork-${session.forks.length + 1}`

    logger.info(`Creating fork: ${forkName} in session ${session.name}`)

    // 1. Crear split en tmux
    await TmuxCommands.splitPane(session.tmuxSessionId, vertical)
    await sleep(1000)

    // 2. Obtener nuevo pane ID (último pane creado)
    const allPanes = await TmuxCommands.listPanes(session.tmuxSessionId)
    const forkPaneId = allPanes[allPanes.length - 1]
    logger.debug(`Fork pane ID: ${forkPaneId}`)

    // 3. 🔑 CLAVE: Capturar session IDs ANTES de crear el fork
    const existingIds = await getExistingSessionIds()
    logger.debug(`Existing sessions before fork: ${existingIds.size}`)

    // 4. Iniciar Claude fork con prompt inicial
    await this.initializeClaude(forkPaneId, {
      type: 'fork',
      parentSessionId: session.main.claudeSessionId,
      forkName: forkName,
    })

    // 5. 🔍 Detectar el fork session ID del history
    logger.info('Detecting fork session ID from history...')
    const detectedForkId = await detectNewSessionId(existingIds, 30000, 500)

    if (!detectedForkId) {
      throw new Error(
        'Failed to detect fork session ID. Fork may not have been created. Check if the parent session is valid.'
      )
    }

    logger.info(`Fork session ID detected: ${detectedForkId}`)

    // 6. Crear fork con el ID detectado
    const fork: Fork = {
      id: forkId,
      name: forkName,
      claudeSessionId: detectedForkId, // ✅ ID real detectado
      tmuxPaneId: forkPaneId,
      status: 'active',
      createdAt: new Date().toISOString(),
    }

    session.forks.push(fork)
    session.lastActivity = new Date().toISOString()
    await this.stateManager.replaceSession(session)

    logger.info(`Fork created: ${forkName} (${forkId})`)
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

    // 1. Crear split en tmux
    await TmuxCommands.splitPane(session.tmuxSessionId, false)
    await sleep(1000)

    // 2. Obtener nuevo pane ID
    const allPanes = await TmuxCommands.listPanes(session.tmuxSessionId)
    const forkPaneId = allPanes[allPanes.length - 1]

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
    fork.status = 'saved'
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

    // Prompt para Claude
    const prompt = `
Por favor, genera un resumen completo de esta conversación del fork "${fork.name}" y guárdalo en el archivo:
\`${relativeExportPath}\`

El resumen debe incluir:

## Resumen Ejecutivo
- Qué se intentó lograr en este fork
- Por qué se creó esta rama de exploración

## Cambios Realizados
- Lista detallada de cambios, archivos modificados, código escrito
- Decisiones técnicas tomadas

## Resultados
- Qué funciona correctamente
- Qué problemas se encontraron
- Qué quedó pendiente

## Recomendaciones
- Próximos pasos sugeridos
- Cómo integrar esto al main
- Consideraciones importantes

Escribe el resumen en formato Markdown y guárdalo en el archivo especificado.
`.trim()

    // Enviar a Claude
    if (!fork.tmuxPaneId) {
      throw new Error('Fork pane is not active. Cannot send export command.')
    }

    await TmuxCommands.sendKeys(fork.tmuxPaneId, prompt)
    await TmuxCommands.sendEnter(fork.tmuxPaneId)

    // Guardar path en fork
    fork.contextPath = relativeExportPath
    await this.stateManager.replaceSession(session)

    logger.info(`Export generation requested. Path: ${relativeExportPath}`)
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

    logger.info(`Merging fork ${fork.name} to main`)

    // Verificar que el archivo existe
    const fullPath = path.join(this.projectPath, fork.contextPath)
    const exists = await fs.pathExists(fullPath)

    if (!exists) {
      throw new Error(
        `Export file not found: ${fork.contextPath}. Make sure generateForkExport() completed.`
      )
    }

    // Enviar prompt de merge a main
    const mergePrompt = `
He completado trabajo en el fork "${fork.name}".
Por favor, lee el archivo \`${fork.contextPath}\` que contiene:
1. Un resumen ejecutivo del trabajo realizado
2. El contexto completo de la conversación del fork

Analiza el contenido y ayúdame a integrar los cambios y aprendizajes del fork a esta conversación principal.
`.trim()

    if (!session.main.tmuxPaneId) {
      throw new Error('Main pane is not active. Cannot send merge command.')
    }

    await TmuxCommands.sendKeys(session.main.tmuxPaneId, mergePrompt)
    await TmuxCommands.sendEnter(session.main.tmuxPaneId)

    // Actualizar fork como merged
    fork.status = 'merged'
    fork.mergedToMain = true
    fork.mergedAt = new Date().toISOString()

    // Cerrar el pane del fork si está activo
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
  // HELPERS PRIVADOS
  // ==========================================

  /**
   * Inicializar Claude en un pane con prompt inicial
   */
  private async initializeClaude(paneId: string, options: InitOptions): Promise<void> {
    const { type, sessionId, resumeSessionId, parentSessionId, sessionName, forkName } = options

    // 1. cd al proyecto
    await TmuxCommands.sendKeys(paneId, `cd ${this.projectPath}`)
    await TmuxCommands.sendEnter(paneId)
    await sleep(500)

    // 2. Construir comando según tipo
    let command = ''

    switch (type) {
      case 'new':
        const newPrompt = `Hola, esta es una nueva sesión main llamada "${sessionName}". Estamos trabajando en el proyecto.`
        command = `claude --session-id ${sessionId} "${newPrompt}"`
        break

      case 'resume':
        const resumePrompt = `Continuando sesión "${sessionName}".`
        command = `claude --resume ${resumeSessionId} "${resumePrompt}"`
        break

      case 'fork':
        const forkPrompt = `Este es un fork llamado "${forkName}". Ten en cuenta que estamos explorando una alternativa a la conversación principal.`
        command = `claude --resume ${parentSessionId} --fork-session "${forkPrompt}"`
        break
    }

    logger.info(`Executing: ${command}`)
    await TmuxCommands.sendKeys(paneId, command)
    await TmuxCommands.sendEnter(paneId)

    // 3. Esperar a que Claude inicie y procese el prompt
    await sleep(8000) // 8 segundos para que Claude inicie y registre la sesión
  }
}
