/**
 * AgentDaemon - Individual agent process that monitors and responds to Claude Code sessions
 *
 * Delegates all event processing to EventStateMachine.
 * Owns lifecycle (start/stop/refresh), logging, and per-agent TelegramBot.
 */

import { EventEmitter } from 'events'
import { logger } from '../utils'
import { Agent } from '../models/Agent'
import { ProcessedHookEvent } from '../models/HookEvent'
import { getAgentStateManager, AgentStateManager } from './AgentStateManager'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { EventStateMachine } from './EventStateMachine'
import { TelegramBot } from './TelegramBot'
import { TerminalReader } from './TerminalReader'
import { TerminalWatchdog } from './TerminalWatchdog'
import type { AgentManager } from './AgentManager'

export class AgentDaemon extends EventEmitter {
  private agent: Agent
  private stateManager: AgentStateManager | null = null
  private isRunning: boolean = false
  private stateMachine: EventStateMachine
  private telegramBot: TelegramBot | null = null
  private watchdog: TerminalWatchdog | null = null
  private manager: AgentManager | null = null

  constructor(agent: Agent) {
    super()
    this.agent = agent
    this.stateMachine = new EventStateMachine(
      () => this.agent,
      () => this.telegramBot
    )
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

      // Start per-agent Telegram bot if configured
      await this.startTelegramBot()

      // Start terminal watchdog for stall detection
      this.startWatchdog()

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

    // Stop watchdog before Telegram bot (watchdog may send notifications)
    this.stopWatchdog()

    // Stop Telegram bot
    await this.stopTelegramBot()

    if (this.stateManager) {
      await this.stateManager.updateAgentStatus(this.agent.id, 'idle')
    }

    this.isRunning = false
    this.emit('stopped')
    logger.info(`Agent daemon stopped: ${this.agent.id}`)
  }

  async handleHookEvent(event: ProcessedHookEvent, manager?: AgentManager): Promise<void> {
    if (manager) this.manager = manager

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

  // -----------------------------------------------------------------------
  // Telegram Bot lifecycle
  // -----------------------------------------------------------------------

  private async startTelegramBot(): Promise<void> {
    if (!this.agent.telegram?.enabled) return

    try {
      this.telegramBot = new TelegramBot(this.agent.id, this.agent.name, this.agent.telegram)
      this.telegramBot.setTerminalProvider({
        captureTerminal: async (lines?: number) => {
          const paneId = this.agent.connection?.tmuxPaneId
          if (!paneId) return null
          try {
            const content = await TerminalReader.capture(paneId, this.agent.connection?.sessionId || 'unknown', lines || 50)
            return content.content
          } catch {
            return null
          }
        },
        sendText: async (text: string) => {
          const paneId = this.agent.connection?.tmuxPaneId
          if (!paneId) return false
          try {
            await TerminalReader.sendTextWithEnter(paneId, text)
            return true
          } catch {
            return false
          }
        },
      })

      // QueryProvider: uses Haiku to answer questions about the agent
      this.telegramBot.setQueryProvider({
        ask: async (question: string, terminalContent: string): Promise<string> => {
          return this.askLLM(question, terminalContent)
        },
      })

      await this.telegramBot.start()
    } catch (err: any) {
      logger.error(`[${this.agent.id}] Failed to start Telegram bot: ${err.message}`)
      this.telegramBot = null
    }
  }

  private async stopTelegramBot(): Promise<void> {
    if (this.telegramBot) {
      await this.telegramBot.stop()
      this.telegramBot = null
    }
  }

  // -----------------------------------------------------------------------
  // LLM Q&A for Telegram consultation
  // -----------------------------------------------------------------------

  private async askLLM(question: string, terminalContent: string): Promise<string> {
    const lines = terminalContent.split('\n')
    const trimmed = lines.slice(-200).join('\n')

    const systemPrompt = `You are a developer assistant reporting on the status of a Claude Code agent.
You have access to the agent's terminal output and its master prompt (objectives).
Answer the user's question based on what you can see in the terminal.

## Agent Master Prompt
${this.agent.masterPrompt}

## Guidelines
- Be concise and direct — this is a Telegram message, keep it short.
- Use plain text, no markdown (Telegram uses HTML). You can use <b>bold</b> and <i>italic</i>.
- If the terminal shows errors, mention them.
- If you can't determine something from the terminal, say so.
- Answer in the same language the user writes in.`

    const userMessage = `## Terminal Output (last ${Math.min(lines.length, 200)} lines)
\`\`\`
${trimmed}
\`\`\`

## Question
${question}`

    let resultText = ''

    for await (const message of query({
      prompt: userMessage,
      options: {
        model: 'claude-haiku-4-5-20251001',
        systemPrompt,
        maxTurns: 3,
        allowedTools: [],
      },
    })) {
      const msg = message as Record<string, unknown>
      if (msg.type === 'result' && msg.result) {
        resultText = msg.result as string
      }
    }

    return resultText || 'No pude generar una respuesta.'
  }

  // -----------------------------------------------------------------------
  // Terminal Watchdog lifecycle
  // -----------------------------------------------------------------------

  private startWatchdog(): void {
    if (this.agent.watchdog?.enabled === false) return

    const log = this.createLogger(this.manager ?? undefined)
    const wc = this.agent.watchdog

    this.watchdog = new TerminalWatchdog({
      getAgent: () => this.agent,
      getProcessingState: () => this.stateMachine.getProcessingState(),
      onAction: () => this.stateMachine.recordExternalAction(),
      getTelegramBot: () => this.telegramBot,
      logFn: log,
    }, {
      pollIntervalMs: (wc?.pollIntervalSec ?? 30) * 1000,
      actionCooldownMs: (wc?.actionCooldownSec ?? 60) * 1000,
      attentionThreshold: wc?.attentionThreshold ?? 2,
    })

    this.watchdog.start()
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      this.watchdog.stop()
      this.watchdog = null
    }
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  getAgent(): Agent {
    return this.agent
  }

  getProcessingState() {
    return this.stateMachine.getProcessingState()
  }

  getStateMachine(): EventStateMachine {
    return this.stateMachine
  }

  getTelegramBot(): TelegramBot | null {
    return this.telegramBot
  }

  getWatchdog(): TerminalWatchdog | null {
    return this.watchdog
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
