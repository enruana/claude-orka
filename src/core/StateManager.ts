import path from 'path'
import fs from 'fs-extra'
import { ProjectState, Session, Fork, SessionFilters } from '../models'
import { logger } from '../utils'

/**
 * Manages state persistence in .claude-orka/state.json
 */
export class StateManager {
  private projectPath: string
  private orkaDir: string
  private statePath: string

  constructor(projectPath: string) {
    this.projectPath = path.resolve(projectPath)
    this.orkaDir = path.join(this.projectPath, '.claude-orka')
    this.statePath = path.join(this.orkaDir, 'state.json')
  }

  /**
   * Initialize StateManager
   * Creates necessary folders if they don't exist
   */
  async initialize(): Promise<void> {
    logger.debug('Initializing StateManager')
    await this.ensureDirectories()

    // If state.json doesn't exist, create an initial one
    if (!(await fs.pathExists(this.statePath))) {
      logger.info('Creating initial state.json')
      const initialState: ProjectState = {
        version: '1.0.0',
        projectPath: this.projectPath,
        sessions: [],
        lastUpdated: new Date().toISOString(),
      }
      await this.save(initialState)
    }

    logger.info('StateManager initialized')
  }

  /**
   * Create directory structure
   */
  private async ensureDirectories(): Promise<void> {
    await fs.ensureDir(this.orkaDir)
    // exports/ created on-demand when needed during merge
    logger.debug('Directories ensured')
  }

  /**
   * Read current state
   */
  async read(): Promise<ProjectState> {
    try {
      const content = await fs.readFile(this.statePath, 'utf-8')
      return JSON.parse(content)
    } catch (error: any) {
      logger.error('Failed to read state:', error)
      throw new Error(`Failed to read state: ${error.message}`)
    }
  }

  /**
   * Save state
   */
  async save(state: ProjectState): Promise<void> {
    try {
      state.lastUpdated = new Date().toISOString()
      await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf-8')
      logger.debug('State saved')
    } catch (error: any) {
      logger.error('Failed to save state:', error)
      throw new Error(`Failed to save state: ${error.message}`)
    }
  }

  // --- OPERACIONES DE SESIONES ---

  /**
   * Obtener el estado completo
   */
  async getState(): Promise<ProjectState> {
    return await this.read()
  }

  /**
   * Listar todas las sesiones con filtros opcionales
   */
  async listSessions(filters?: SessionFilters): Promise<Session[]> {
    const state = await this.read()
    let sessions = state.sessions

    if (filters?.status) {
      sessions = sessions.filter((s) => s.status === filters.status)
    }

    if (filters?.name) {
      sessions = sessions.filter((s) =>
        s.name.toLowerCase().includes(filters.name!.toLowerCase())
      )
    }

    return sessions
  }

  /**
   * Agregar una nueva sesión
   */
  async addSession(session: Session): Promise<void> {
    const state = await this.read()
    state.sessions.push(session)
    await this.save(state)
    logger.info(`Session added: ${session.id}`)
  }

  /**
   * Obtener una sesión por ID
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const state = await this.read()
    return state.sessions.find(s => s.id === sessionId) || null
  }

  /**
   * Obtener todas las sesiones con filtros opcionales
   */
  async getAllSessions(filters?: SessionFilters): Promise<Session[]> {
    const state = await this.read()
    let sessions = state.sessions

    if (filters?.status) {
      sessions = sessions.filter(s => s.status === filters.status)
    }

    if (filters?.name) {
      sessions = sessions.filter(s => s.name.includes(filters.name!))
    }

    return sessions
  }

  /**
   * Actualizar el estado de una sesión
   */
  async updateSessionStatus(sessionId: string, status: Session['status']): Promise<void> {
    const state = await this.read()
    const session = state.sessions.find(s => s.id === sessionId)

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    session.status = status
    session.lastActivity = new Date().toISOString()
    await this.save(state)
    logger.info(`Session ${sessionId} status updated to: ${status}`)
  }

  /**
   * Actualizar una sesión completa
   */
  async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
    const state = await this.read()
    const sessionIndex = state.sessions.findIndex(s => s.id === sessionId)

    if (sessionIndex === -1) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    state.sessions[sessionIndex] = {
      ...state.sessions[sessionIndex],
      ...updates,
      lastActivity: new Date().toISOString(),
    }

    await this.save(state)
    logger.debug(`Session ${sessionId} updated`)
  }

  /**
   * Reemplazar una sesión completa
   */
  async replaceSession(session: Session): Promise<void> {
    const state = await this.read()
    const sessionIndex = state.sessions.findIndex(s => s.id === session.id)

    if (sessionIndex === -1) {
      throw new Error(`Session not found: ${session.id}`)
    }

    state.sessions[sessionIndex] = session
    await this.save(state)
    logger.debug(`Session ${session.id} replaced`)
  }

  /**
   * Eliminar una sesión permanentemente
   */
  async deleteSession(sessionId: string): Promise<void> {
    const state = await this.read()
    state.sessions = state.sessions.filter(s => s.id !== sessionId)
    await this.save(state)
    logger.info(`Session deleted: ${sessionId}`)
  }

  // --- OPERACIONES DE FORKS ---

  /**
   * Agregar un fork a una sesión
   */
  async addFork(sessionId: string, fork: Fork): Promise<void> {
    const state = await this.read()
    const session = state.sessions.find(s => s.id === sessionId)

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    session.forks.push(fork)
    session.lastActivity = new Date().toISOString()
    await this.save(state)
    logger.info(`Fork added to session ${sessionId}: ${fork.id}`)
  }

  /**
   * Obtener un fork específico
   */
  async getFork(sessionId: string, forkId: string): Promise<Fork | null> {
    const session = await this.getSession(sessionId)
    if (!session) return null
    return session.forks.find(f => f.id === forkId) || null
  }

  /**
   * Actualizar el estado de un fork
   */
  async updateForkStatus(
    sessionId: string,
    forkId: string,
    status: Fork['status']
  ): Promise<void> {
    const state = await this.read()
    const session = state.sessions.find(s => s.id === sessionId)

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const fork = session.forks.find(f => f.id === forkId)
    if (!fork) {
      throw new Error(`Fork not found: ${forkId}`)
    }

    fork.status = status
    session.lastActivity = new Date().toISOString()

    await this.save(state)
    logger.info(`Fork ${forkId} status updated to: ${status}`)
  }

  /**
   * Actualizar el path del contexto de un fork
   */
  async updateForkContext(sessionId: string, forkId: string, contextPath: string): Promise<void> {
    const state = await this.read()
    const session = state.sessions.find(s => s.id === sessionId)

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const fork = session.forks.find(f => f.id === forkId)
    if (!fork) {
      throw new Error(`Fork not found: ${forkId}`)
    }

    fork.contextPath = contextPath

    await this.save(state)
    logger.debug(`Fork ${forkId} context updated: ${contextPath}`)
  }

  /**
   * Actualizar un fork completo
   */
  async updateFork(sessionId: string, forkId: string, updates: Partial<Fork>): Promise<void> {
    const state = await this.read()
    const session = state.sessions.find(s => s.id === sessionId)

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const forkIndex = session.forks.findIndex(f => f.id === forkId)
    if (forkIndex === -1) {
      throw new Error(`Fork not found: ${forkId}`)
    }

    session.forks[forkIndex] = {
      ...session.forks[forkIndex],
      ...updates,
    }
    session.lastActivity = new Date().toISOString()

    await this.save(state)
    logger.debug(`Fork ${forkId} updated`)
  }

  /**
   * Eliminar un fork
   */
  async deleteFork(sessionId: string, forkId: string): Promise<void> {
    const state = await this.read()
    const session = state.sessions.find(s => s.id === sessionId)

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const forkIndex = session.forks.findIndex(f => f.id === forkId)
    if (forkIndex === -1) {
      throw new Error(`Fork not found: ${forkId}`)
    }

    // Eliminar el fork del array
    session.forks.splice(forkIndex, 1)
    session.lastActivity = new Date().toISOString()

    await this.save(state)
    logger.debug(`Fork ${forkId} deleted`)
  }

  // --- OPERACIONES DE CONTEXTOS ---

  /**
   * Guardar un contexto en archivo
   */
  async saveContext(type: 'session' | 'fork', id: string, content: string): Promise<string> {
    const contextPath = type === 'session'
      ? this.getSessionContextPath(id)
      : this.getForkContextPath(id)

    const fullPath = path.join(this.projectPath, contextPath)
    await fs.writeFile(fullPath, content, 'utf-8')
    logger.info(`Context saved: ${contextPath}`)

    return contextPath
  }

  /**
   * Leer un contexto desde archivo
   */
  async readContext(contextPath: string): Promise<string> {
    const fullPath = path.join(this.projectPath, contextPath)

    if (!(await fs.pathExists(fullPath))) {
      throw new Error(`Context file not found: ${contextPath}`)
    }

    return await fs.readFile(fullPath, 'utf-8')
  }

  // --- HELPERS ---

  /**
   * Obtener el path para el contexto de una sesión
   */
  getSessionContextPath(sessionId: string): string {
    return `.claude-orka/sessions/${sessionId}.md`
  }

  /**
   * Obtener el path para el contexto de un fork
   */
  getForkContextPath(forkId: string): string {
    return `.claude-orka/forks/${forkId}.md`
  }

  /**
   * Obtener el path para un export manual
   */
  getExportPath(forkId: string, name: string): string {
    return `.claude-orka/exports/${forkId}-${name}.md`
  }
}
