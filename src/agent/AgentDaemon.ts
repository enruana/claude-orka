/**
 * AgentDaemon - Individual agent process that monitors and responds to Claude Code sessions
 *
 * FLOW:
 * 1. Hook event received (Stop, SessionStart, etc.)
 * 2. Check if we should act (cooldown, not already processing, etc.)
 * 3. Capture terminal content
 * 4. Analyze with Claude AI (show reasoning in logs)
 * 5. Execute decision
 * 6. Wait for next event
 */

import { EventEmitter } from 'events'
import { logger } from '../utils'
import { Agent } from '../models/Agent'
import { ProcessedHookEvent } from '../models/HookEvent'
import { TerminalReader, TerminalState } from './TerminalReader'
import { getAgentStateManager, AgentStateManager } from './AgentStateManager'
import { NotificationService } from './NotificationService'
import { ClaudeAnalyzer, DecisionRecord } from './ClaudeAnalyzer'
import type { AgentManager } from './AgentManager'

/**
 * Response from agent analysis
 */
export interface AgentResponse {
  action: 'respond' | 'approve' | 'reject' | 'wait' | 'request_help' | 'compact' | 'escape'
  response?: string
  reason: string
  notifyHuman: boolean
}

/**
 * Agent processing state
 */
interface ProcessingState {
  isProcessing: boolean
  lastResponseTime: number
  lastEventType: string | null
  consecutiveWaits: number
}

// Minimum time between responses (ms) to avoid loops
const MIN_RESPONSE_INTERVAL = 3000

// Maximum consecutive "wait" decisions before requesting help
const MAX_CONSECUTIVE_WAITS = 10

/**
 * AgentDaemon runs an individual agent that monitors and controls Claude Code sessions
 */
export class AgentDaemon extends EventEmitter {
  private agent: Agent
  private stateManager: AgentStateManager | null = null
  private notificationService: NotificationService
  private isRunning: boolean = false
  private decisionHistory: DecisionRecord[] = []
  private processingState: ProcessingState = {
    isProcessing: false,
    lastResponseTime: 0,
    lastEventType: null,
    consecutiveWaits: 0,
  }

  constructor(agent: Agent) {
    super()
    this.agent = agent
    this.notificationService = new NotificationService()
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

  /**
   * Handle a hook event - main entry point
   */
  async handleHookEvent(event: ProcessedHookEvent, manager?: AgentManager): Promise<void> {
    const log = this.createLogger(manager)

    // === PHASE 1: Pre-flight checks ===
    if (!this.isRunning) {
      log('warn', '⚠️ Agent is not running, ignoring event')
      return
    }

    if (this.processingState.isProcessing) {
      log('warn', '⚠️ Already processing an event, ignoring')
      return
    }

    // Check cooldown
    const timeSinceLastResponse = Date.now() - this.processingState.lastResponseTime
    if (timeSinceLastResponse < MIN_RESPONSE_INTERVAL && this.processingState.lastResponseTime > 0) {
      log('debug', `⏳ Cooldown active (${Math.round(timeSinceLastResponse/1000)}s since last response), waiting...`)
      return
    }

    this.processingState.isProcessing = true
    this.processingState.lastEventType = event.payload.event_type

    try {
      log('info', `\n${'='.repeat(50)}`)
      log('info', `📥 HOOK RECEIVED: ${event.payload.event_type}`)
      log('info', `${'='.repeat(50)}`)

      // === PHASE 2: Capture terminal state ===
      log('info', '📸 Capturing terminal content...')
      const terminalContent = await this.captureTargetTerminal()

      if (!terminalContent) {
        log('error', '❌ Could not capture terminal - no pane ID or connection')
        return
      }

      log('info', `✅ Captured ${terminalContent.content.length} chars from pane ${terminalContent.paneId}`)

      // Show last few lines of terminal for context
      const lastLines = terminalContent.content.split('\n').slice(-10).join('\n')
      log('debug', `📄 Terminal tail:\n${lastLines}`)

      // === PHASE 3: Quick checks before AI analysis ===
      const terminalState = TerminalReader.parseState(terminalContent.content)

      log('info', '🔍 Terminal state analysis:', {
        isProcessing: terminalState.isProcessing,
        isWaitingForInput: terminalState.isWaitingForInput,
        hasPermissionPrompt: terminalState.hasPermissionPrompt,
        hasError: !!terminalState.error,
      })

      // If Claude is still processing (spinner visible), don't interrupt
      if (ClaudeAnalyzer.isProcessing(terminalContent.content)) {
        log('info', '⏳ Claude is still working (spinner detected) - waiting')
        this.processingState.consecutiveWaits++
        return
      }

      // === PHASE 4: Decision making ===
      const response = await this.makeDecision(
        terminalState,
        terminalContent.content,
        event,
        log
      )

      // Record decision in rolling history
      this.decisionHistory.push({
        timestamp: new Date(),
        eventType: event.payload.event_type,
        action: response.action,
        reason: response.reason,
        response: response.response,
      })
      const maxHistory = this.agent.decisionHistorySize || 5
      if (this.decisionHistory.length > maxHistory) {
        this.decisionHistory = this.decisionHistory.slice(-maxHistory)
      }

      // === PHASE 5: Execute the decision ===
      if (response.action !== 'wait') {
        log('info', `\n${'─'.repeat(40)}`)
        log('action', `🎯 EXECUTING: ${response.action.toUpperCase()}`)
        log('info', `📝 Reason: ${response.reason}`)
        if (response.response) {
          log('info', `💬 Message: "${response.response}"`)
        }
        log('info', `${'─'.repeat(40)}\n`)

        await this.executeResponse(response, terminalContent.paneId, manager)
        this.processingState.lastResponseTime = Date.now()
        this.processingState.consecutiveWaits = 0
      } else {
        this.processingState.consecutiveWaits++
        log('debug', `😴 Waiting... (consecutive waits: ${this.processingState.consecutiveWaits})`)

        // If we've waited too many times, something might be wrong
        if (this.processingState.consecutiveWaits >= MAX_CONSECUTIVE_WAITS) {
          log('warn', `⚠️ Too many consecutive waits (${MAX_CONSECUTIVE_WAITS}), requesting human help`)
          await this.executeResponse({
            action: 'request_help',
            reason: 'Agent has been waiting too long without progress',
            notifyHuman: true,
          }, terminalContent.paneId, manager)
        }
      }

    } catch (error: any) {
      log('error', `❌ Error: ${error.message}`)
      this.emit('error', error)
      if (this.stateManager) {
        await this.stateManager.updateAgentStatus(this.agent.id, 'error', error.message)
      }
    } finally {
      this.processingState.isProcessing = false
    }
  }

  /**
   * Make a decision about what to do
   */
  private async makeDecision(
    terminalState: TerminalState,
    terminalContent: string,
    event: ProcessedHookEvent,
    log: ReturnType<typeof this.createLogger>
  ): Promise<AgentResponse> {

    // Check response limit
    if (this.agent.maxConsecutiveResponses !== -1 &&
        this.agent.consecutiveResponses >= this.agent.maxConsecutiveResponses) {
      log('warn', `🛑 Reached max responses (${this.agent.maxConsecutiveResponses})`)
      return {
        action: 'request_help',
        reason: `Reached maximum consecutive responses (${this.agent.maxConsecutiveResponses})`,
        notifyHuman: true,
      }
    }

    // Fast path: Auto-approve permission prompts
    if (terminalState.hasPermissionPrompt && this.agent.autoApprove) {
      if (ClaudeAnalyzer.isSimpleApprovalPrompt(terminalContent)) {
        log('action', '✅ Auto-approving permission prompt (fast path)')
        return {
          action: 'approve',
          reason: 'Auto-approve enabled for permission prompts',
          notifyHuman: false,
        }
      }
    }

    // === AI Analysis ===
    log('info', '\n🤖 ANALYZING with Claude AI...')
    log('info', '📋 Master Prompt:', { prompt: this.agent.masterPrompt.substring(0, 100) + '...' })

    try {
      const analyzer = new ClaudeAnalyzer(
        this.agent.masterPrompt,
        this.agent.connection?.projectPath || ''
      )

      // Get event-specific data
      const eventData: Record<string, unknown> = {
        ...event.payload.stop_data,
        ...event.payload.compact_data,
        ...event.payload.session_start_data,
        ...event.payload.session_end_data,
        ...event.payload.notification_data,
      }

      const analysis = await analyzer.analyze(
        terminalContent,
        event.payload.event_type,
        eventData,
        this.decisionHistory
      )

      // Log the AI's reasoning
      log('info', '\n💭 AI REASONING:')
      log('info', `   Action: ${analysis.action}`)
      log('info', `   Confidence: ${(analysis.confidence * 100).toFixed(0)}%`)
      log('info', `   Reason: ${analysis.reason}`)
      if (analysis.response) {
        log('info', `   Response: "${analysis.response}"`)
      }

      // Low confidence check
      if (analysis.confidence < 0.3 && analysis.action !== 'wait') {
        log('warn', `⚠️ Low confidence (${(analysis.confidence * 100).toFixed(0)}%), requesting human help`)
        return {
          action: 'request_help',
          reason: `Low confidence: ${analysis.reason}`,
          notifyHuman: true,
        }
      }

      return {
        action: analysis.action === 'escape' ? 'wait' : analysis.action,
        response: analysis.response,
        reason: analysis.reason,
        notifyHuman: analysis.notifyHuman,
      }

    } catch (error: any) {
      log('error', `❌ AI analysis failed: ${error.message}`)
      return this.fallbackDecision(terminalState, terminalContent, log)
    }
  }

  /**
   * Fallback decision when AI fails
   */
  private fallbackDecision(
    terminalState: TerminalState,
    terminalContent: string,
    log: ReturnType<typeof this.createLogger>
  ): AgentResponse {
    log('warn', '🔧 Using fallback heuristics...')

    if (terminalState.error) {
      return {
        action: 'request_help',
        reason: `Error detected: ${terminalState.error}`,
        notifyHuman: true,
      }
    }

    if (terminalState.hasPermissionPrompt && this.agent.autoApprove) {
      return {
        action: 'approve',
        reason: 'Fallback: Auto-approve permission',
        notifyHuman: false,
      }
    }

    const lastLines = terminalContent.split('\n').slice(-20).join('\n').toLowerCase()
    if (lastLines.includes('continue') || lastLines.includes('proceed')) {
      return {
        action: 'respond',
        response: 'continue',
        reason: 'Fallback: Detected continuation prompt',
        notifyHuman: false,
      }
    }

    return {
      action: 'request_help',
      reason: 'Fallback: Could not determine action',
      notifyHuman: true,
    }
  }

  /**
   * Execute the decided response
   */
  private async executeResponse(
    response: AgentResponse,
    paneId: string,
    manager?: AgentManager
  ): Promise<void> {
    const log = this.createLogger(manager)

    switch (response.action) {
      case 'respond':
        if (response.response) {
          log('action', `📤 Sending: "${response.response}"`)
          await TerminalReader.sendTextWithEnter(paneId, response.response)
          this.emit('responseGenerated', response.response)

          if (this.stateManager) {
            await this.stateManager.incrementResponseCount(this.agent.id)
            const newCount = this.agent.consecutiveResponses + 1
            const max = this.agent.maxConsecutiveResponses
            log('info', `📊 Response count: ${newCount}/${max === -1 ? '∞' : max}`)
          }
        }
        break

      case 'approve':
        log('action', '✅ Sending: y (approve)')
        await TerminalReader.sendApproval(paneId)
        break

      case 'reject':
        log('action', '❌ Sending: n (reject)')
        await TerminalReader.sendRejection(paneId)
        break

      case 'compact':
        log('action', '📦 Sending: /compact')
        await TerminalReader.sendCompact(paneId)
        break

      case 'escape':
        log('action', '⎋ Sending: Escape')
        await TerminalReader.sendEscape(paneId)
        break

      case 'request_help':
        log('warn', `🆘 REQUESTING HUMAN HELP: ${response.reason}`)
        this.emit('humanHelpRequested', response.reason)
        if (this.stateManager) {
          await this.stateManager.updateAgentStatus(this.agent.id, 'waiting_human')
        }
        break

      case 'wait':
        log('debug', '💤 No action needed')
        break
    }

    if (response.notifyHuman) {
      log('info', '🔔 Sending notification to human')
      await this.notificationService.sendNotification(
        this.agent,
        `Agent ${this.agent.name}`,
        response.reason
      )
    }
  }

  /**
   * Capture terminal content
   */
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

  /**
   * Create a logger function bound to this agent
   */
  private createLogger(manager?: AgentManager) {
    return (
      level: 'info' | 'warn' | 'error' | 'debug' | 'action',
      message: string,
      details?: Record<string, unknown>
    ) => {
      manager?.addAgentLog(this.agent.id, level, message, details)
    }
  }

  async resumeFromHuman(): Promise<void> {
    if (this.agent.status !== 'waiting_human') {
      return
    }

    if (this.stateManager) {
      await this.stateManager.resetResponseCount(this.agent.id)
      await this.stateManager.updateAgentStatus(this.agent.id, 'active')
    }

    this.processingState.consecutiveWaits = 0
    logger.info(`Agent ${this.agent.id} resumed from waiting_human state`)
  }

  getAgent(): Agent {
    return this.agent
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
