/**
 * AgentManager - Orchestrates all agent daemons and the hook server
 */

import { EventEmitter } from 'events'
import { logger } from '../utils'
import { Agent, AgentHookTrigger, NotificationConfig } from '../models/Agent'
import { ProcessedHookEvent } from '../models/HookEvent'
import { getAgentStateManager, AgentStateManager } from './AgentStateManager'
import { getHookServer, HookServer } from './HookServer'
import { HookConfigGenerator } from './HookConfigGenerator'
import { AgentDaemon } from './AgentDaemon'
import { ClaudeOrka } from '../core/ClaudeOrka'

/**
 * AgentManager events
 */
export interface AgentManagerEvents {
  agentCreated: (agent: Agent) => void
  agentStarted: (agent: Agent) => void
  agentStopped: (agent: Agent) => void
  agentConnected: (agent: Agent, projectPath: string) => void
  agentDisconnected: (agent: Agent) => void
  hookReceived: (agentId: string, event: ProcessedHookEvent) => void
  error: (error: Error, agentId?: string) => void
}

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

/**
 * Agent status summary - compiled from daemon state and recent logs
 */
export interface AgentStatusSummary {
  agent: Agent
  currentPhase: 'idle' | 'capture' | 'analyze' | 'decide' | 'execute' | 'done'
  lastDecision?: {
    action: string
    reason: string
    confidence: number
    response?: string
    timestamp: string
  }
  lastTerminalSnapshot?: string
  lastTerminalState?: {
    isProcessing: boolean
    isWaitingForInput: boolean
    hasPermissionPrompt: boolean
    hasError: boolean
  }
  processingDuration?: number
  stats: {
    totalEvents: number
    totalActions: number
    totalErrors: number
    consecutiveWaits: number
  }
}

/**
 * AgentManager is the central orchestrator for all Master Agents
 */
export class AgentManager extends EventEmitter {
  private stateManager: AgentStateManager | null = null
  private hookServer: HookServer | null = null
  private hookConfigGenerator: HookConfigGenerator | null = null
  private daemons: Map<string, AgentDaemon> = new Map()
  private agentLogs: Map<string, AgentLogEntry[]> = new Map()
  private isInitialized: boolean = false
  private logIdCounter: number = 0

  /**
   * Initialize the agent manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    logger.info('Initializing AgentManager')

    // Initialize state manager
    this.stateManager = await getAgentStateManager()

    // Initialize hook server
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

  /**
   * Start the hook server
   */
  async startHookServer(): Promise<void> {
    if (!this.hookServer) {
      throw new Error('AgentManager not initialized')
    }

    if (!this.hookServer.isRunning()) {
      await this.hookServer.start()
      logger.info(`Hook server started on port ${this.hookServer.getPort()}`)
    }
  }

  /**
   * Stop the hook server
   */
  async stopHookServer(): Promise<void> {
    if (this.hookServer?.isRunning()) {
      await this.hookServer.stop()
    }
  }

  /**
   * Create a new agent
   */
  async createAgent(
    name: string,
    masterPrompt: string,
    options: {
      hookEvents?: AgentHookTrigger[]
      notifications?: NotificationConfig
      autoApprove?: boolean
      maxConsecutiveResponses?: number
      decisionHistorySize?: number
    } = {}
  ): Promise<Agent> {
    if (!this.stateManager) {
      throw new Error('AgentManager not initialized')
    }

    const agent = await this.stateManager.createAgent(name, masterPrompt, {
      hookEvents: options.hookEvents || ['Stop'],
      notifications: options.notifications || {},
      autoApprove: options.autoApprove || false,
      maxConsecutiveResponses: options.maxConsecutiveResponses || 5,
      decisionHistorySize: options.decisionHistorySize || 5,
    })

    this.emit('agentCreated', agent)
    logger.info(`Created agent: ${agent.name} (${agent.id})`)

    return agent
  }

  /**
   * Get an agent by ID
   */
  getAgent(agentId: string): Agent | null {
    return this.stateManager?.getAgent(agentId) || null
  }

  /**
   * Get all agents
   */
  getAgents(): Agent[] {
    return this.stateManager?.getAgents() || []
  }

  /**
   * Update an agent
   */
  async updateAgent(agentId: string, updates: Partial<Agent>): Promise<Agent> {
    if (!this.stateManager) {
      throw new Error('AgentManager not initialized')
    }

    return this.stateManager.updateAgent(agentId, updates)
  }

  /**
   * Delete an agent
   */
  async deleteAgent(agentId: string): Promise<boolean> {
    if (!this.stateManager) {
      throw new Error('AgentManager not initialized')
    }

    // Stop daemon if running
    await this.stopAgent(agentId)

    // Disconnect from any projects
    const agent = this.stateManager.getAgent(agentId)
    if (agent?.connection) {
      await this.disconnectAgent(agentId)
    }

    return this.stateManager.deleteAgent(agentId)
  }

  /**
   * Start an agent daemon
   */
  async startAgent(agentId: string): Promise<void> {
    if (!this.stateManager) {
      throw new Error('AgentManager not initialized')
    }

    const agent = this.stateManager.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    // Check if already running
    if (this.daemons.has(agentId)) {
      logger.warn(`Agent ${agentId} is already running`)
      return
    }

    // Create and start daemon
    const daemon = new AgentDaemon(agent)

    daemon.on('error', (error) => {
      this.emit('error', error, agentId)
    })

    daemon.on('humanHelpRequested', (reason) => {
      logger.info(`Agent ${agentId} requested human help: ${reason}`)
    })

    await daemon.start()

    this.daemons.set(agentId, daemon)
    this.emit('agentStarted', agent)

    logger.info(`Agent ${agentId} started`)
  }

  /**
   * Stop an agent daemon
   */
  async stopAgent(agentId: string): Promise<void> {
    const daemon = this.daemons.get(agentId)
    if (!daemon) {
      return
    }

    await daemon.stop()
    this.daemons.delete(agentId)

    const agent = this.stateManager?.getAgent(agentId)
    if (agent) {
      this.emit('agentStopped', agent)
    }

    logger.info(`Agent ${agentId} stopped`)
  }

  /**
   * Pause an agent
   */
  async pauseAgent(agentId: string): Promise<Agent> {
    if (!this.stateManager) {
      throw new Error('AgentManager not initialized')
    }

    return this.stateManager.updateAgentStatus(agentId, 'paused')
  }

  /**
   * Resume an agent from paused or waiting_human state
   */
  async resumeAgent(agentId: string): Promise<Agent> {
    if (!this.stateManager) {
      throw new Error('AgentManager not initialized')
    }

    const daemon = this.daemons.get(agentId)
    if (daemon) {
      await daemon.resumeFromHuman()
    }

    return this.stateManager.updateAgentStatus(agentId, 'active')
  }

  /**
   * Connect an agent to a project
   */
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

    // Restart the session so Claude Code picks up the new hooks
    if (sessionId) {
      try {
        this.addAgentLog(agentId, 'info', `Restarting session ${sessionId} to load hooks...`)
        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        // Close and resume the session
        await orka.closeSession(sessionId)
        await new Promise(resolve => setTimeout(resolve, 500))
        const session = await orka.resumeSession(sessionId, false)

        // Update tmuxPaneId with the new one from resumed session
        tmuxPaneId = session.main.tmuxPaneId

        this.addAgentLog(agentId, 'action', `Session restarted successfully, new pane: ${tmuxPaneId}`)
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
            // Look up fork by branchId
            const fork = session.forks.find(f => f.id === branchId)
            if (fork) {
              claudeSessionId = fork.claudeSessionId
              tmuxPaneId = fork.tmuxPaneId || tmuxPaneId
            }
          } else if (tmuxPaneId) {
            // Match by pane ID
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
            // Default to main branch
            claudeSessionId = session.main.claudeSessionId
            branchId = branchId || 'main'
          }
        }
      } catch (error: any) {
        logger.debug(`Could not resolve claudeSessionId: ${error.message}`)
      }
    }

    // Update agent state
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
    logger.info(`Agent ${agentId} connected to ${projectPath}${claudeSessionId ? ` [claude: ${claudeSessionId}]` : ''}`)

    return updatedAgent
  }

  /**
   * Disconnect an agent from its project
   */
  async disconnectAgent(agentId: string): Promise<Agent> {
    if (!this.stateManager || !this.hookConfigGenerator) {
      throw new Error('AgentManager not initialized')
    }

    const agent = this.stateManager.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    // Uninstall hooks if connected to a project
    if (agent.connection) {
      await this.hookConfigGenerator.uninstallHooks(
        agent.connection.projectPath,
        agentId
      )
    }

    // Update agent state
    const updatedAgent = await this.stateManager.disconnectAgent(agentId)

    this.emit('agentDisconnected', updatedAgent)
    logger.info(`Agent ${agentId} disconnected`)

    return updatedAgent
  }

  /**
   * Handle incoming hook event
   */
  private async handleHookEvent(event: ProcessedHookEvent): Promise<void> {
    logger.debug(`AgentManager received hook event for agent ${event.agentId}`)

    const agent = this.stateManager?.getAgent(event.agentId)
    if (!agent) {
      logger.debug(`Ignoring hook event - agent ${event.agentId} not found`)
      return
    }

    // Filter 1: Event type must be in agent's hookEvents
    if (!agent.hookEvents.includes(event.payload.event_type as AgentHookTrigger)) {
      logger.debug(`Ignoring ${event.payload.event_type} - not in agent ${event.agentId}'s hookEvents`)
      return
    }

    // Filter 2: Claude session ID must match the agent's connected session
    const hookSessionId = event.payload.session_id
    const agentSessionId = agent.connection?.claudeSessionId
    if (hookSessionId && agentSessionId && hookSessionId !== agentSessionId) {
      logger.debug(`Ignoring event from session ${hookSessionId} - agent ${event.agentId} monitors ${agentSessionId}`)
      return
    }

    this.addAgentLog(event.agentId, 'info', `Received hook event: ${event.payload.event_type}`, {
      eventType: event.payload.event_type,
      projectPath: event.projectPath,
    })

    this.emit('hookReceived', event.agentId, event)

    // Get the daemon for this agent
    const daemon = this.daemons.get(event.agentId)
    if (!daemon) {
      // Agent might not be running, try to start it
      if (agent.status !== 'paused') {
        this.addAgentLog(event.agentId, 'info', 'Auto-starting agent to handle hook event')
        await this.startAgent(event.agentId)
        const newDaemon = this.daemons.get(event.agentId)
        if (newDaemon) {
          await newDaemon.handleHookEvent(event, this)
        }
      }
      return
    }

    // Refresh daemon's agent data
    await daemon.refresh()

    // Check if agent is paused (re-check after refresh)
    const refreshedAgent = daemon.getAgent()
    if (refreshedAgent.status === 'paused') {
      this.addAgentLog(event.agentId, 'warn', 'Agent is paused, ignoring hook event')
      return
    }

    // Handle the event
    await daemon.handleHookEvent(event, this)
  }

  /**
   * Manually trigger an agent to analyze and act on its connected terminal
   * This simulates receiving a hook event
   */
  async triggerAgent(agentId: string): Promise<void> {
    if (!this.stateManager) {
      throw new Error('AgentManager not initialized')
    }

    const agent = this.stateManager.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    if (!agent.connection) {
      throw new Error(`Agent is not connected to any project`)
    }

    this.addAgentLog(agentId, 'action', 'Manual trigger received')

    // Create a synthetic hook event
    // Use claudeSessionId so it passes the session_id filter
    const syntheticEvent: ProcessedHookEvent = {
      payload: {
        event_type: 'Stop',
        timestamp: new Date().toISOString(),
        session_id: agent.connection.claudeSessionId || agent.connection.sessionId,
        cwd: agent.connection.projectPath,
      },
      agentId,
      projectPath: agent.connection.projectPath,
      orkaSessionId: agent.connection.sessionId,
      receivedAt: new Date().toISOString(),
      status: 'pending',
    }

    // Get or start the daemon
    let daemon = this.daemons.get(agentId)
    if (!daemon) {
      // Start the agent if not running
      await this.startAgent(agentId)
      daemon = this.daemons.get(agentId)
    }

    if (!daemon) {
      throw new Error('Failed to start agent daemon')
    }

    // Refresh daemon's agent data
    await daemon.refresh()

    // Force-reset processing state - manual trigger should always work
    daemon.forceResetProcessing()
    this.addAgentLog(agentId, 'info', 'Force-reset processing state for manual trigger')

    // Handle the synthetic event
    await daemon.handleHookEvent(syntheticEvent, this)

    this.addAgentLog(agentId, 'info', 'Manual trigger completed')
  }

  /**
   * Get agent status summary - compiled from daemon state and recent logs
   */
  getAgentStatus(agentId: string): AgentStatusSummary | null {
    const agent = this.stateManager?.getAgent(agentId)
    if (!agent) return null

    const logs = this.agentLogs.get(agentId) || []
    const daemon = this.daemons.get(agentId)

    // Determine current phase from most recent log with phase info
    let currentPhase: AgentStatusSummary['currentPhase'] = 'idle'
    let lastDecision: AgentStatusSummary['lastDecision'] | undefined
    let lastTerminalSnapshot: string | undefined
    let lastTerminalState: AgentStatusSummary['lastTerminalState'] | undefined

    // Scan recent logs in reverse to find latest structured data
    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i]
      const details = log.details as Record<string, unknown> | undefined

      if (!details?.phase) continue

      // Get current phase from most recent log
      if (currentPhase === 'idle') {
        currentPhase = details.phase as AgentStatusSummary['currentPhase']
      }

      // Get last decision
      if (!lastDecision && details.phase === 'decide' && details.decision) {
        const d = details.decision as Record<string, unknown>
        lastDecision = {
          action: d.action as string,
          reason: d.reason as string,
          confidence: d.confidence as number,
          response: d.response as string | undefined,
          timestamp: log.timestamp,
        }
      }

      // Get last terminal snapshot
      if (!lastTerminalSnapshot && details.terminalSnapshot) {
        lastTerminalSnapshot = details.terminalSnapshot as string
      }

      // Get last terminal state
      if (!lastTerminalState && details.terminalState) {
        lastTerminalState = details.terminalState as AgentStatusSummary['lastTerminalState']
      }

      // Stop scanning once we have everything
      if (lastDecision && lastTerminalSnapshot && lastTerminalState) break
    }

    // If agent is not connected or not running, phase is idle
    if (!agent.connection || agent.status === 'idle') {
      currentPhase = 'idle'
    }

    // Calculate stats
    let totalActions = 0
    let totalErrors = 0
    for (const log of logs) {
      if (log.level === 'action') totalActions++
      if (log.level === 'error') totalErrors++
    }

    // Get processing duration from daemon
    let processingDuration: number | undefined
    let consecutiveWaits = 0
    if (daemon) {
      const pState = daemon.getProcessingState()
      consecutiveWaits = pState.consecutiveWaits
      if (pState.isProcessing) {
        processingDuration = Date.now() - pState.processingStartedAt
      }
    }

    return {
      agent,
      currentPhase,
      lastDecision,
      lastTerminalSnapshot,
      lastTerminalState,
      processingDuration,
      stats: {
        totalEvents: logs.length,
        totalActions,
        totalErrors,
        consecutiveWaits,
      },
    }
  }

  /**
   * Get agents connected to a specific project
   */
  getAgentsByProject(projectPath: string): Agent[] {
    return this.stateManager?.getAgentsByProject(projectPath) || []
  }

  /**
   * Get running agents
   */
  getRunningAgents(): Agent[] {
    return Array.from(this.daemons.keys())
      .map(id => this.stateManager?.getAgent(id))
      .filter((a): a is Agent => a !== null)
  }

  /**
   * Check if agent manager is initialized
   */
  isReady(): boolean {
    return this.isInitialized
  }

  /**
   * Add a log entry for an agent
   */
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

    // Also log to system logger
    if (level === 'error') {
      logger.error(`[Agent ${agentId}] ${message}`)
    } else if (level === 'warn') {
      logger.warn(`[Agent ${agentId}] ${message}`)
    } else {
      logger.debug(`[Agent ${agentId}] ${message}`)
    }
  }

  /**
   * Get logs for an agent
   */
  getAgentLogs(agentId: string): AgentLogEntry[] {
    return this.agentLogs.get(agentId) || []
  }

  /**
   * Clear logs for an agent
   */
  clearAgentLogs(agentId: string): void {
    this.agentLogs.set(agentId, [])
  }

  /**
   * Shutdown the agent manager
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down AgentManager')

    // Stop all daemons
    for (const [agentId] of this.daemons) {
      await this.stopAgent(agentId)
    }

    // Stop hook server
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
