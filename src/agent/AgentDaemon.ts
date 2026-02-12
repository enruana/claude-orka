/**
 * AgentDaemon - Individual agent process that monitors and responds to Claude Code sessions
 *
 * Delegates all event processing to EventStateMachine.
 * Owns lifecycle (start/stop/refresh) and logging.
 */

import { EventEmitter } from 'events'
import { logger } from '../utils'
import { Agent } from '../models/Agent'
import { ProcessedHookEvent } from '../models/HookEvent'
import { getAgentStateManager, AgentStateManager } from './AgentStateManager'
import { EventStateMachine } from './EventStateMachine'
import type { AgentManager } from './AgentManager'

export class AgentDaemon extends EventEmitter {
  private agent: Agent
  private stateManager: AgentStateManager | null = null
  private isRunning: boolean = false
  private stateMachine: EventStateMachine

  constructor(agent: Agent) {
    super()
    this.agent = agent
    this.stateMachine = new EventStateMachine(() => this.agent)
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn(`Agent ${this.agent.id} is already running`)
      return
    }

    this.stateManager = await getAgentStateManager()
    logger.info(`Starting agent daemon: ${this.agent.name} (${this.agent.id})`)

    try {
      await this.stateManager.updateAgentStatus(this.agent.id, 'active')
      this.isRunning = true
      this.emit('started')
      logger.info(`Agent daemon started: ${this.agent.id}`)
    } catch (error: any) {
      logger.error(`Failed to start agent daemon: ${error.message}`)
      await this.stateManager?.updateAgentStatus(this.agent.id, 'error', error.message)
      throw error
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return

    logger.info(`Stopping agent daemon: ${this.agent.id}`)

    if (this.stateManager) {
      await this.stateManager.updateAgentStatus(this.agent.id, 'idle')
    }

    this.isRunning = false
    this.emit('stopped')
    logger.info(`Agent daemon stopped: ${this.agent.id}`)
  }

  async handleHookEvent(event: ProcessedHookEvent, manager?: AgentManager): Promise<void> {
    if (!this.isRunning) {
      this.createLogger(manager)('warn', 'Agent is not running, ignoring event')
      return
    }

    const log = this.createLogger(manager)

    try {
      await this.stateMachine.run(event, log)
    } catch (error: any) {
      log('error', `Error: ${error.message}`)
      this.emit('error', error)
      if (this.stateManager) {
        await this.stateManager.updateAgentStatus(this.agent.id, 'error', error.message)
      }
    }
  }

  private createLogger(manager?: AgentManager) {
    return (
      level: 'info' | 'warn' | 'error' | 'debug' | 'action',
      message: string,
      details?: Record<string, unknown>
    ) => {
      manager?.addAgentLog(this.agent.id, level, message, details)
    }
  }

  getAgent(): Agent {
    return this.agent
  }

  getProcessingState() {
    return this.stateMachine.getProcessingState()
  }

  getStateMachine(): EventStateMachine {
    return this.stateMachine
  }

  isActive(): boolean {
    return this.isRunning
  }

  async refresh(): Promise<void> {
    if (this.stateManager) {
      const agent = this.stateManager.getAgent(this.agent.id)
      if (agent) {
        this.agent = agent
      }
    }
  }
}
