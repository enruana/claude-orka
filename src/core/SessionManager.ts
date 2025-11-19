import { nanoid } from 'nanoid'
import * as path from 'path'
import * as fs from 'fs-extra'
import { Session, Fork, SessionFilters, ProjectState } from '../models'
import { StateManager } from './StateManager'
import { TmuxCommands, logger } from '../utils'

/**
 * Opciones para inicializar Claude
 */
interface InitOptions {
  isFork?: boolean
  forkName?: string
  loadContext?: boolean
  contextPath?: string
}

/**
 * Helper para esperar (sleep)
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Gestiona sesiones, forks, comandos y contextos
 */
export class SessionManager {
  private stateManager: StateManager
  private projectPath: string

  constructor(projectPath: string) {
    this.projectPath = path.resolve(projectPath)
    this.stateManager = new StateManager(this.projectPath)
  }

  /**
   * Inicializar el SessionManager
   */
  async initialize(): Promise<void> {
    logger.info('Initializing SessionManager')
    await this.stateManager.initialize()
  }

  // --- SESIONES ---

  /**
   * Crear una nueva sesión
   * @param name Nombre opcional de la sesión
   * @param openTerminal Si debe abrir una ventana de terminal (default: true)
   */
  async createSession(name?: string, openTerminal: boolean = true): Promise<Session> {
    logger.info('Creating new session')

    // Verificar tmux disponible
    if (!(await TmuxCommands.isAvailable())) {
      throw new Error('tmux is not available. Please install tmux first.')
    }

    // Generar IDs
    const sessionId = `session-${nanoid(8)}`
    const tmuxName = `orchestrator-${sessionId}`
    const sessionName = name || `session-${Date.now()}`

    logger.debug(`Session ID: ${sessionId}, tmux name: ${tmuxName}`)

    // Crear sesión tmux en modo detached
    await TmuxCommands.createSession(tmuxName, this.projectPath)

    // Obtener pane IDs
    const paneId = await TmuxCommands.getMainPaneId(tmuxName)
    const windowId = await TmuxCommands.getMainWindowId(tmuxName)

    // Inicializar Claude en el pane
    await this.initializeClaude(paneId, { isFork: false })

    // Abrir ventana de terminal si se solicita
    if (openTerminal) {
      logger.info('Opening terminal window for session...')
      try {
        await TmuxCommands.openTerminalWindow(tmuxName)
      } catch (error: any) {
        logger.warn(`Failed to open terminal window: ${error.message}`)
        logger.info(`You can manually attach with: tmux attach -t ${tmuxName}`)
      }
    }

    // Crear objeto Session
    const session: Session = {
      id: sessionId,
      name: sessionName,
      tmuxSessionName: tmuxName,
      projectPath: this.projectPath,
      createdAt: new Date().toISOString(),
      status: 'active',
      main: {
        tmuxPaneId: paneId,
        tmuxWindowId: windowId,
        lastActivity: new Date().toISOString(),
      },
      forks: [],
      lastActivity: new Date().toISOString(),
    }

    // Guardar en estado
    await this.stateManager.addSession(session)

    logger.info(`Session created: ${sessionId}`)
    return session
  }

  /**
   * Restaurar una sesión guardada
   * @param sessionId ID de la sesión
   * @param openTerminal Si debe abrir una ventana de terminal (default: true)
   */
  async resumeSession(sessionId: string, openTerminal: boolean = true): Promise<Session> {
    logger.info(`Resuming session: ${sessionId}`)

    const session = await this.stateManager.getSession(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    if (session.status === 'active') {
      // Verificar si realmente existe en tmux
      const exists = await TmuxCommands.sessionExists(session.tmuxSessionName)
      if (exists) {
        logger.info('Session already active')
        // Abrir terminal si se solicita
        if (openTerminal) {
          try {
            await TmuxCommands.openTerminalWindow(session.tmuxSessionName)
          } catch (error: any) {
            logger.warn(`Failed to open terminal window: ${error.message}`)
          }
        }
        return session
      } else {
        logger.warn('Session marked as active but tmux session not found, recreating...')
      }
    }

    // Crear nueva sesión tmux
    await TmuxCommands.createSession(session.tmuxSessionName, this.projectPath)

    // Obtener pane IDs
    const paneId = await TmuxCommands.getMainPaneId(session.tmuxSessionName)
    const windowId = await TmuxCommands.getMainWindowId(session.tmuxSessionName)

    // Inicializar Claude con contexto previo si existe
    await this.initializeClaude(paneId, {
      isFork: false,
      loadContext: !!session.main.contextPath,
      contextPath: session.main.contextPath,
    })

    // Abrir ventana de terminal si se solicita
    if (openTerminal) {
      logger.info('Opening terminal window for resumed session...')
      try {
        await TmuxCommands.openTerminalWindow(session.tmuxSessionName)
      } catch (error: any) {
        logger.warn(`Failed to open terminal window: ${error.message}`)
        logger.info(`You can manually attach with: tmux attach -t ${session.tmuxSessionName}`)
      }
    }

    // Actualizar sesión
    await this.stateManager.updateSession(sessionId, {
      status: 'active',
      main: {
        ...session.main,
        tmuxPaneId: paneId,
        tmuxWindowId: windowId,
        lastActivity: new Date().toISOString(),
      },
    })

    const updatedSession = await this.stateManager.getSession(sessionId)
    logger.info(`Session resumed: ${sessionId}`)
    return updatedSession!
  }

  /**
   * Obtener una sesión
   */
  async getSession(sessionId: string): Promise<Session | null> {
    return await this.stateManager.getSession(sessionId)
  }

  /**
   * Listar sesiones
   */
  async listSessions(filters?: SessionFilters): Promise<Session[]> {
    return await this.stateManager.getAllSessions(filters)
  }

  /**
   * Obtener el estado completo del proyecto
   */
  async getState(): Promise<ProjectState> {
    return await this.stateManager.read()
  }

  /**
   * Cerrar una sesión (con auto-export opcional)
   */
  async closeSession(sessionId: string, saveContext: boolean = true): Promise<void> {
    logger.info(`Closing session: ${sessionId}`)

    const session = await this.stateManager.getSession(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    if (session.status === 'active') {
      // Exportar contexto si se solicita
      if (saveContext && session.main.tmuxPaneId) {
        logger.info('Exporting main context before closing...')
        const contextPath = this.stateManager.getSessionContextPath(sessionId)
        try {
          await this.exportContext(session.main.tmuxPaneId, contextPath)
        } catch (error: any) {
          logger.warn(`Failed to export context: ${error.message}`)
        }
      }

      // Cerrar todos los forks activos
      for (const fork of session.forks.filter(f => f.status === 'active')) {
        await this.closeFork(sessionId, fork.id, saveContext)
      }

      // Cerrar sesión tmux
      try {
        await TmuxCommands.killSession(session.tmuxSessionName)
      } catch (error: any) {
        logger.warn(`Failed to kill tmux session: ${error.message}`)
      }

      // Actualizar estado
      await this.stateManager.updateSession(sessionId, {
        status: 'saved',
        main: {
          ...session.main,
          tmuxPaneId: undefined,
          tmuxWindowId: undefined,
          contextPath: saveContext ? this.stateManager.getSessionContextPath(sessionId) : session.main.contextPath,
        },
      })
    }

    logger.info(`Session closed: ${sessionId}`)
  }

  /**
   * Eliminar una sesión permanentemente
   */
  async deleteSession(sessionId: string): Promise<void> {
    logger.info(`Deleting session: ${sessionId}`)

    const session = await this.stateManager.getSession(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // Si está activa, cerrarla primero (sin guardar contexto)
    if (session.status === 'active') {
      await this.closeSession(sessionId, false)
    }

    // Eliminar del estado
    await this.stateManager.deleteSession(sessionId)

    logger.info(`Session deleted: ${sessionId}`)
  }

  // --- FORKS ---

  /**
   * Crear un fork
   */
  async createFork(sessionId: string, name?: string, vertical: boolean = false): Promise<Fork> {
    logger.info(`Creating fork in session: ${sessionId}`)

    const session = await this.stateManager.getSession(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    if (session.status !== 'active') {
      throw new Error('Cannot create fork in inactive session')
    }

    // Generar IDs
    const forkId = name ? `fork-${name}-${nanoid(8)}` : `fork-${nanoid(8)}`
    const forkName = name || `fork-${Date.now()}`

    logger.debug(`Fork ID: ${forkId}, name: ${forkName}`)

    // Split pane
    const paneId = await TmuxCommands.splitPane(session.tmuxSessionName, vertical)

    // Inicializar Claude en el fork
    await this.initializeClaude(paneId, {
      isFork: true,
      forkName: forkName,
    })

    // Crear objeto Fork
    const fork: Fork = {
      id: forkId,
      name: forkName,
      tmuxPaneId: paneId,
      parentId: 'main',
      createdAt: new Date().toISOString(),
      status: 'active',
      lastActivity: new Date().toISOString(),
    }

    // Guardar en estado
    await this.stateManager.addFork(sessionId, fork)

    logger.info(`Fork created: ${forkId}`)
    return fork
  }

  /**
   * Restaurar un fork guardado
   */
  async resumeFork(sessionId: string, forkId: string): Promise<Fork> {
    logger.info(`Resuming fork: ${forkId}`)

    const session = await this.stateManager.getSession(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    if (session.status !== 'active') {
      throw new Error('Cannot resume fork in inactive session')
    }

    const fork = session.forks.find(f => f.id === forkId)
    if (!fork) {
      throw new Error(`Fork not found: ${forkId}`)
    }

    if (fork.status === 'active') {
      logger.info('Fork already active')
      return fork
    }

    // Split pane
    const paneId = await TmuxCommands.splitPane(session.tmuxSessionName)

    // Inicializar Claude con contexto
    await this.initializeClaude(paneId, {
      isFork: true,
      forkName: fork.name,
      loadContext: !!fork.contextPath,
      contextPath: fork.contextPath,
    })

    // Actualizar fork
    await this.stateManager.updateFork(sessionId, forkId, {
      tmuxPaneId: paneId,
      status: 'active',
    })

    const updatedFork = await this.stateManager.getFork(sessionId, forkId)
    logger.info(`Fork resumed: ${forkId}`)
    return updatedFork!
  }

  /**
   * Cerrar un fork (con auto-export opcional)
   */
  async closeFork(sessionId: string, forkId: string, saveContext: boolean = true): Promise<void> {
    logger.info(`Closing fork: ${forkId}`)

    const fork = await this.stateManager.getFork(sessionId, forkId)
    if (!fork) {
      throw new Error(`Fork not found: ${forkId}`)
    }

    if (fork.status === 'active' && fork.tmuxPaneId) {
      // Exportar contexto si se solicita
      if (saveContext) {
        logger.info('Exporting fork context before closing...')
        const contextPath = this.stateManager.getForkContextPath(forkId)
        try {
          await this.exportContext(fork.tmuxPaneId, contextPath)
        } catch (error: any) {
          logger.warn(`Failed to export fork context: ${error.message}`)
        }
      }

      // Cerrar pane
      try {
        await TmuxCommands.killPane(fork.tmuxPaneId)
      } catch (error: any) {
        logger.warn(`Failed to kill pane: ${error.message}`)
      }

      // Actualizar fork
      await this.stateManager.updateFork(sessionId, forkId, {
        tmuxPaneId: undefined,
        status: 'saved',
        contextPath: saveContext ? this.stateManager.getForkContextPath(forkId) : fork.contextPath,
      })
    }

    logger.info(`Fork closed: ${forkId}`)
  }

  /**
   * Eliminar un fork permanentemente
   */
  async deleteFork(sessionId: string, forkId: string): Promise<void> {
    logger.info(`Deleting fork: ${forkId}`)

    const fork = await this.stateManager.getFork(sessionId, forkId)
    if (!fork) {
      throw new Error(`Fork not found: ${forkId}`)
    }

    // Si el fork está activo, cerrarlo primero
    if (fork.status === 'active' && fork.tmuxPaneId) {
      try {
        await TmuxCommands.killPane(fork.tmuxPaneId)
      } catch (error: any) {
        logger.warn(`Failed to kill pane: ${error.message}`)
      }
    }

    // Eliminar del state
    await this.stateManager.deleteFork(sessionId, forkId)

    logger.info(`Fork deleted: ${forkId}`)
  }

  // --- COMANDOS ---

  /**
   * Enviar comando a main
   */
  async sendToMain(sessionId: string, command: string): Promise<void> {
    logger.info(`Sending command to main in session: ${sessionId}`)

    const session = await this.stateManager.getSession(sessionId)
    if (!session || session.status !== 'active' || !session.main.tmuxPaneId) {
      throw new Error('Session is not active')
    }

    await TmuxCommands.sendKeys(session.main.tmuxPaneId, command)
    await TmuxCommands.sendEnter(session.main.tmuxPaneId)

    logger.debug('Command sent to main')
  }

  /**
   * Enviar comando a fork
   */
  async sendToFork(sessionId: string, forkId: string, command: string): Promise<void> {
    logger.info(`Sending command to fork: ${forkId}`)

    const fork = await this.stateManager.getFork(sessionId, forkId)
    if (!fork || fork.status !== 'active' || !fork.tmuxPaneId) {
      throw new Error('Fork is not active')
    }

    await TmuxCommands.sendKeys(fork.tmuxPaneId, command)
    await TmuxCommands.sendEnter(fork.tmuxPaneId)

    logger.debug('Command sent to fork')
  }

  // --- EXPORT & MERGE ---

  /**
   * Exportar un fork manualmente
   */
  async exportFork(sessionId: string, forkId: string, customName?: string): Promise<string> {
    logger.info(`Exporting fork: ${forkId}`)

    const fork = await this.stateManager.getFork(sessionId, forkId)
    if (!fork) {
      throw new Error(`Fork not found: ${forkId}`)
    }

    if (fork.status !== 'active' || !fork.tmuxPaneId) {
      throw new Error('Fork is not active')
    }

    const exportPath = customName
      ? this.stateManager.getExportPath(forkId, customName)
      : this.stateManager.getForkContextPath(forkId)

    await this.exportContext(fork.tmuxPaneId, exportPath)

    // Actualizar fork con el path del export
    await this.stateManager.updateForkContext(sessionId, forkId, exportPath)

    logger.info(`Fork exported: ${exportPath}`)
    return exportPath
  }

  /**
   * Generar export de un fork para merge
   *
   * Envía un prompt a Claude pidiendo que cree un archivo de contexto
   * con un RESUMEN ejecutivo del fork usando sus herramientas (Write)
   * Este resumen será usado para hacer merge a la rama principal
   */
  async generateForkExport(sessionId: string, forkId: string): Promise<string> {
    logger.info(`Generating fork export for merge: ${forkId}`)

    const fork = await this.stateManager.getFork(sessionId, forkId)
    if (!fork) {
      throw new Error(`Fork not found: ${forkId}`)
    }

    if (fork.status !== 'active' || !fork.tmuxPaneId) {
      throw new Error('Fork must be active to generate export')
    }

    const contextPath = this.stateManager.getForkContextPath(forkId)

    // Enviar prompt a Claude para que genere el resumen y cree el archivo
    const exportPrompt = `Por favor ejecuta la siguiente tarea:

Crea un archivo de contexto en la ruta \`${contextPath}\` que incluya todo lo relevante de esta conversación de fork con la intención de ser usado como contexto para hacer un merge de la conversación en la rama principal.

El archivo debe incluir:
1. **Objetivo del fork**: ¿Qué se estaba explorando o evaluando?
2. **Desarrollo**: ¿Qué pasos se siguieron?
3. **Hallazgos clave**: ¿Qué descubriste o lograste?
4. **Resultados**: ¿Cuál fue el resultado final?
5. **Recomendaciones para main**: ¿Qué debería hacerse en la rama principal con esta información?

El contexto debe ser auto-contenido para que la rama principal entienda todo sin necesidad de ver esta conversación. Sé conciso pero completo.`

    logger.debug('Sending fork summary prompt to Claude...')
    await TmuxCommands.sendKeys(fork.tmuxPaneId, exportPrompt)
    await TmuxCommands.sendEnter(fork.tmuxPaneId)

    logger.info(`Fork export generation requested. Claude will create summary at: ${contextPath}`)

    // Actualizar el fork con la ruta del contexto
    await this.stateManager.updateFork(sessionId, forkId, {
      contextPath: contextPath,
    })

    return contextPath
  }

  /**
   * Hacer merge de un fork a main
   *
   * PREREQUISITO: Debes llamar a generateForkExport() primero y esperar a que Claude complete
   *
   * Proceso:
   * 1. Verificar que el export del fork existe
   * 2. Cerrar el pane del fork
   * 3. Enviar prompt al main pidiendo que LEA el archivo y dé un brevísimo summary
   * 4. Marcar como merged
   */
  async mergeFork(sessionId: string, forkId: string): Promise<void> {
    logger.info(`Merging fork ${forkId} to main`)

    const session = await this.stateManager.getSession(sessionId)
    if (!session || session.status !== 'active' || !session.main.tmuxPaneId) {
      throw new Error('Session is not active')
    }

    const fork = await this.stateManager.getFork(sessionId, forkId)
    if (!fork) {
      throw new Error(`Fork not found: ${forkId}`)
    }

    if (!fork.contextPath) {
      throw new Error('Fork has no export. Call generateForkExport() first and wait for Claude to complete.')
    }

    // 1. Verificar que el archivo exportado existe
    const fullPath = path.join(this.projectPath, fork.contextPath)
    const exists = await fs.pathExists(fullPath)
    if (!exists) {
      throw new Error(`Fork export not found at: ${fork.contextPath}. Make sure Claude completed the export.`)
    }

    logger.debug(`Fork export verified at: ${fork.contextPath}`)

    // 2. Cerrar el fork si está activo
    if (fork.status === 'active' && fork.tmuxPaneId) {
      logger.info('Closing fork pane...')
      await TmuxCommands.killPane(fork.tmuxPaneId)
    }

    // 3. Enviar prompt al main para que Claude lea el archivo y resuma
    logger.info('Sending merge prompt to main...')
    const mergePrompt = `📋 MERGE desde fork "${fork.name}":

Por favor lee el contenido del archivo \`${fork.contextPath}\` que tiene el resultado de la experimentación en esa rama, y da un brevísimo summary de lo que dice.`

    await TmuxCommands.sendKeys(session.main.tmuxPaneId, mergePrompt)
    await TmuxCommands.sendEnter(session.main.tmuxPaneId)

    // 4. Marcar fork como merged
    await this.stateManager.updateFork(sessionId, forkId, {
      status: 'merged',
      mergedToMain: true,
      mergedAt: new Date().toISOString(),
      tmuxPaneId: undefined,
    })

    logger.info(`Fork ${forkId} merged successfully to main`)
  }

  // --- HELPERS PRIVADOS ---

  /**
   * Exportar contexto COMPLETO usando /export con clipboard
   * Este método captura TODA la conversación tal cual para restaurarla después
   * Se usa al cerrar sesiones/forks para guardar el estado completo
   */
  private async exportContext(paneId: string, outputPath: string): Promise<void> {
    logger.debug(`Exporting context from pane ${paneId} to ${outputPath}`)

    const fullPath = path.join(this.projectPath, outputPath)

    // Asegurar que el directorio existe
    await fs.ensureDir(path.dirname(fullPath))

    // 1. Limpiar clipboard primero (macOS)
    try {
      const execa = (await import('execa')).default
      await execa('pbcopy', { input: '' })
      logger.debug('Clipboard cleared')
    } catch (error: any) {
      logger.warn(`Failed to clear clipboard: ${error.message}`)
    }

    await sleep(500)

    // 2. Enviar comando /export
    logger.debug('Sending /export command to Claude...')
    await TmuxCommands.sendKeys(paneId, '/export')
    await TmuxCommands.sendEnter(paneId)

    // 3. Esperar a que aparezca el selector
    logger.debug('Waiting for export menu to appear...')
    await sleep(1500)

    // 4. Confirmar opción 1 (copy to clipboard) con Enter
    logger.debug('Confirming "copy to clipboard" option...')
    await TmuxCommands.sendEnter(paneId)

    // 5. Esperar a que Claude genere el export y copie al clipboard
    logger.debug('Waiting for Claude to copy to clipboard...')
    await sleep(5000)

    // 6. Leer del clipboard y guardar
    try {
      const execa = (await import('execa')).default
      const result = await execa('pbpaste')
      const clipboardContent = result.stdout

      if (!clipboardContent || clipboardContent.length < 100) {
        // Reintentar con más tiempo
        logger.debug('Clipboard content too small, retrying...')
        await sleep(3000)
        const retryResult = await execa('pbpaste')
        const retryContent = retryResult.stdout

        if (!retryContent || retryContent.length < 100) {
          throw new Error(`Clipboard content too small: ${retryContent?.length || 0} bytes`)
        }

        await fs.writeFile(fullPath, retryContent, 'utf-8')
        logger.info(`Context exported successfully to: ${outputPath} (${retryContent.length} bytes)`)
      } else {
        await fs.writeFile(fullPath, clipboardContent, 'utf-8')
        logger.info(`Context exported successfully to: ${outputPath} (${clipboardContent.length} bytes)`)
      }
    } catch (error: any) {
      logger.error(`Failed to export from clipboard: ${error.message}`)
      throw new Error(`Export verification failed: ${error.message}`)
    }
  }

  /**
   * Cargar contexto en un pane
   */
  private async loadContext(paneId: string, contextPath: string): Promise<void> {
    logger.debug(`Loading context from ${contextPath} into pane ${paneId}`)

    // Leer el contenido del contexto
    const content = await this.stateManager.readContext(contextPath)

    // Enviar el contexto a Claude
    const prompt = `Restaurando contexto de sesión anterior:\n\n${content}`

    await TmuxCommands.sendKeys(paneId, prompt)
    await TmuxCommands.sendEnter(paneId)

    await sleep(2000)

    logger.info('Context loaded')
  }

  /**
   * Inicializar Claude en un pane
   */
  private async initializeClaude(paneId: string, options: InitOptions): Promise<void> {
    const { isFork, forkName, loadContext, contextPath } = options

    logger.debug(`Initializing Claude in pane ${paneId}`)

    // 1. cd al proyecto
    await TmuxCommands.sendKeys(paneId, `cd ${this.projectPath}`)
    await TmuxCommands.sendEnter(paneId)
    await sleep(500)

    // 2. Iniciar Claude (siempre con --continue para mantener contexto del proyecto)
    await TmuxCommands.sendKeys(paneId, 'claude --continue')
    await TmuxCommands.sendEnter(paneId)
    await sleep(8000) // Esperar 8 segundos para que Claude se inicialice completamente

    // 3. Cargar contexto si existe
    if (loadContext && contextPath) {
      await this.loadContext(paneId, contextPath)
    }

    // 4. Si es fork, notificar (esperar un poco más antes de enviar el mensaje)
    if (isFork && forkName) {
      await sleep(5000) // Espera adicional de 5s para forks (total: 13s desde inicio)
      await TmuxCommands.sendKeys(paneId, `Este es un fork llamado "${forkName}". Ten esto en cuenta.`)
      await TmuxCommands.sendEnter(paneId)
      await sleep(1000)
    }

    logger.info('Claude initialized')
  }
}
