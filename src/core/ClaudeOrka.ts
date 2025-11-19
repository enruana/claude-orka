import { SessionManager } from './SessionManager'
import { Session, Fork, SessionFilters, ProjectSummary, SessionSummary, ForkSummary } from '../models'
import { logger } from '../utils'

/**
 * Claude-Orka SDK
 * API pública para orquestar sesiones de Claude Code con tmux
 */
export class ClaudeOrka {
  private sessionManager: SessionManager

  /**
   * Crear una instancia de ClaudeOrka
   * @param projectPath Path absoluto del proyecto
   */
  constructor(projectPath: string) {
    this.sessionManager = new SessionManager(projectPath)
  }

  /**
   * Inicializar ClaudeOrka
   * Crea la estructura .claude-orka/ si no existe
   */
  async initialize(): Promise<void> {
    logger.info('Initializing ClaudeOrka')
    await this.sessionManager.initialize()
  }

  // --- SESIONES ---

  /**
   * Crear una nueva sesión de Claude Code
   * @param name Nombre opcional para la sesión
   * @param openTerminal Si debe abrir una ventana de terminal (default: true)
   * @returns Sesión creada
   */
  async createSession(name?: string, openTerminal?: boolean): Promise<Session> {
    return await this.sessionManager.createSession(name, openTerminal)
  }

  /**
   * Restaurar una sesión guardada
   * @param sessionId ID de la sesión a restaurar
   * @param openTerminal Si debe abrir una ventana de terminal (default: true)
   * @returns Sesión restaurada
   */
  async resumeSession(sessionId: string, openTerminal?: boolean): Promise<Session> {
    return await this.sessionManager.resumeSession(sessionId, openTerminal)
  }

  /**
   * Cerrar una sesión
   * @param sessionId ID de la sesión
   * @param saveContext Si debe guardar el contexto antes de cerrar (default: true)
   */
  async closeSession(sessionId: string, saveContext?: boolean): Promise<void> {
    await this.sessionManager.closeSession(sessionId, saveContext)
  }

  /**
   * Eliminar una sesión permanentemente
   * @param sessionId ID de la sesión
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.sessionManager.deleteSession(sessionId)
  }

  /**
   * Listar sesiones con filtros opcionales
   * @param filters Filtros opcionales (status, name)
   * @returns Array de sesiones
   */
  async listSessions(filters?: SessionFilters): Promise<Session[]> {
    return await this.sessionManager.listSessions(filters)
  }

  /**
   * Obtener una sesión por ID
   * @param sessionId ID de la sesión
   * @returns Sesión o null si no existe
   */
  async getSession(sessionId: string): Promise<Session | null> {
    return await this.sessionManager.getSession(sessionId)
  }

  /**
   * Obtener resumen completo del proyecto
   * Incluye estadísticas de todas las sesiones y sus forks
   * @returns Resumen del proyecto con todas las sesiones y estadísticas
   */
  async getProjectSummary(): Promise<ProjectSummary> {
    const sessions = await this.sessionManager.listSessions()
    const state = await this.sessionManager.getState()

    // Procesar cada sesión
    const sessionSummaries: SessionSummary[] = sessions.map((session) => {
      // Procesar forks
      const forkSummaries: ForkSummary[] = session.forks.map((fork) => ({
        id: fork.id,
        name: fork.name,
        status: fork.status,
        createdAt: fork.createdAt,
        hasContext: !!fork.contextPath,
        contextPath: fork.contextPath,
        mergedToMain: fork.mergedToMain || false,
        mergedAt: fork.mergedAt,
      }))

      // Contar forks por estado
      const activeForks = session.forks.filter((f) => f.status === 'active').length
      const savedForks = session.forks.filter((f) => f.status === 'saved').length
      const mergedForks = session.forks.filter((f) => f.status === 'merged').length

      return {
        id: session.id,
        name: session.name,
        status: session.status,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        hasMainContext: !!session.main.contextPath,
        mainContextPath: session.main.contextPath,
        totalForks: session.forks.length,
        activeForks,
        savedForks,
        mergedForks,
        forks: forkSummaries,
      }
    })

    // Contar sesiones por estado
    const activeSessions = sessions.filter((s) => s.status === 'active').length
    const savedSessions = sessions.filter((s) => s.status === 'saved').length

    return {
      projectPath: state.projectPath,
      totalSessions: sessions.length,
      activeSessions,
      savedSessions,
      sessions: sessionSummaries,
      lastUpdated: state.lastUpdated,
    }
  }

  // --- FORKS ---

  /**
   * Crear un fork (rama de conversación)
   * @param sessionId ID de la sesión
   * @param name Nombre opcional del fork
   * @param vertical Si debe dividir verticalmente (default: false = horizontal)
   * @returns Fork creado
   */
  async createFork(sessionId: string, name?: string, vertical?: boolean): Promise<Fork> {
    return await this.sessionManager.createFork(sessionId, name, vertical)
  }

  /**
   * Cerrar un fork
   * @param sessionId ID de la sesión
   * @param forkId ID del fork
   * @param saveContext Si debe guardar el contexto antes de cerrar (default: true)
   */
  async closeFork(sessionId: string, forkId: string, saveContext?: boolean): Promise<void> {
    await this.sessionManager.closeFork(sessionId, forkId, saveContext)
  }

  /**
   * Restaurar un fork guardado
   * @param sessionId ID de la sesión
   * @param forkId ID del fork
   * @returns Fork restaurado
   */
  async resumeFork(sessionId: string, forkId: string): Promise<Fork> {
    return await this.sessionManager.resumeFork(sessionId, forkId)
  }

  /**
   * Eliminar un fork permanentemente
   * @param sessionId ID de la sesión
   * @param forkId ID del fork
   */
  async deleteFork(sessionId: string, forkId: string): Promise<void> {
    await this.sessionManager.deleteFork(sessionId, forkId)
  }

  // --- COMANDOS ---

  /**
   * Enviar comando a una sesión o fork
   * @param sessionId ID de la sesión
   * @param command Comando a enviar
   * @param target ID del fork (opcional, si no se especifica va a main)
   */
  async send(sessionId: string, command: string, target?: string): Promise<void> {
    if (target) {
      await this.sessionManager.sendToFork(sessionId, target, command)
    } else {
      await this.sessionManager.sendToMain(sessionId, command)
    }
  }

  // --- EXPORT & MERGE ---

  /**
   * Exportar el contexto de un fork (método viejo - usa captura manual)
   * @deprecated Usa generateForkExport() en su lugar para que Claude genere el resumen
   * @param sessionId ID de la sesión
   * @param forkId ID del fork
   * @param customName Nombre personalizado para el export (opcional)
   * @returns Path del archivo exportado
   */
  async export(sessionId: string, forkId: string, customName?: string): Promise<string> {
    return await this.sessionManager.exportFork(sessionId, forkId, customName)
  }

  /**
   * Generar export de un fork con resumen
   *
   * Envía un prompt a Claude pidiendo:
   * 1. Generar resumen ejecutivo de la conversación
   * 2. Exportar usando /export a la ruta especificada
   *
   * IMPORTANTE: Este método es asíncrono pero retorna inmediatamente.
   * Claude ejecutará las tareas en segundo plano. Espera unos segundos antes de llamar a merge().
   *
   * @param sessionId ID de la sesión
   * @param forkId ID del fork
   * @returns Path donde Claude guardará el export
   */
  async generateForkExport(sessionId: string, forkId: string): Promise<string> {
    return await this.sessionManager.generateForkExport(sessionId, forkId)
  }

  /**
   * Hacer merge de un fork a main
   *
   * PREREQUISITO: Debes llamar a generateForkExport() primero y esperar a que Claude complete
   *
   * @param sessionId ID de la sesión
   * @param forkId ID del fork
   */
  async merge(sessionId: string, forkId: string): Promise<void> {
    await this.sessionManager.mergeFork(sessionId, forkId)
  }

  /**
   * Generar export y hacer merge de un fork a main (método recomendado)
   *
   * Workflow:
   * 1. Genera export con resumen (Claude hace el trabajo)
   * 2. Espera a que el archivo se cree
   * 3. Hace merge a main
   *
   * @param sessionId ID de la sesión
   * @param forkId ID del fork
   * @param waitTime Tiempo de espera en ms para que Claude complete (default: 15000)
   */
  async generateExportAndMerge(
    sessionId: string,
    forkId: string,
    waitTime: number = 15000
  ): Promise<void> {
    // 1. Generar export (Claude lo hace)
    await this.generateForkExport(sessionId, forkId)

    // 2. Esperar a que Claude complete el export
    logger.info(`Waiting ${waitTime}ms for Claude to complete export...`)
    await new Promise((resolve) => setTimeout(resolve, waitTime))

    // 3. Hacer merge
    await this.merge(sessionId, forkId)
  }

  /**
   * Generar export, hacer merge y cerrar un fork (flujo completo)
   *
   * @param sessionId ID de la sesión
   * @param forkId ID del fork
   * @param waitTime Tiempo de espera en ms para que Claude complete (default: 15000)
   */
  async generateExportMergeAndClose(
    sessionId: string,
    forkId: string,
    waitTime: number = 15000
  ): Promise<void> {
    await this.generateExportAndMerge(sessionId, forkId, waitTime)
    // El fork ya se cierra en mergeFork()
  }

  /**
   * Exportar y hacer merge de un fork a main (método viejo)
   * @deprecated Usa generateExportAndMerge() en su lugar
   */
  async exportAndMerge(sessionId: string, forkId: string): Promise<void> {
    await this.export(sessionId, forkId)
    await this.merge(sessionId, forkId)
  }

  /**
   * Exportar, hacer merge y cerrar un fork (método viejo)
   * @deprecated Usa generateExportMergeAndClose() en su lugar
   */
  async mergeAndClose(sessionId: string, forkId: string): Promise<void> {
    await this.exportAndMerge(sessionId, forkId)
    await this.closeFork(sessionId, forkId, false) // No guardar de nuevo
  }
}
