/**
 * LLMDecisionMaker - Uses Claude Code Agent SDK to make intelligent decisions
 *
 * Called by the EventStateMachine's handle_ambiguous node when
 * deterministic fast-path cannot decide what to do.
 *
 * Uses the Claude Agent SDK's `query()` with `outputFormat` (JSON schema)
 * for structured output. Authenticates via your local Claude Code setup.
 * Falls back to Phase 1 behavior if the SDK call fails.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { logger } from '../utils'
import type { Decision, ActionType, LogFn } from './EventStateMachine'
import type { TerminalState } from './TerminalReader'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LLMDecisionInput {
  masterPrompt: string
  terminalContent: string
  terminalState: TerminalState
  hookEvent: string
  hookPayload?: Record<string, unknown>
}

/** Schema for structured output from the Agent SDK */
const DECISION_SCHEMA = {
  type: 'object' as const,
  properties: {
    action: {
      type: 'string' as const,
      enum: ['respond', 'wait', 'approve', 'reject', 'compact', 'clear', 'escape', 'request_help'],
      description: 'The action to take.',
    },
    response: {
      type: 'string' as const,
      description: 'Text to send to Claude Code. REQUIRED when action is "respond".',
    },
    reason: {
      type: 'string' as const,
      description: 'Brief explanation of why this action was chosen.',
    },
  },
  required: ['action', 'reason'] as const,
}

const VALID_ACTIONS = new Set<ActionType>([
  'respond', 'wait', 'approve', 'reject', 'compact', 'clear', 'escape', 'request_help',
])

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSystemPrompt(masterPrompt: string): string {
  return `You are an autonomous agent controlling a Claude Code session via terminal.

## Your Master Prompt (follow these instructions)
${masterPrompt}

## Your Role
You receive hook events from Claude Code and must decide what action to take.
You can see the terminal output to understand what Claude is doing.

## Available Actions
- **respond**: Send a text prompt to Claude Code. Use this when Claude is waiting for input and you know what to tell it next. The "response" field is what gets typed into the terminal.
- **wait**: Do nothing. Use this when Claude is still working, or when no action is needed.
- **approve**: Send "y" to approve a permission prompt.
- **reject**: Send "n" to reject a permission prompt.
- **compact**: Send /compact to reduce context size.
- **clear**: Send /clear for a full context reset.
- **escape**: Send Escape to cancel current operation.
- **request_help**: Escalate to human - use when unsure or when the situation requires human judgment.

## Guidelines
- Read the terminal output carefully to understand what Claude just did and what it needs.
- When responding, write clear, specific instructions — not just "continue".
- If the task seems complete, use "wait" rather than giving unnecessary instructions.
- If you see errors or unexpected behavior, consider "request_help".
- Match your decisions to the Master Prompt's objectives.`
}

function buildUserMessage(input: LLMDecisionInput): string {
  const lines = input.terminalContent.split('\n')
  const trimmedContent = lines.slice(-200).join('\n')

  return `## Hook Event: ${input.hookEvent}

## Terminal State
- Waiting for input: ${input.terminalState.isWaitingForInput}
- Has permission prompt: ${input.terminalState.hasPermissionPrompt}${input.terminalState.permissionType ? ` (${input.terminalState.permissionType})` : ''}
- Is processing: ${input.terminalState.isProcessing}
- Has context limit: ${input.terminalState.hasContextLimit}
${input.terminalState.error ? `- Error: ${input.terminalState.error}` : ''}

## Terminal Output (last ${Math.min(lines.length, 200)} lines)
\`\`\`
${trimmedContent}
\`\`\`

What action should be taken? Respond with the structured JSON decision.`
}

// ---------------------------------------------------------------------------
// LLMDecisionMaker
// ---------------------------------------------------------------------------

export class LLMDecisionMaker {
  private model: string

  constructor(options?: { model?: string }) {
    this.model = options?.model || 'claude-haiku-4-5-20251001'
  }

  /** Always available — uses local Claude Code auth */
  isAvailable(): boolean {
    return true
  }

  /** Make a decision using Claude Agent SDK */
  async decide(input: LLMDecisionInput, log: LogFn): Promise<Decision | null> {
    try {
      log('info', `LLM deciding (${this.model})...`)

      const prompt = buildUserMessage(input)
      let structuredOutput: unknown = null

      let resultText: string | undefined
      let resultSubtype: string | undefined

      for await (const message of query({
        prompt,
        options: {
          model: this.model,
          systemPrompt: buildSystemPrompt(input.masterPrompt),
          maxTurns: 3,
          allowedTools: [],
          outputFormat: {
            type: 'json_schema',
            schema: DECISION_SCHEMA,
          },
        },
      })) {
        const msg = message as Record<string, unknown>
        log('debug', `SDK message: type=${msg.type} subtype=${msg.subtype} keys=[${Object.keys(msg).join(',')}]`)

        if (msg.type === 'result') {
          resultSubtype = msg.subtype as string
          resultText = msg.result as string | undefined
          structuredOutput = msg.structured_output
          log('debug', `SDK result: subtype=${resultSubtype} hasStructured=${!!structuredOutput} result=${(resultText || '').substring(0, 200)}`)
        }
      }

      // Try structured output first, fall back to parsing result text as JSON
      if (!structuredOutput && resultText) {
        log('debug', 'No structured_output, trying to parse result text as JSON...')
        try {
          structuredOutput = JSON.parse(resultText)
        } catch {
          log('warn', `Could not parse result as JSON: ${resultText.substring(0, 200)}`)
        }
      }

      if (!structuredOutput) {
        log('warn', `LLM returned no usable output (subtype=${resultSubtype}) - falling back`)
        return null
      }

      const data = structuredOutput as Record<string, unknown>
      const action = data.action as string
      const responseText = data.response as string | undefined
      const reason = data.reason as string

      if (!VALID_ACTIONS.has(action as ActionType)) {
        log('warn', `LLM returned invalid action "${action}" - falling back`)
        return null
      }

      const decision: Decision = {
        action: action as ActionType,
        reason: `[LLM] ${reason}`,
      }

      if (action === 'respond' && responseText) {
        decision.response = responseText
      }

      log('info', `LLM decided: ${decision.action}${decision.response ? ` -> "${decision.response.substring(0, 80)}${decision.response.length > 80 ? '...' : ''}"` : ''} (${reason})`)

      return decision
    } catch (error: any) {
      log('error', `LLM call failed: ${error.message}`)
      logger.error(`LLMDecisionMaker error: ${error.message}`)
      return null
    }
  }
}
