/**
 * AgentStateManager - Manages agent persistence in ~/.claude-orka/agents.json
 *
 * Phase 1: Minimal CRUD operations
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
  AgentConnection,
  DEFAULT_AGENT_STATE,
  createAgent,
} from '../models/Agent'

export class AgentStateManager {
  private configDir: string
  private statePath: string
  private state: AgentState | null = null

  constructor() {
    this.configDir = path.join(os.homedir(), '.claude-orka')
    this.statePath = path.join(this.configDir, 'agents.json')
  }

  async initialize(): Promise<void> {
    await fs.ensureDir(this.configDir)

    if (await fs.pathExists(this.statePath)) {
      try {
        this.state = await fs.readJson(this.statePath)
        logger.debug('Loaded agent state from ~/.claude-orka/agents.json')
      } catch {
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

  private async save(): Promise<void> {
    if (!this.state) return
    this.state.lastUpdated = new Date().toISOString()
    await fs.writeJson(this.statePath, this.state, { spaces: 2 })
  }

  getState(): AgentState {
    if (!this.state) {
      throw new Error('AgentStateManager not initialized')
    }
    return this.state
  }

  getAgents(): Agent[] {
    return this.getState().agents
  }

  getAgent(agentId: string): Agent | null {
    return this.getAgents().find(a => a.id === agentId) || null
  }

  getAgentsByProject(projectPath: string): Agent[] {
    const normalizedPath = path.resolve(projectPath)
    return this.getAgents().filter(
      a => a.connection && path.resolve(a.connection.projectPath) === normalizedPath
    )
  }

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

  async updateAgent(agentId: string, updates: Partial<Agent>): Promise<Agent> {
    const index = this.state!.agents.findIndex(a => a.id === agentId)
    if (index === -1) {
      throw new Error(`Agent not found: ${agentId}`)
    }

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

    return this.updateAgent(agentId, { connection })
  }

  async disconnectAgent(agentId: string): Promise<Agent> {
    return this.updateAgent(agentId, {
      connection: undefined,
      status: 'idle',
    })
  }

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

  getHookServerPort(): number {
    return this.getState().hookServerPort
  }

  getConfigDir(): string {
    return this.configDir
  }

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
