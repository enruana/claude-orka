/**
 * AgentManager - Orchestrates all agent daemons and the hook server
 *
 * Phase 1: Core CRUD, start/stop, connect/disconnect, hook event dispatch
 */

import { EventEmitter } from 'events'
import { logger } from '../utils'
import { Agent, AgentHookTrigger } from '../models/Agent'
import { ProcessedHookEvent } from '../models/HookEvent'
import { getAgentStateManager, AgentStateManager } from './AgentStateManager'
import { getHookServer, HookServer } from './HookServer'
import { HookConfigGenerator } from './HookConfigGenerator'
import { AgentDaemon } from './AgentDaemon'
import { ClaudeOrka } from '../core/ClaudeOrka'
import { StateManager } from '../core/StateManager'

/**
 * Agent log entry
 */
export interface AgentLogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug' | 'action'
  message: string
  details?: Record<string, unknown>
}

export class AgentManager extends EventEmitter {
  private stateManager: AgentStateManager | null = null
  private hookServer: HookServer | null = null
  private hookConfigGenerator: HookConfigGenerator | null = null
  private daemons: Map<string, AgentDaemon> = new Map()
  private agentLogs: Map<string, AgentLogEntry[]> = new Map()
  private isInitialized: boolean = false
  private logIdCounter: number = 0

  async initialize(): Promise<void> {
    if (this.isInitialized) return

    logger.info('Initializing AgentManager')

    this.stateManager = await getAgentStateManager()

    const hookPort = this.stateManager.getHookServerPort()
    this.hookServer = await getHookServer(hookPort)
    this.hookConfigGenerator = new HookConfigGenerator(hookPort)

    // Set up global hook handler
    this.hookServer.onEvent(async (event) => {
      await this.handleHookEvent(event)
    })

    this.isInitialized = true
    logger.info('AgentManager initialized')
  }

  async startHookServer(): Promise<void> {
    if (!this.hookServer) {
      throw new Error('AgentManager not initialized')
    }

    if (!this.hookServer.isRunning()) {
      await this.hookServer.start()
      logger.info(`Hook server started on port ${this.hookServer.getPort()}`)
    }
  }

  async stopHookServer(): Promise<void> {
    if (this.hookServer?.isRunning()) {
      await this.hookServer.stop()
    }
  }

  async createAgent(
    name: string,
    masterPrompt: string,
    options: {
      hookEvents?: AgentHookTrigger[]
      autoApprove?: boolean
    } = {}
  ): Promise<Agent> {
    if (!this.stateManager) {
      throw new Error('AgentManager not initialized')
    }

    const agent = await this.stateManager.createAgent(name, masterPrompt, {
      hookEvents: options.hookEvents || ['Stop'],
      autoApprove: options.autoApprove || false,
    })

    this.emit('agentCreated', agent)
    logger.info(`Created agent: ${agent.name} (${agent.id})`)
    return agent
  }

  getAgent(agentId: string): Agent | null {
    const agent = this.stateManager?.getAgent(agentId) || null
    // Sync status with actual daemon state
    if (agent && this.daemons.has(agentId) && agent.status !== 'active') {
      agent.status = 'active'
    }
    return agent
  }

  getAgents(): Agent[] {
    const agents = this.stateManager?.getAgents() || []
    // Sync status with actual daemon state
    for (const agent of agents) {
      if (this.daemons.has(agent.id) && agent.status !== 'active') {
        agent.status = 'active'
      }
    }
    return agents
  }

  async updateAgent(agentId: string, updates: Partial<Agent>): Promise<Agent> {
    if (!this.stateManager) {
      throw new Error('AgentManager not initialized')
    }

    const updatedAgent = await this.stateManager.updateAgent(agentId, updates)
    return updatedAgent
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    if (!this.stateManager) {
      throw new Error('AgentManager not initialized')
    }

    await this.stopAgent(agentId)

    const agent = this.stateManager.getAgent(agentId)
    if (agent?.connection) {
      await this.disconnectAgent(agentId)
    }

    return this.stateManager.deleteAgent(agentId)
  }

  async startAgent(agentId: string): Promise<void> {
    if (!this.stateManager) {
      throw new Error('AgentManager not initialized')
    }

    const agent = this.stateManager.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    if (this.daemons.has(agentId)) {
      logger.warn(`Agent ${agentId} is already running`)
      // Ensure status reflects the running daemon (fixes desync after state edits)
      const current = this.stateManager.getAgent(agentId)
      if (current && current.status !== 'active') {
        await this.stateManager.updateAgentStatus(agentId, 'active')
      }
      return
    }

    const daemon = new AgentDaemon(agent)

    daemon.on('error', (error) => {
      this.emit('error', error, agentId)
    })

    await daemon.start()
    this.daemons.set(agentId, daemon)
    this.emit('agentStarted', agent)
    logger.info(`Agent ${agentId} started`)
  }

  async stopAgent(agentId: string): Promise<void> {
    const daemon = this.daemons.get(agentId)
    if (!daemon) return

    await daemon.stop()
    this.daemons.delete(agentId)

    const agent = this.stateManager?.getAgent(agentId)
    if (agent) {
      this.emit('agentStopped', agent)
    }
    logger.info(`Agent ${agentId} stopped`)
  }

  async connectAgent(
    agentId: string,
    projectPath: string,
    sessionId?: string,
    tmuxPaneId?: string,
    branchId?: string
  ): Promise<Agent> {
    if (!this.stateManager || !this.hookConfigGenerator) {
      throw new Error('AgentManager not initialized')
    }

    const agent = this.stateManager.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    this.addAgentLog(agentId, 'info', `Connecting to project: ${projectPath}`)

    // Install hooks in the project
    await this.hookConfigGenerator.installHooks(
      projectPath,
      agentId,
      agent.hookEvents
    )
    this.addAgentLog(agentId, 'info', `Installed hooks: ${agent.hookEvents.join(', ')}`)

    // Restart session so Claude Code picks up new hooks
    if (sessionId) {
      try {
        this.addAgentLog(agentId, 'info', `Restarting session ${sessionId} to load hooks...`)
        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        await orka.closeSession(sessionId)
        await new Promise(resolve => setTimeout(resolve, 500))
        const session = await orka.resumeSession(sessionId, false)

        tmuxPaneId = session.main.tmuxPaneId
        this.addAgentLog(agentId, 'action', `Session restarted, new pane: ${tmuxPaneId}`)
      } catch (error: any) {
        this.addAgentLog(agentId, 'warn', `Failed to restart session: ${error.message}`)
        logger.warn(`Failed to restart session ${sessionId}: ${error.message}`)
      }
    }

    // Resolve claudeSessionId from project state
    let claudeSessionId: string | undefined

    if (sessionId) {
      try {
        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()
        const session = await orka.getSession(sessionId)

        if (session) {
          if (branchId && branchId !== 'main') {
            const fork = session.forks.find(f => f.id === branchId)
            if (fork) {
              claudeSessionId = fork.claudeSessionId
              tmuxPaneId = fork.tmuxPaneId || tmuxPaneId
            }
          } else if (tmuxPaneId) {
            if (session.main.tmuxPaneId === tmuxPaneId) {
              claudeSessionId = session.main.claudeSessionId
              branchId = 'main'
            } else {
              const fork = session.forks.find(f => f.tmuxPaneId === tmuxPaneId)
              if (fork) {
                claudeSessionId = fork.claudeSessionId
                branchId = fork.id
              }
            }
          } else {
            claudeSessionId = session.main.claudeSessionId
            branchId = branchId || 'main'
          }
        }
      } catch (error: any) {
        logger.debug(`Could not resolve claudeSessionId: ${error.message}`)
      }
    }

    const updatedAgent = await this.stateManager.connectAgent(
      agentId,
      projectPath,
      sessionId,
      tmuxPaneId,
      claudeSessionId,
      branchId
    )

    this.emit('agentConnected', updatedAgent, projectPath)
    this.addAgentLog(agentId, 'action', `Connected to ${projectPath}${branchId ? ` (branch: ${branchId})` : ''}`)
    return updatedAgent
  }

  async disconnectAgent(agentId: string): Promise<Agent> {
    if (!this.stateManager || !this.hookConfigGenerator) {
      throw new Error('AgentManager not initialized')
    }

    const agent = this.stateManager.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    if (agent.connection) {
      await this.hookConfigGenerator.uninstallHooks(
        agent.connection.projectPath,
        agentId
      )
    }

    const updatedAgent = await this.stateManager.disconnectAgent(agentId)
    this.emit('agentDisconnected', updatedAgent)
    logger.info(`Agent ${agentId} disconnected`)
    return updatedAgent
  }

  private async handleHookEvent(event: ProcessedHookEvent): Promise<void> {
    logger.debug(`AgentManager received hook event for agent ${event.agentId}`)

    let agent = this.stateManager?.getAgent(event.agentId)
    if (!agent) {
      this.addAgentLog(event.agentId, 'warn', `Hook DROPPED: agent not found`)
      return
    }

    this.addAgentLog(event.agentId, 'info', `Hook received: ${event.payload.event_type} [session: ${(event.payload.session_id || 'none').slice(0, 8)}]`)

    // SessionStart: update session tracking
    if (event.payload.event_type === 'SessionStart') {
      await this.handleSessionStartEvent(event, agent)
      const refreshed = this.stateManager?.getAgent(event.agentId)
      if (refreshed) agent = refreshed
    }

    // Filter 1: Event type must be in agent's hookEvents
    if (!agent.hookEvents.includes(event.payload.event_type as AgentHookTrigger)) {
      this.addAgentLog(event.agentId, 'warn', `Hook FILTERED: ${event.payload.event_type} not in hookEvents [${agent.hookEvents.join(', ')}]`)
      return
    }

    // Filter 2: Claude session ID must match
    const hookSessionId = event.payload.session_id
    const agentSessionId = agent.connection?.claudeSessionId
    if (hookSessionId && agentSessionId && hookSessionId !== agentSessionId) {
      this.addAgentLog(event.agentId, 'warn', `Hook FILTERED: session mismatch`)
      return
    }

    this.addAgentLog(event.agentId, 'info', `Hook ACCEPTED: ${event.payload.event_type}`)

    // Get or start daemon
    let daemon = this.daemons.get(event.agentId)
    if (!daemon) {
      this.addAgentLog(event.agentId, 'info', 'Auto-starting agent to handle hook event')
      await this.startAgent(event.agentId)
      daemon = this.daemons.get(event.agentId)
    }

    if (!daemon) return

    await daemon.refresh()
    await daemon.handleHookEvent(event, this)
  }

  private async handleSessionStartEvent(event: ProcessedHookEvent, agent: Agent): Promise<void> {
    const source = event.payload.session_start_data?.source || 'unknown'
    const newSessionId = event.payload.session_id
    const oldSessionId = agent.connection?.claudeSessionId

    this.addAgentLog(event.agentId, 'action', `SessionStart (source: ${source})`)

    const sessionIdChanged = newSessionId && oldSessionId && newSessionId !== oldSessionId
    const sessionIdNew = newSessionId && !oldSessionId

    if ((sessionIdChanged || sessionIdNew) && agent.connection) {
      // 1. Update agent state (hook routing)
      await this.stateManager?.connectAgent(
        event.agentId,
        agent.connection.projectPath,
        agent.connection.sessionId,
        agent.connection.tmuxPaneId,
        newSessionId,
        agent.connection.branchId
      )

      if (sessionIdChanged) {
        this.addAgentLog(event.agentId, 'action',
          `Agent session ID updated after ${source}: ${oldSessionId!.slice(0, 8)} -> ${newSessionId.slice(0, 8)}`
        )
      } else {
        this.addAgentLog(event.agentId, 'action', `Agent session ID set: ${newSessionId.slice(0, 8)}`)
      }

      // 2. Update Orka project state (session resume)
      //    This is critical: without this, `orka session resume` uses the old
      //    claudeSessionId and loads a stale conversation after /clear.
      await this.updateOrkaProjectSession(agent, newSessionId)
    }
  }

  /**
   * Update the claudeSessionId in the Orka project state (.claude-orka/state.json).
   * Called when Claude creates a new session after /clear.
   */
  private async updateOrkaProjectSession(agent: Agent, newClaudeSessionId: string): Promise<void> {
    const conn = agent.connection
    if (!conn?.projectPath || !conn.sessionId) return

    try {
      const sm = new StateManager(conn.projectPath)
      await sm.initialize()
      const session = await sm.getSession(conn.sessionId)
      if (!session) return

      const branchId = conn.branchId || 'main'

      if (branchId === 'main') {
        const oldId = session.main.claudeSessionId
        session.main.claudeSessionId = newClaudeSessionId
        this.addAgentLog(agent.id, 'action',
          `Orka main session updated: ${oldId.slice(0, 8)} -> ${newClaudeSessionId.slice(0, 8)}`
        )
      } else {
        const fork = session.forks.find(f => f.id === branchId)
        if (fork) {
          const oldId = fork.claudeSessionId
          fork.claudeSessionId = newClaudeSessionId
          this.addAgentLog(agent.id, 'action',
            `Orka fork "${fork.name}" session updated: ${oldId.slice(0, 8)} -> ${newClaudeSessionId.slice(0, 8)}`
          )
        }
      }

      await sm.replaceSession(session)
    } catch (error: any) {
      this.addAgentLog(agent.id, 'warn', `Failed to update Orka project state: ${error.message}`)
      logger.warn(`Failed to update Orka project state for agent ${agent.id}: ${error.message}`)
    }
  }

  getAgentsByProject(projectPath: string): Agent[] {
    return this.stateManager?.getAgentsByProject(projectPath) || []
  }

  isReady(): boolean {
    return this.isInitialized
  }

  addAgentLog(
    agentId: string,
    level: AgentLogEntry['level'],
    message: string,
    details?: Record<string, unknown>
  ): void {
    if (!this.agentLogs.has(agentId)) {
      this.agentLogs.set(agentId, [])
    }

    const logs = this.agentLogs.get(agentId)!
    const entry: AgentLogEntry = {
      id: `log-${++this.logIdCounter}`,
      timestamp: new Date().toISOString(),
      level,
      message,
      details,
    }

    logs.push(entry)

    // Keep only last 500 logs per agent
    if (logs.length > 500) {
      logs.shift()
    }

    if (level === 'error') {
      logger.error(`[Agent ${agentId}] ${message}`)
    } else if (level === 'warn') {
      logger.warn(`[Agent ${agentId}] ${message}`)
    } else {
      logger.debug(`[Agent ${agentId}] ${message}`)
    }
  }

  getAgentLogs(agentId: string): AgentLogEntry[] {
    return this.agentLogs.get(agentId) || []
  }

  clearAgentLogs(agentId: string): void {
    this.agentLogs.set(agentId, [])
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down AgentManager')

    for (const [agentId] of this.daemons) {
      await this.stopAgent(agentId)
    }

    await this.stopHookServer()

    this.isInitialized = false
    logger.info('AgentManager shut down')
  }
}

// Singleton instance
let agentManager: AgentManager | null = null

export async function getAgentManager(): Promise<AgentManager> {
  if (!agentManager) {
    agentManager = new AgentManager()
    await agentManager.initialize()
  }
  return agentManager
}
