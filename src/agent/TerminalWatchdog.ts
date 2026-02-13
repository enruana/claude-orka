/**
 * TerminalWatchdog - LLM-driven periodic polling to detect stalled Claude Code sessions
 *
 * A peer to EventStateMachine: while ESM is hook-driven (reactive),
 * the watchdog is timer-driven (proactive). It catches cases where
 * hooks don't fire (user interrupts, context limits, stuck states).
 *
 * Each poll captures the terminal and asks an LLM to evaluate whether
 * Claude Code is stalled or needs intervention. This avoids false positives
 * from programmatic heuristics — the LLM understands context.
 *
 * Safety features:
 * - LLM-based evaluation: no regex-driven false positives
 * - Requires N consecutive LLM "needs attention" verdicts before acting
 * - Skips LLM call when terminal shows active processing (spinners)
 * - Skips when ESM is actively processing
 * - Respects cooldown after acting to avoid double-acting with ESM
 * - Overlap guard prevents concurrent poll executions
 */

import { Agent } from '../models/Agent'
import { TerminalReader, TerminalState } from './TerminalReader'
import { LLMDecisionMaker } from './LLMDecisionMaker'
import { executeTerminalAction } from './EventStateMachine'
import type { ProcessingState, Decision, LogFn } from './EventStateMachine'
import type { TelegramBot } from './TelegramBot'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WatchdogConfig {
  /** How often to poll the terminal (ms). Default: 30s */
  pollIntervalMs?: number
  /** Minimum time between watchdog actions (ms). Default: 60s */
  actionCooldownMs?: number
  /** Consecutive "needs attention" polls before acting. Default: 2 */
  attentionThreshold?: number
}

const DEFAULT_CONFIG: Required<WatchdogConfig> = {
  pollIntervalMs: 30_000,
  actionCooldownMs: 60_000,
  attentionThreshold: 2,
}

// ---------------------------------------------------------------------------
// Dependencies (injected)
// ---------------------------------------------------------------------------

export interface WatchdogDeps {
  getAgent: () => Agent
  getProcessingState: () => ProcessingState
  onAction: () => void
  getTelegramBot: () => TelegramBot | null
  logFn: LogFn
}

// ---------------------------------------------------------------------------
// TerminalWatchdog
// ---------------------------------------------------------------------------

export class TerminalWatchdog {
  private config: Required<WatchdogConfig>
  private deps: WatchdogDeps

  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private consecutiveAttentionPolls = 0
  private lastActionAt = 0
  private llm: LLMDecisionMaker
  private running = false

  constructor(deps: WatchdogDeps, config?: WatchdogConfig) {
    this.deps = deps
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.llm = new LLMDecisionMaker()
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  start(): void {
    if (this.running) return
    this.running = true
    this.deps.logFn('info', `[Watchdog] Started (poll=${this.config.pollIntervalMs}ms, cooldown=${this.config.actionCooldownMs}ms, threshold=${this.config.attentionThreshold})`)
    this.timer = setInterval(() => this.poll(), this.config.pollIntervalMs)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.consecutiveAttentionPolls = 0
    this.deps.logFn('info', '[Watchdog] Stopped')
  }

  isRunning(): boolean {
    return this.running
  }

  // -----------------------------------------------------------------------
  // Core polling loop
  // -----------------------------------------------------------------------

  private async poll(): Promise<void> {
    // Overlap guard — skip if previous poll is still running
    if (this.polling) return
    this.polling = true

    const log = this.deps.logFn

    try {
      const agent = this.deps.getAgent()
      const paneId = agent.connection?.tmuxPaneId
      const sessionName = agent.connection?.sessionId || 'unknown'

      // No connection → nothing to watch
      if (!paneId) {
        this.consecutiveAttentionPolls = 0
        return
      }

      // If ESM is actively processing, skip this cycle
      const ps = this.deps.getProcessingState()
      if (ps.isProcessing) {
        log('debug', '[Watchdog] ESM busy - skipping')
        this.consecutiveAttentionPolls = 0
        return
      }

      // Capture and parse terminal
      let content: string
      let state: TerminalState
      try {
        const captured = await TerminalReader.capture(paneId, sessionName)
        content = captured.content
        state = TerminalReader.parseState(content)
      } catch (err: any) {
        log('debug', `[Watchdog] Capture failed: ${err.message}`)
        return
      }

      // Quick skip: if terminal shows active processing (spinners, progress),
      // no need to spend an LLM call
      if (state.isProcessing) {
        if (this.consecutiveAttentionPolls > 0) {
          log('debug', '[Watchdog] Terminal processing - resetting counter')
        }
        this.consecutiveAttentionPolls = 0
        return
      }

      // Ask LLM to evaluate the terminal and decide what to do
      const decision = await this.llm.decide({
        masterPrompt: agent.masterPrompt,
        terminalContent: content,
        terminalState: state,
        hookEvent: 'Watchdog (periodic terminal check — evaluate if Claude Code is stalled or needs intervention)',
      }, log)

      if (!decision || decision.action === 'wait') {
        // LLM says everything is fine — no attention needed
        if (this.consecutiveAttentionPolls > 0) {
          log('debug', '[Watchdog] LLM says OK - resetting counter')
        }
        this.consecutiveAttentionPolls = 0
      } else {
        // LLM says attention is needed
        this.consecutiveAttentionPolls++
        log('info', `[Watchdog] LLM: needs attention (${this.consecutiveAttentionPolls}/${this.config.attentionThreshold}) — ${decision.action}: ${decision.reason}`)

        if (this.consecutiveAttentionPolls >= this.config.attentionThreshold && this.cooldownClear()) {
          await this.executeDecision(decision, paneId, agent, log)
          this.recordAction()
        }
      }
    } catch (err: any) {
      log('error', `[Watchdog] Poll error: ${err.message}`)
    } finally {
      this.polling = false
    }
  }

  // -----------------------------------------------------------------------
  // Cooldown
  // -----------------------------------------------------------------------

  private cooldownClear(): boolean {
    const now = Date.now()

    // Watchdog's own cooldown
    if (now - this.lastActionAt < this.config.actionCooldownMs) {
      this.deps.logFn('debug', '[Watchdog] Action cooldown active - waiting')
      return false
    }

    // ESM's last response time — avoid acting right after ESM did
    const ps = this.deps.getProcessingState()
    if (now - ps.lastResponseTime < this.config.actionCooldownMs) {
      this.deps.logFn('debug', '[Watchdog] ESM acted recently - waiting')
      return false
    }

    return true
  }

  // -----------------------------------------------------------------------
  // Action execution
  // -----------------------------------------------------------------------

  private async executeDecision(decision: Decision, paneId: string, agent: Agent, log: LogFn): Promise<void> {
    log('action', `[Watchdog] Executing: ${decision.action}${decision.response ? ` -> "${decision.response}"` : ''} (${decision.reason})`)

    await executeTerminalAction(decision, paneId, log)

    // Only notify Telegram when human intervention is needed
    if (decision.action === 'request_help') {
      await this.notifyTelegram(agent, decision)
    }

    // LLM-generated notification from compound decision
    if (decision.notification) {
      const bot = this.deps.getTelegramBot()
      if (agent.telegram?.enabled && bot?.isRunning()) {
        await bot.sendNotification({
          level: decision.notification.level,
          title: 'Agent update',
          body: decision.notification.message,
        })
      }
    }
  }

  private recordAction(): void {
    this.lastActionAt = Date.now()
    this.consecutiveAttentionPolls = 0
    this.deps.onAction()
  }

  // -----------------------------------------------------------------------
  // Telegram notifications
  // -----------------------------------------------------------------------

  private async notifyTelegram(agent: Agent, decision: Decision): Promise<void> {
    if (!agent.telegram?.enabled) return
    const bot = this.deps.getTelegramBot()
    if (!bot?.isRunning()) return

    await bot.sendNotification({
      level: decision.action === 'request_help' ? 'warn' : 'info',
      title: `[Watchdog] ${decision.action}`,
      body: decision.reason,
    })
  }
}
