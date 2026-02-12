/**
 * AgentDaemon - Individual agent process that monitors and responds to Claude Code sessions
 *
 * Phase 1: Minimal hardcoded decision logic (no AI analysis)
 *
 * FLOW:
 * 1. Hook event received (Stop, SessionStart, etc.)
 * 2. Check guards (isRunning, cooldown, not already processing)
 * 3. Capture terminal content
 * 4. Parse terminal state
 * 5. Hardcoded decision: waiting → "continue", permission → approve, processing → wait
 * 6. Execute decision
 */

import { EventEmitter } from 'events'
import { logger } from '../utils'
import { Agent } from '../models/Agent'
import { ProcessedHookEvent } from '../models/HookEvent'
import { TerminalReader, TerminalState } from './TerminalReader'
import { getAgentStateManager, AgentStateManager } from './AgentStateManager'
import type { AgentManager } from './AgentManager'

export interface AgentResponse {
  action: 'respond' | 'approve' | 'reject' | 'wait' | 'request_help' | 'compact' | 'escape'
  response?: string
  reason: string
}

interface ProcessingState {
  isProcessing: boolean
  processingStartedAt: number
  lastResponseTime: number
  lastEventType: string | null
}

// Minimum time between responses (ms) to avoid loops
const MIN_RESPONSE_INTERVAL = 3000

// Maximum time (ms) an event can be processing before auto-reset
const MAX_PROCESSING_TIME = 120_000

export class AgentDaemon extends EventEmitter {
  private agent: Agent
  private stateManager: AgentStateManager | null = null
  private isRunning: boolean = false
  private processingState: ProcessingState = {
    isProcessing: false,
    processingStartedAt: 0,
    lastResponseTime: 0,
    lastEventType: null,
  }

  constructor(agent: Agent) {
    super()
    this.agent = agent
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
    const log = this.createLogger(manager)

    // === Guard checks ===
    if (!this.isRunning) {
      log('warn', 'Agent is not running, ignoring event')
      return
    }

    if (this.processingState.isProcessing) {
      const elapsed = Date.now() - this.processingState.processingStartedAt
      if (elapsed < MAX_PROCESSING_TIME) {
        log('warn', `Already processing an event (${Math.round(elapsed / 1000)}s), ignoring`)
        return
      }
      log('warn', `Processing stuck for ${Math.round(elapsed / 1000)}s, force-resetting`)
      this.processingState.isProcessing = false
    }

    // Check cooldown
    const timeSinceLastResponse = Date.now() - this.processingState.lastResponseTime
    if (timeSinceLastResponse < MIN_RESPONSE_INTERVAL && this.processingState.lastResponseTime > 0) {
      log('debug', `Cooldown active, waiting...`)
      return
    }

    this.processingState.isProcessing = true
    this.processingState.processingStartedAt = Date.now()
    this.processingState.lastEventType = event.payload.event_type

    try {
      log('info', `Hook: ${event.payload.event_type} [session: ${(event.payload.session_id || 'none').slice(0, 8)}]`)

      // === Handle PreCompact ===
      if (event.payload.event_type === 'PreCompact') {
        const trigger = event.payload.compact_data?.trigger || 'manual'
        log('info', `PreCompact event (trigger: ${trigger})`)
        return
      }

      // === Handle SessionEnd ===
      if (event.payload.event_type === 'SessionEnd') {
        log('warn', `Session ended: ${event.payload.session_end_data?.reason || 'unknown'}`)
        return
      }

      // === Handle PostToolUseFailure ===
      if (event.payload.event_type === 'PostToolUseFailure') {
        log('warn', `Tool failed: ${event.payload.tool_failure_data?.tool_name || 'unknown'}`)
        return
      }

      // === Capture terminal ===
      const terminalContent = await this.captureTargetTerminal()

      if (!terminalContent) {
        log('error', 'Could not capture terminal - no pane ID or connection')
        return
      }

      const lines = terminalContent.content.split('\n')
      log('info', `Terminal captured (${terminalContent.content.length} chars, ${lines.length} lines)`)

      // === Parse terminal state ===
      const terminalState = TerminalReader.parseState(terminalContent.content)

      log('info', `State: ${terminalState.isWaitingForInput ? 'waiting' : terminalState.isProcessing ? 'processing' : terminalState.hasPermissionPrompt ? 'permission' : 'other'}`)

      // === Context limit fast-path ===
      if (terminalState.hasContextLimit) {
        const isZeroPercent = /0%\s*remaining/i.test(terminalContent.content)
        const compactFailed = /compaction.*error|conversation too long/i.test(terminalContent.content)

        if (isZeroPercent || compactFailed) {
          log('warn', 'Context exhausted! Sending /clear.')
          await TerminalReader.sendClear(terminalContent.paneId)
        } else {
          log('warn', 'Context limit reached! Sending /compact.')
          await TerminalReader.sendCompact(terminalContent.paneId)
        }
        this.processingState.lastResponseTime = Date.now()
        return
      }

      // === If processing, wait ===
      if (terminalState.isProcessing) {
        log('info', 'Claude still working - waiting')
        return
      }

      // === If not waiting for input, skip ===
      if (!terminalState.isWaitingForInput && !terminalState.hasPermissionPrompt) {
        log('info', 'Terminal state unclear - skipping')
        return
      }

      // === Hardcoded decision ===
      const response = this.makeHardcodedDecision(terminalState, terminalContent.content)

      // === Execute ===
      if (response.action !== 'wait') {
        log('action', `Executing: ${response.action}${response.response ? ` -> "${response.response}"` : ''} (${response.reason})`)
        await this.executeResponse(response, terminalContent.paneId)
        this.processingState.lastResponseTime = Date.now()
      } else {
        log('debug', `Waiting: ${response.reason}`)
      }

    } catch (error: any) {
      log('error', `Error: ${error.message}`)
      this.emit('error', error)
      if (this.stateManager) {
        await this.stateManager.updateAgentStatus(this.agent.id, 'error', error.message)
      }
    } finally {
      this.processingState.isProcessing = false
    }
  }

  private makeHardcodedDecision(
    terminalState: TerminalState,
    _terminalContent: string
  ): AgentResponse {
    // Permission prompt → approve
    if (terminalState.hasPermissionPrompt) {
      return {
        action: 'approve',
        reason: 'Permission prompt detected',
      }
    }

    // Waiting for input → send "continue"
    if (terminalState.isWaitingForInput) {
      return {
        action: 'respond',
        response: 'continue',
        reason: 'Claude waiting for input',
      }
    }

    return {
      action: 'wait',
      reason: 'No action needed',
    }
  }

  private async executeResponse(
    response: AgentResponse,
    paneId: string
  ): Promise<void> {
    switch (response.action) {
      case 'respond':
        if (response.response) {
          await TerminalReader.sendTextWithEnter(paneId, response.response)
        }
        break
      case 'approve':
        await TerminalReader.sendApproval(paneId)
        break
      case 'reject':
        await TerminalReader.sendRejection(paneId)
        break
      case 'compact':
        await TerminalReader.sendCompact(paneId)
        break
      case 'escape':
        await TerminalReader.sendEscape(paneId)
        break
      case 'request_help':
      case 'wait':
        break
    }
  }

  private async captureTargetTerminal(): Promise<{ content: string; paneId: string } | null> {
    if (!this.agent.connection?.tmuxPaneId) {
      return null
    }

    try {
      const content = await TerminalReader.capture(
        this.agent.connection.tmuxPaneId,
        this.agent.connection.sessionId || 'unknown'
      )
      return {
        content: content.content,
        paneId: this.agent.connection.tmuxPaneId,
      }
    } catch (error: any) {
      logger.error(`Failed to capture terminal: ${error.message}`)
      return null
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

  getProcessingState(): ProcessingState {
    return { ...this.processingState }
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
