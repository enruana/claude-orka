/**
 * EventStateMachine - Explicit state machine for processing hook events
 *
 * Replaces the monolithic handleHookEvent logic with discrete nodes:
 *
 *   Hook Event → [guard] → [route_event] → [capture_terminal] → [parse_terminal] → [fast_path]
 *                               |                                                       |
 *                          [log_only]→END                          +----------+----------+----------+
 *                                                                  |          |          |          |
 *                                                             ctx_limit   processing  permission  waiting
 *                                                                  |       (END)         |          |
 *                                                          [handle_ctx]            [handle_perm]  [handle_wait]
 *                                                                  |                     |          |
 *                                                                 END              [execute]→END   Phase 2: [handle_ambiguous]
 *
 * Phase 2 will replace handle_waiting with LLM-driven decisions via handle_ambiguous.
 */

import { Agent } from '../models/Agent'
import { ProcessedHookEvent } from '../models/HookEvent'
import { TerminalReader, TerminalState } from './TerminalReader'
import { LLMDecisionMaker } from './LLMDecisionMaker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All possible node names in the state machine */
export type NodeName =
  | 'guard'
  | 'route_event'
  | 'log_only'
  | 'handle_session_restart'
  | 'capture_terminal'
  | 'parse_terminal'
  | 'fast_path'
  | 'handle_context_limit'
  | 'handle_permission'
  | 'handle_waiting'
  | 'handle_ambiguous'
  | 'execute'
  | 'end'

/** Actions the state machine can decide to take */
export type ActionType =
  | 'respond'
  | 'approve'
  | 'reject'
  | 'wait'
  | 'request_help'
  | 'compact'
  | 'clear'
  | 'escape'

/** The decision produced by a node */
export interface Decision {
  action: ActionType
  response?: string
  reason: string
}

/** Mutable context that flows through the state machine */
export interface EventContext {
  event: ProcessedHookEvent
  agent: Agent
  paneId: string | null
  terminalContent: string | null
  terminalState: TerminalState | null
  decision: Decision | null
  skipReason: string | null
}

/** Result returned by each node */
export interface NodeResult {
  next: NodeName
}

/** Logging function injected by the daemon */
export type LogFn = (
  level: 'info' | 'warn' | 'error' | 'debug' | 'action',
  message: string,
  details?: Record<string, unknown>
) => void

/** A single node: receives context + logger, mutates context, returns next node */
export type StateNode = (ctx: EventContext, log: LogFn) => Promise<NodeResult>

/** Processing guard state (prevents duplicate/stuck handling) */
export interface ProcessingState {
  isProcessing: boolean
  processingStartedAt: number
  lastResponseTime: number
  lastEventType: string | null
  /** When true, the next SessionStart bypasses cooldown (after /clear or /compact) */
  pendingFollowUp: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RESPONSE_INTERVAL = 3000
const MAX_PROCESSING_TIME = 120_000

/** Events that only need to be logged (no terminal action) */
const LOG_ONLY_EVENTS = new Set(['PreCompact', 'SessionEnd', 'PostToolUseFailure'])

// ---------------------------------------------------------------------------
// EventStateMachine
// ---------------------------------------------------------------------------

export class EventStateMachine {
  private nodes: Map<NodeName, StateNode> = new Map()
  private processingState: ProcessingState = {
    isProcessing: false,
    processingStartedAt: 0,
    lastResponseTime: 0,
    lastEventType: null,
    pendingFollowUp: false,
  }

  /** Provides the latest agent reference (may change after refresh) */
  private getAgent: () => Agent

  /** LLM for intelligent decisions (Phase 2) */
  private llm: LLMDecisionMaker

  constructor(getAgent: () => Agent) {
    this.getAgent = getAgent
    this.llm = new LLMDecisionMaker()
    this.registerDefaultNodes()
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Run the state machine for a single hook event */
  async run(event: ProcessedHookEvent, log: LogFn): Promise<void> {
    const ctx: EventContext = {
      event,
      agent: this.getAgent(),
      paneId: null,
      terminalContent: null,
      terminalState: null,
      decision: null,
      skipReason: null,
    }

    let current: NodeName = 'guard'

    try {
      while (current !== 'end') {
        const node = this.nodes.get(current)
        if (!node) {
          log('error', `Unknown node: ${current}`)
          break
        }
        const result = await node(ctx, log)
        current = result.next
      }
    } finally {
      this.processingState.isProcessing = false
    }
  }

  /** Replace or add a node (for Phase 2 extensibility) */
  registerNode(name: NodeName, node: StateNode): void {
    this.nodes.set(name, node)
  }

  /** Get current processing state (for external inspection) */
  getProcessingState(): ProcessingState {
    return { ...this.processingState }
  }

  // -----------------------------------------------------------------------
  // Node Registration
  // -----------------------------------------------------------------------

  private registerDefaultNodes(): void {
    this.nodes.set('guard', this.guard.bind(this))
    this.nodes.set('route_event', this.routeEvent.bind(this))
    this.nodes.set('log_only', this.logOnly.bind(this))
    this.nodes.set('handle_session_restart', this.handleSessionRestart.bind(this))
    this.nodes.set('capture_terminal', this.captureTerminal.bind(this))
    this.nodes.set('parse_terminal', this.parseTerminal.bind(this))
    this.nodes.set('fast_path', this.fastPath.bind(this))
    this.nodes.set('handle_context_limit', this.handleContextLimit.bind(this))
    this.nodes.set('handle_permission', this.handlePermission.bind(this))
    this.nodes.set('handle_waiting', this.handleWaiting.bind(this))
    this.nodes.set('handle_ambiguous', this.handleAmbiguous.bind(this))
    this.nodes.set('execute', this.execute.bind(this))
  }

  // -----------------------------------------------------------------------
  // Nodes
  // -----------------------------------------------------------------------

  /** Guard: check processing lock, cooldown, stuck detection */
  private async guard(ctx: EventContext, log: LogFn): Promise<NodeResult> {
    // Already processing?
    if (this.processingState.isProcessing) {
      const elapsed = Date.now() - this.processingState.processingStartedAt
      if (elapsed < MAX_PROCESSING_TIME) {
        log('warn', `Already processing an event (${Math.round(elapsed / 1000)}s), ignoring`)
        return { next: 'end' }
      }
      log('warn', `Processing stuck for ${Math.round(elapsed / 1000)}s, force-resetting`)
      this.processingState.isProcessing = false
    }

    // Cooldown active? (bypass for SessionStart follow-ups after /clear or /compact)
    const timeSinceLastResponse = Date.now() - this.processingState.lastResponseTime
    const isFollowUp = this.processingState.pendingFollowUp && ctx.event.payload.event_type === 'SessionStart'
    if (isFollowUp) {
      log('info', 'Follow-up after context management - bypassing cooldown')
      this.processingState.pendingFollowUp = false
    } else if (timeSinceLastResponse < MIN_RESPONSE_INTERVAL && this.processingState.lastResponseTime > 0) {
      log('debug', 'Cooldown active, waiting...')
      return { next: 'end' }
    }

    // Acquire processing lock
    this.processingState.isProcessing = true
    this.processingState.processingStartedAt = Date.now()
    this.processingState.lastEventType = ctx.event.payload.event_type

    log('info', `Hook: ${ctx.event.payload.event_type} [session: ${(ctx.event.payload.session_id || 'none').slice(0, 8)}]`)

    return { next: 'route_event' }
  }

  /** Route event: send log-only events to log_only, session restarts to handle_session_restart, others to capture_terminal */
  private async routeEvent(ctx: EventContext, _log: LogFn): Promise<NodeResult> {
    const eventType = ctx.event.payload.event_type

    if (LOG_ONLY_EVENTS.has(eventType)) {
      return { next: 'log_only' }
    }

    // SessionStart after clear/compact → special handling (terminal is in transitional state)
    if (eventType === 'SessionStart') {
      const source = ctx.event.payload.session_start_data?.source
      if (source === 'clear' || source === 'compact') {
        return { next: 'handle_session_restart' }
      }
    }

    return { next: 'capture_terminal' }
  }

  /** Log-only: handle events that just need logging (PreCompact, SessionEnd, PostToolUseFailure) */
  private async logOnly(ctx: EventContext, log: LogFn): Promise<NodeResult> {
    const eventType = ctx.event.payload.event_type

    switch (eventType) {
      case 'PreCompact': {
        const trigger = ctx.event.payload.compact_data?.trigger || 'manual'
        log('info', `PreCompact event (trigger: ${trigger})`)
        break
      }
      case 'SessionEnd': {
        log('warn', `Session ended: ${ctx.event.payload.session_end_data?.reason || 'unknown'}`)
        break
      }
      case 'PostToolUseFailure': {
        log('warn', `Tool failed: ${ctx.event.payload.tool_failure_data?.tool_name || 'unknown'}`)
        break
      }
      default:
        log('info', `Log-only event: ${eventType}`)
    }

    return { next: 'end' }
  }

  /**
   * Handle SessionStart after clear/compact.
   * Terminal is in transitional state — wait for Claude to be ready,
   * then route to LLM so it can decide what to send based on masterPrompt.
   */
  private async handleSessionRestart(ctx: EventContext, log: LogFn): Promise<NodeResult> {
    const source = ctx.event.payload.session_start_data?.source || 'unknown'
    const paneId = ctx.agent.connection?.tmuxPaneId
    const sessionName = ctx.agent.connection?.sessionId || 'unknown'

    log('info', `Session restarted (source: ${source}) - waiting for Claude to be ready...`)

    if (!paneId) {
      log('error', 'No pane ID - cannot wait for terminal')
      return { next: 'end' }
    }

    // Wait for Claude to show the prompt (up to 15s, poll every 1s)
    // After clear/compact the UI takes a moment to render
    const timeoutMs = 15000
    const pollMs = 1000
    const startTime = Date.now()
    let ready = false

    while (Date.now() - startTime < timeoutMs) {
      try {
        const content = await TerminalReader.capture(paneId, sessionName)
        const state = TerminalReader.parseState(content.content)
        const elapsed = Math.round((Date.now() - startTime) / 1000)

        if (state.isWaitingForInput && !state.isProcessing) {
          ctx.paneId = paneId
          ctx.terminalContent = content.content
          ctx.terminalState = state
          log('info', `Terminal ready after ${source} (${elapsed}s, ${content.content.length} chars)`)
          ready = true
          break
        }

        log('debug', `Waiting for prompt... (${elapsed}s) processing=${state.isProcessing} waiting=${state.isWaitingForInput}`)
      } catch {
        // Ignore capture errors during polling
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }

    if (!ready) {
      log('warn', `Claude not ready after ${timeoutMs / 1000}s - skipping`)
      return { next: 'end' }
    }

    // Go directly to LLM decision — masterPrompt knows what to do after clear/compact
    return { next: 'handle_ambiguous' }
  }

  /** Capture terminal content from tmux pane */
  private async captureTerminal(ctx: EventContext, log: LogFn): Promise<NodeResult> {
    const paneId = ctx.agent.connection?.tmuxPaneId
    if (!paneId) {
      log('error', 'Could not capture terminal - no pane ID or connection')
      return { next: 'end' }
    }

    try {
      const content = await TerminalReader.capture(
        paneId,
        ctx.agent.connection?.sessionId || 'unknown'
      )

      ctx.paneId = paneId
      ctx.terminalContent = content.content

      const lines = content.content.split('\n')
      log('info', `Terminal captured (${content.content.length} chars, ${lines.length} lines)`)

      return { next: 'parse_terminal' }
    } catch (error: any) {
      log('error', `Failed to capture terminal: ${error.message}`)
      return { next: 'end' }
    }
  }

  /** Parse terminal content into structured state */
  private async parseTerminal(ctx: EventContext, log: LogFn): Promise<NodeResult> {
    if (!ctx.terminalContent) {
      return { next: 'end' }
    }

    ctx.terminalState = TerminalReader.parseState(ctx.terminalContent)

    const state = ctx.terminalState
    const label = state.isWaitingForInput ? 'waiting'
      : state.isProcessing ? 'processing'
      : state.hasPermissionPrompt ? 'permission'
      : 'other'
    log('info', `State: ${label}`)

    return { next: 'fast_path' }
  }

  /** Fast-path: deterministic routing based on terminal state */
  private async fastPath(ctx: EventContext, log: LogFn): Promise<NodeResult> {
    const ts = ctx.terminalState!

    // Context limit → handle immediately
    if (ts.hasContextLimit) {
      return { next: 'handle_context_limit' }
    }

    // Processing → do nothing, Claude is working
    if (ts.isProcessing) {
      log('info', 'Claude still working - waiting')
      return { next: 'end' }
    }

    // Permission prompt → approve
    if (ts.hasPermissionPrompt) {
      return { next: 'handle_permission' }
    }

    // Waiting for input → respond (Phase 1: hardcoded, Phase 2: LLM)
    if (ts.isWaitingForInput) {
      return { next: 'handle_waiting' }
    }

    // Unclear state → skip
    log('info', 'Terminal state unclear - skipping')
    return { next: 'end' }
  }

  /** Handle context limit: send /compact or /clear */
  private async handleContextLimit(ctx: EventContext, log: LogFn): Promise<NodeResult> {
    const content = ctx.terminalContent!
    const paneId = ctx.paneId!

    const isZeroPercent = /0%\s*remaining/i.test(content)
    const compactFailed = /compaction.*error|conversation too long/i.test(content)

    if (isZeroPercent || compactFailed) {
      log('warn', 'Context exhausted! Sending /clear.')
      ctx.decision = { action: 'clear', reason: 'Context exhausted (0% or compact failed)' }
      await TerminalReader.sendClear(paneId)
    } else {
      log('warn', 'Context limit reached! Sending /compact.')
      ctx.decision = { action: 'compact', reason: 'Context limit reached' }
      await TerminalReader.sendCompact(paneId)
    }

    // Schedule follow-up: when SessionStart arrives after clear/compact,
    // bypass cooldown so the agent can re-engage Claude with next instructions
    this.processingState.pendingFollowUp = true
    this.processingState.lastResponseTime = Date.now()
    return { next: 'end' }
  }

  /** Handle permission prompt: approve (Phase 1: always approve) */
  private async handlePermission(ctx: EventContext, _log: LogFn): Promise<NodeResult> {
    ctx.decision = {
      action: 'approve',
      reason: `Permission prompt detected (type: ${ctx.terminalState?.permissionType || 'unknown'})`,
    }
    return { next: 'execute' }
  }

  /** Handle waiting for input: route to LLM decision (Phase 2) */
  private async handleWaiting(_ctx: EventContext, _log: LogFn): Promise<NodeResult> {
    return { next: 'handle_ambiguous' }
  }

  /**
   * Handle ambiguous situations with LLM (Phase 2)
   *
   * Calls Claude Haiku with masterPrompt + terminal context to decide what to do.
   * Falls back to Phase 1 hardcoded "continue" if LLM is unavailable or fails.
   */
  private async handleAmbiguous(ctx: EventContext, log: LogFn): Promise<NodeResult> {
    // Try LLM decision
    if (this.llm.isAvailable() && ctx.terminalContent && ctx.terminalState) {
      const decision = await this.llm.decide({
        masterPrompt: ctx.agent.masterPrompt,
        terminalContent: ctx.terminalContent,
        terminalState: ctx.terminalState,
        hookEvent: ctx.event.payload.event_type,
      }, log)

      if (decision) {
        ctx.decision = decision
        return { next: 'execute' }
      }
    }

    // Fallback: Phase 1 hardcoded response
    log('info', 'LLM unavailable - falling back to hardcoded "continue"')
    ctx.decision = {
      action: 'respond',
      response: 'continue',
      reason: 'Fallback: Claude waiting for input (no LLM)',
    }
    return { next: 'execute' }
  }

  /** Execute the decided action on the terminal */
  private async execute(ctx: EventContext, log: LogFn): Promise<NodeResult> {
    const decision = ctx.decision
    if (!decision || !ctx.paneId) {
      return { next: 'end' }
    }

    if (decision.action === 'wait') {
      log('debug', `Waiting: ${decision.reason}`)
      return { next: 'end' }
    }

    log('action', `Executing: ${decision.action}${decision.response ? ` -> "${decision.response}"` : ''} (${decision.reason})`)

    switch (decision.action) {
      case 'respond':
        if (decision.response) {
          await TerminalReader.sendTextWithEnter(ctx.paneId, decision.response)
        }
        break
      case 'approve':
        await TerminalReader.sendApproval(ctx.paneId)
        break
      case 'reject':
        await TerminalReader.sendRejection(ctx.paneId)
        break
      case 'compact':
        await TerminalReader.sendCompact(ctx.paneId)
        break
      case 'clear':
        await TerminalReader.sendClear(ctx.paneId)
        break
      case 'escape':
        await TerminalReader.sendEscape(ctx.paneId)
        break
      case 'request_help':
        log('warn', `Help requested: ${decision.reason}`)
        break
    }

    this.processingState.lastResponseTime = Date.now()
    return { next: 'end' }
  }
}
