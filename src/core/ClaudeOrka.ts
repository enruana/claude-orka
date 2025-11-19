import { SessionManager } from './SessionManager'
import { Session, Fork, SessionFilters, ProjectSummary, SessionSummary, ForkSummary } from '../models'
import { logger } from '../utils'

/**
 * Claude-Orka SDK
 * Public API for orchestrating Claude Code sessions with tmux
 */
export class ClaudeOrka {
  private sessionManager: SessionManager

  /**
   * Create a ClaudeOrka instance
   * @param projectPath Absolute path to the project
   */
  constructor(projectPath: string) {
    this.sessionManager = new SessionManager(projectPath)
  }

  /**
   * Initialize ClaudeOrka
   * Creates the .claude-orka/ structure if it doesn't exist
   */
  async initialize(): Promise<void> {
    logger.info('Initializing ClaudeOrka')
    await this.sessionManager.initialize()
  }

  // --- SESSIONS ---

  /**
   * Create a new Claude Code session
   * @param name Optional name for the session
   * @param openTerminal Whether to open a terminal window (default: true)
   * @returns Created session
   */
  async createSession(name?: string, openTerminal?: boolean): Promise<Session> {
    return await this.sessionManager.createSession(name, openTerminal)
  }

  /**
   * Resume a saved session
   * @param sessionId Session ID to resume
   * @param openTerminal Whether to open a terminal window (default: true)
   * @returns Resumed session
   */
  async resumeSession(sessionId: string, openTerminal?: boolean): Promise<Session> {
    return await this.sessionManager.resumeSession(sessionId, openTerminal)
  }

  /**
   * Close a session
   * @param sessionId Session ID
   */
  async closeSession(sessionId: string): Promise<void> {
    await this.sessionManager.closeSession(sessionId)
  }

  /**
   * Permanently delete a session
   * @param sessionId Session ID
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.sessionManager.deleteSession(sessionId)
  }

  /**
   * List sessions with optional filters
   * @param filters Optional filters (status, name)
   * @returns Array of sessions
   */
  async listSessions(filters?: SessionFilters): Promise<Session[]> {
    return await this.sessionManager.listSessions(filters)
  }

  /**
   * Get a session by ID
   * @param sessionId Session ID
   * @returns Session or null if not found
   */
  async getSession(sessionId: string): Promise<Session | null> {
    return await this.sessionManager.getSession(sessionId)
  }

  /**
   * Get complete project summary
   * Includes statistics of all sessions and their forks
   * @returns Project summary with all sessions and statistics
   */
  async getProjectSummary(): Promise<ProjectSummary> {
    const sessions = await this.sessionManager.listSessions()
    const state = await this.sessionManager.getState()

    // Process each session
    const sessionSummaries: SessionSummary[] = sessions.map((session) => {
      // Process forks
      const forkSummaries: ForkSummary[] = session.forks.map((fork) => ({
        id: fork.id,
        name: fork.name,
        claudeSessionId: fork.claudeSessionId,
        status: fork.status,
        createdAt: fork.createdAt,
        hasContext: !!fork.contextPath,
        contextPath: fork.contextPath,
        mergedToMain: fork.mergedToMain || false,
        mergedAt: fork.mergedAt,
      }))

      // Count forks by state
      const activeForks = session.forks.filter((f) => f.status === 'active').length
      const savedForks = session.forks.filter((f) => f.status === 'saved').length
      const mergedForks = session.forks.filter((f) => f.status === 'merged').length

      return {
        id: session.id,
        name: session.name,
        claudeSessionId: session.main.claudeSessionId,
        status: session.status,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        totalForks: session.forks.length,
        activeForks,
        savedForks,
        mergedForks,
        forks: forkSummaries,
      }
    })

    // Count sessions by state
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
   * Create a fork (conversation branch)
   * @param sessionId Session ID
   * @param name Optional fork name
   * @param vertical Whether to split vertically (default: false = horizontal)
   * @returns Created fork
   */
  async createFork(sessionId: string, name?: string, vertical?: boolean): Promise<Fork> {
    return await this.sessionManager.createFork(sessionId, name, vertical)
  }

  /**
   * Close a fork
   * @param sessionId Session ID
   * @param forkId Fork ID
   */
  async closeFork(sessionId: string, forkId: string): Promise<void> {
    await this.sessionManager.closeFork(sessionId, forkId)
  }

  /**
   * Resume a saved fork
   * @param sessionId Session ID
   * @param forkId Fork ID
   * @returns Resumed fork
   */
  async resumeFork(sessionId: string, forkId: string): Promise<Fork> {
    return await this.sessionManager.resumeFork(sessionId, forkId)
  }

  /**
   * Permanently delete a fork
   * @param sessionId Session ID
   * @param forkId Fork ID
   */
  async deleteFork(sessionId: string, forkId: string): Promise<void> {
    await this.sessionManager.deleteFork(sessionId, forkId)
  }

  // --- COMANDOS ---

  /**
   * Send command to a session or fork
   * @param sessionId Session ID
   * @param command Command to send
   * @param target Fork ID (optional, if not specified goes to main)
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
   * Export fork context (old method - uses manual capture)
   * @deprecated Use generateForkExport() instead for Claude to generate the summary
   * @param sessionId Session ID
   * @param forkId Fork ID
   * @returns Path to the exported file
   */
  async export(sessionId: string, forkId: string): Promise<string> {
    return await this.sessionManager.exportFork(sessionId, forkId)
  }

  /**
   * Generate fork export with summary
   *
   * Sends a prompt to Claude requesting:
   * 1. Generate executive summary of the conversation
   * 2. Export using /export to the specified path
   *
   * IMPORTANT: This method is async but returns immediately.
   * Claude will execute tasks in the background. Wait a few seconds before calling merge().
   *
   * @param sessionId Session ID
   * @param forkId Fork ID
   * @returns Path where Claude will save the export
   */
  async generateForkExport(sessionId: string, forkId: string): Promise<string> {
    return await this.sessionManager.generateForkExport(sessionId, forkId)
  }

  /**
   * Merge a fork to main
   *
   * PREREQUISITE: You must call generateForkExport() first and wait for Claude to complete
   *
   * @param sessionId Session ID
   * @param forkId Fork ID
   */
  async merge(sessionId: string, forkId: string): Promise<void> {
    await this.sessionManager.mergeFork(sessionId, forkId)
  }

  /**
   * Generate export and merge a fork to main (recommended method)
   *
   * Workflow:
   * 1. Generates export with summary (Claude does the work)
   * 2. Wait for the file to be created
   * 3. Merge to main
   *
   * @param sessionId Session ID
   * @param forkId Fork ID
   * @param waitTime Wait time in ms for Claude to complete (default: 15000)
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
   * Generate export, merge and close a fork (complete flow)
   *
   * @param sessionId Session ID
   * @param forkId Fork ID
   * @param waitTime Wait time in ms for Claude to complete (default: 15000)
   */
  async generateExportMergeAndClose(
    sessionId: string,
    forkId: string,
    waitTime: number = 15000
  ): Promise<void> {
    await this.generateExportAndMerge(sessionId, forkId, waitTime)
    // The fork is already closed in mergeFork()
  }

  /**
   * Export and merge a fork to main (old method)
   * @deprecated Usa generateExportAndMerge() en su lugar
   */
  async exportAndMerge(sessionId: string, forkId: string): Promise<void> {
    await this.export(sessionId, forkId)
    await this.merge(sessionId, forkId)
  }

  /**
   * Export, merge and close a fork (old method)
   * @deprecated Usa generateExportMergeAndClose() en su lugar
   */
  async mergeAndClose(sessionId: string, forkId: string): Promise<void> {
    await this.exportAndMerge(sessionId, forkId)
    await this.closeFork(sessionId, forkId)
  }
}
