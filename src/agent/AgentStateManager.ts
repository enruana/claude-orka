/**
 * AgentStateManager - Manages agent persistence in ~/.claude-orka/agents.json
 */

import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { nanoid } from 'nanoid'
import { logger } from '../utils'
import {
  Agent,
  AgentState,
  AgentStatus,
  AgentHookTrigger,
  NotificationConfig,
  AgentConnection,
  DEFAULT_AGENT_STATE,
  createAgent,
} from '../models/Agent'

/**
 * Manages agent state stored in ~/.claude-orka/agents.json
 */
export class AgentStateManager {
  private configDir: string
  private statePath: string
  private state: AgentState | null = null

  constructor() {
    this.configDir = path.join(os.homedir(), '.claude-orka')
    this.statePath = path.join(this.configDir, 'agents.json')
  }

  /**
   * Initialize the agent state manager
   */
  async initialize(): Promise<void> {
    await fs.ensureDir(this.configDir)

    if (await fs.pathExists(this.statePath)) {
      try {
        this.state = await fs.readJson(this.statePath)
        logger.debug('Loaded agent state from ~/.claude-orka/agents.json')
      } catch (error) {
        logger.warn('Failed to parse agent state, creating new one')
        this.state = { ...DEFAULT_AGENT_STATE }
        await this.save()
      }
    } else {
      this.state = { ...DEFAULT_AGENT_STATE }
      await this.save()
      logger.info('Created new agent state at ~/.claude-orka/agents.json')
    }
  }

  /**
   * Save state to disk
   */
  private async save(): Promise<void> {
    if (!this.state) return
    this.state.lastUpdated = new Date().toISOString()
    await fs.writeJson(this.statePath, this.state, { spaces: 2 })
  }

  /**
   * Get current state
   */
  getState(): AgentState {
    if (!this.state) {
      throw new Error('AgentStateManager not initialized')
    }
    return this.state
  }

  /**
   * Get all agents
   */
  getAgents(): Agent[] {
    return this.getState().agents
  }

  /**
   * Get agent by ID
   */
  getAgent(agentId: string): Agent | null {
    return this.getAgents().find(a => a.id === agentId) || null
  }

  /**
   * Get agents by status
   */
  getAgentsByStatus(status: AgentStatus): Agent[] {
    return this.getAgents().filter(a => a.status === status)
  }

  /**
   * Get agents connected to a project
   */
  getAgentsByProject(projectPath: string): Agent[] {
    const normalizedPath = path.resolve(projectPath)
    return this.getAgents().filter(
      a => a.connection && path.resolve(a.connection.projectPath) === normalizedPath
    )
  }

  /**
   * Create a new agent
   */
  async createAgent(
    name: string,
    masterPrompt: string,
    options: Partial<Agent> = {}
  ): Promise<Agent> {
    const id = `agent-${nanoid(8)}`
    const agent = createAgent(id, name, masterPrompt, options)

    this.state!.agents.push(agent)
    await this.save()

    logger.info(`Created agent: ${agent.name} (${agent.id})`)
    return agent
  }

  /**
   * Update an agent
   */
  async updateAgent(agentId: string, updates: Partial<Agent>): Promise<Agent> {
    const index = this.state!.agents.findIndex(a => a.id === agentId)
    if (index === -1) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    // Don't allow changing ID or createdAt
    delete updates.id
    delete updates.createdAt

    this.state!.agents[index] = {
      ...this.state!.agents[index],
      ...updates,
      lastActivity: new Date().toISOString(),
    }

    await this.save()
    logger.debug(`Updated agent: ${agentId}`)
    return this.state!.agents[index]
  }

  /**
   * Update agent status
   */
  async updateAgentStatus(
    agentId: string,
    status: AgentStatus,
    error?: string
  ): Promise<Agent> {
    const updates: Partial<Agent> = { status }
    if (error) {
      updates.lastError = error
    } else if (status !== 'error') {
      updates.lastError = undefined
    }
    return this.updateAgent(agentId, updates)
  }

  /**
   * Connect agent to a project
   */
  async connectAgent(
    agentId: string,
    projectPath: string,
    sessionId?: string,
    tmuxPaneId?: string,
    claudeSessionId?: string,
    branchId?: string
  ): Promise<Agent> {
    const connection: AgentConnection = {
      projectPath: path.resolve(projectPath),
      sessionId,
      tmuxPaneId,
      claudeSessionId,
      branchId,
      connectedAt: new Date().toISOString(),
    }

    return this.updateAgent(agentId, {
      connection,
      status: 'active',
    })
  }

  /**
   * Disconnect agent from project
   */
  async disconnectAgent(agentId: string): Promise<Agent> {
    return this.updateAgent(agentId, {
      connection: undefined,
      status: 'idle',
    })
  }

  /**
   * Set agent's Claude session
   */
  async setAgentSession(
    agentId: string,
    claudeSessionId: string,
    tmuxSessionId: string,
    tmuxPaneId: string
  ): Promise<Agent> {
    return this.updateAgent(agentId, {
      claudeSessionId,
      tmuxSessionId,
      tmuxPaneId,
    })
  }

  /**
   * Increment consecutive response count
   */
  async incrementResponseCount(agentId: string): Promise<Agent> {
    const agent = this.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const newCount = (agent.consecutiveResponses || 0) + 1
    if (newCount >= agent.maxConsecutiveResponses) {
      return this.updateAgent(agentId, {
        consecutiveResponses: newCount,
        status: 'waiting_human',
      })
    }

    return this.updateAgent(agentId, {
      consecutiveResponses: newCount,
    })
  }

  /**
   * Reset consecutive response count
   */
  async resetResponseCount(agentId: string): Promise<Agent> {
    return this.updateAgent(agentId, {
      consecutiveResponses: 0,
    })
  }

  /**
   * Update agent hook events
   */
  async updateHookEvents(agentId: string, hookEvents: AgentHookTrigger[]): Promise<Agent> {
    return this.updateAgent(agentId, { hookEvents })
  }

  /**
   * Update agent notifications config
   */
  async updateNotifications(agentId: string, notifications: NotificationConfig): Promise<Agent> {
    return this.updateAgent(agentId, { notifications })
  }

  /**
   * Delete an agent
   */
  async deleteAgent(agentId: string): Promise<boolean> {
    const index = this.state!.agents.findIndex(a => a.id === agentId)
    if (index === -1) {
      return false
    }

    const removed = this.state!.agents.splice(index, 1)[0]
    await this.save()

    logger.info(`Deleted agent: ${removed.name} (${removed.id})`)
    return true
  }

  /**
   * Get hook server port
   */
  getHookServerPort(): number {
    return this.getState().hookServerPort
  }

  /**
   * Set hook server port
   */
  async setHookServerPort(port: number): Promise<void> {
    this.state!.hookServerPort = port
    await this.save()
  }

  /**
   * Get config directory path
   */
  getConfigDir(): string {
    return this.configDir
  }

  /**
   * Get state file path
   */
  getStatePath(): string {
    return this.statePath
  }
}

// Singleton instance
let agentStateManager: AgentStateManager | null = null

export async function getAgentStateManager(): Promise<AgentStateManager> {
  if (!agentStateManager) {
    agentStateManager = new AgentStateManager()
    await agentStateManager.initialize()
  }
  return agentStateManager
}
