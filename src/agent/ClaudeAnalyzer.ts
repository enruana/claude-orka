/**
 * ClaudeAnalyzer - Uses Claude SDK to analyze terminal context and decide actions
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { logger } from '../utils'

/**
 * Record of a past decision for context injection
 */
export interface DecisionRecord {
  timestamp: Date
  eventType: string
  action: string
  reason: string
  response?: string
}

/**
 * Analysis result from Claude
 */
export interface AnalysisResult {
  /** Action to take */
  action: 'respond' | 'approve' | 'reject' | 'wait' | 'request_help' | 'compact' | 'escape'
  /** Response text (if action is 'respond') */
  response?: string
  /** Reason for the decision */
  reason: string
  /** Confidence level 0-1 */
  confidence: number
  /** Whether to notify human */
  notifyHuman: boolean
}

/**
 * ClaudeAnalyzer uses the Claude Agent SDK to intelligently analyze terminal output
 */
export class ClaudeAnalyzer {
  private masterPrompt: string
  private projectContext: string

  constructor(masterPrompt: string, projectContext: string = '') {
    this.masterPrompt = masterPrompt
    this.projectContext = projectContext
  }

  /**
   * Analyze terminal content and decide what action to take
   */
  async analyze(
    terminalContent: string,
    hookEventType: string,
    eventData?: Record<string, unknown>,
    decisionHistory?: DecisionRecord[]
  ): Promise<AnalysisResult> {
    const systemPrompt = this.buildSystemPrompt()
    const userPrompt = this.buildUserPrompt(terminalContent, hookEventType, eventData, decisionHistory)

    logger.debug('ClaudeAnalyzer: Starting analysis')

    try {
      const result = await this.callClaude(systemPrompt, userPrompt)
      logger.debug(`ClaudeAnalyzer: Analysis complete - ${result.action}`)
      return result
    } catch (error: any) {
      logger.error(`ClaudeAnalyzer: Analysis failed - ${error.message}`)
      return {
        action: 'request_help',
        reason: `Analysis failed: ${error.message}`,
        confidence: 0,
        notifyHuman: true,
      }
    }
  }

  private buildSystemPrompt(): string {
    return `You are a VIRTUAL HUMAN having a conversation with Claude Code in a terminal.

THE SETUP:
- Claude Code is running in a terminal, doing development work
- When Claude finishes something, it waits for your input (shows ">" prompt)
- You type messages to guide Claude through the work, like a human developer would

YOUR OBJECTIVE:
${this.masterPrompt}

${this.projectContext ? `Project context:\n${this.projectContext}\n` : ''}

HOW TO BEHAVE - CONVERSATIONAL STYLE:
Think of this as a chat conversation. You're a developer talking to your AI assistant.

When Claude finishes a task successfully:
- "great, now do X" or "perfect, continue with Y" or just "next step"

When Claude asks a question:
- Answer directly: "yes", "no", "use option A", "the file is in src/components"

When Claude hits an error:
- "fix that error" or "try a different approach" or "check the logs and fix it"

When Claude seems stuck or confused:
- "let me clarify: I want you to..." or "ignore that, focus on X"

When you need to check status:
- "what's the current status?" or run status commands from your workflow

AVAILABLE ACTIONS:
- "respond": Type your message to Claude (conversational, like chatting)
- "approve": Type 'y' for permission prompts
- "reject": Type 'n' for permission prompts
- "wait": Claude is still working, don't interrupt
- "request_help": You're stuck, need the real human
- "compact": Use /compact to compress context when it's getting long
- "escape": Cancel current operation

RESPONSE FORMAT (JSON only):
{
  "action": "respond|approve|reject|wait|request_help|compact|escape",
  "response": "your message to Claude",
  "reason": "brief note on your thinking",
  "confidence": 0.0-1.0,
  "notifyHuman": true|false
}

CONVERSATION EXAMPLES:

Claude: "I've created the user model. What should I do next?"
You: "now create the API endpoints for user CRUD operations"

Claude: "The tests are failing because the database isn't configured"
You: "configure the test database and run the tests again"

Claude: "Should I use PostgreSQL or MongoDB for this project?"
You: "use PostgreSQL"

Claude: "I've completed the login feature. Here's a summary..."
You: "great, now implement the registration feature"

Claude: "Error: Cannot find module 'express'"
You: "install the missing dependencies and try again"

Claude: "The build succeeded. All tests pass."
You: "perfect, let's move to the next task"

WORKFLOW AWARENESS:
- If your objective mentions specific commands or steps, follow that sequence
- After completing one step, move to the next in the workflow
- If context is getting full (PreCompact event), consider using /compact
- After /compact or /clear, check status and resume from where you left off
- Keep the conversation flowing naturally toward your objective

IMPORTANT:
- Be conversational but concise
- Don't explain yourself, just give instructions
- Move the work forward step by step
- If unsure, ask Claude for status or clarification
- Only use "request_help" if truly stuck`
  }

  private buildUserPrompt(terminalContent: string, hookEventType: string, eventData?: Record<string, unknown>, decisionHistory?: DecisionRecord[]): string {
    // Get the last section of terminal for context
    const lines = terminalContent.split('\n')
    const relevantLines = lines.slice(-150) // Last 150 lines for detailed context
    const recentContext = relevantLines.join('\n')

    // Add context about the specific event type
    let eventContext = ''
    switch (hookEventType) {
      case 'PreCompact':
        const trigger = eventData?.trigger || 'manual'
        eventContext = trigger === 'auto'
          ? 'CONTEXT WINDOW IS FULL - Claude Code is about to auto-compact. You may want to wait for compact to finish.'
          : 'Manual compact was triggered.'
        break
      case 'SessionStart':
        const source = eventData?.source || 'startup'
        eventContext = `Session just started (source: ${source}). If source is "compact" or "clear", the context was just reset.`
        break
      case 'SessionEnd':
        const reason = eventData?.reason || 'unknown'
        eventContext = `Session ended with reason: ${reason}. You may want to request human help.`
        break
      case 'Notification':
        const notifType = eventData?.notification_type || eventData?.type || 'info'
        eventContext = `Notification received (type: ${notifType}). Check if it's an error that needs attention.`
        break
      case 'Stop':
        eventContext = 'Claude Code has stopped and is waiting for user input.'
        break
    }

    let historySection = ''
    if (decisionHistory && decisionHistory.length > 0) {
      const lines = decisionHistory.map(d => {
        const time = d.timestamp instanceof Date
          ? d.timestamp.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
          : String(d.timestamp)
        const resp = d.response ? ` "${d.response}"` : ''
        return `[${time}] ${d.eventType} → ${d.action}${resp} | ${d.reason}`
      })
      historySection = `\nYOUR RECENT DECISIONS (last ${decisionHistory.length}):\n${lines.join('\n')}\n`
    }

    return `HOOK EVENT: ${hookEventType}
${eventContext ? `\nEVENT CONTEXT: ${eventContext}\n` : ''}${historySection}
TERMINAL CONTENT (last 150 lines):
\`\`\`
${recentContext}
\`\`\`

Based on this terminal state, your master objective, and your recent decisions, what action should you take?
Respond with a JSON object only, no other text.`
  }

  private async callClaude(systemPrompt: string, userPrompt: string): Promise<AnalysisResult> {
    // Wrap with a timeout to prevent hanging indefinitely on API calls
    const ANALYSIS_TIMEOUT = 60_000 // 60 seconds

    const analysisPromise = this.callClaudeInner(systemPrompt, userPrompt)
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Claude API analysis timed out after 60s')), ANALYSIS_TIMEOUT)
    )

    return Promise.race([analysisPromise, timeoutPromise])
  }

  private async callClaudeInner(systemPrompt: string, userPrompt: string): Promise<AnalysisResult> {
    try {
      // Use the Claude Agent SDK to query
      const conversation = query({
        prompt: userPrompt,
        options: {
          systemPrompt,
          model: 'haiku', // Use haiku for fast, cost-effective analysis
          maxTurns: 1,
          permissionMode: 'bypassPermissions',
        },
      })

      let result = ''

      for await (const message of conversation) {
        if (message.type === 'assistant') {
          // Extract text content from assistant message
          const content = message.message.content
          for (const block of content) {
            if ('text' in block) {
              result += block.text
            }
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success' && message.result) {
            result = message.result
          }
          break
        }
      }

      // Parse the JSON response
      return this.parseResponse(result)
    } catch (error: any) {
      logger.error(`Claude API call failed: ${error.message}`)
      throw error
    }
  }

  private parseResponse(response: string): AnalysisResult {
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        throw new Error('No JSON found in response')
      }

      const parsed = JSON.parse(jsonMatch[0])

      // Validate required fields
      if (!parsed.action) {
        throw new Error('Missing action field')
      }

      // Validate action is one of the allowed values
      const validActions = ['respond', 'approve', 'reject', 'wait', 'request_help', 'compact', 'escape']
      if (!validActions.includes(parsed.action)) {
        throw new Error(`Invalid action: ${parsed.action}`)
      }

      return {
        action: parsed.action,
        response: parsed.response,
        reason: parsed.reason || 'No reason provided',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        notifyHuman: parsed.notifyHuman === true,
      }
    } catch (error: any) {
      logger.warn(`Failed to parse Claude response: ${error.message}`)
      logger.debug(`Raw response: ${response}`)

      // Default to requesting help if we can't parse
      return {
        action: 'request_help',
        reason: `Could not parse response: ${error.message}`,
        confidence: 0,
        notifyHuman: true,
      }
    }
  }

  /**
   * Quick check if terminal is waiting for simple approval
   * Used as a fast-path before full Claude analysis
   */
  static isSimpleApprovalPrompt(content: string): boolean {
    const lastLines = content.split('\n').slice(-20).join('\n').toLowerCase()

    const approvalPatterns = [
      /\(y\/n\)\s*$/,
      /\[y\/n\]\s*$/,
      /allow\s+this\s+action\?/,
      /do\s+you\s+want\s+to\s+proceed\?/,
      /continue\?\s*\(y\/n\)/,
    ]

    return approvalPatterns.some(pattern => pattern.test(lastLines))
  }

  /**
   * Quick check if Claude is still processing
   * Used to avoid unnecessary analysis
   */
  static isProcessing(content: string): boolean {
    const lastLines = content.split('\n').slice(-10).join('\n')

    // Check for spinner characters
    const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    if (spinnerChars.some(char => lastLines.includes(char))) {
      return true
    }

    // Check for processing indicators
    if (lastLines.includes('Thinking') || lastLines.includes('Processing')) {
      return true
    }

    return false
  }
}
