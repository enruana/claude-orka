/**
 * TerminalReader - Wrapper around TmuxCommands for reading terminal content
 */

import { TmuxCommands } from '../utils/tmux'
import { logger } from '../utils'

/**
 * Terminal content with metadata
 */
export interface TerminalContent {
  /** Raw terminal output */
  content: string
  /** Pane ID this was captured from */
  paneId: string
  /** Session name */
  sessionName: string
  /** Capture timestamp */
  capturedAt: string
  /** Number of lines captured */
  lineCount: number
}

/**
 * Parsed terminal state
 */
export interface TerminalState {
  /** Whether Claude is waiting for input */
  isWaitingForInput: boolean
  /** Whether there's a permission prompt */
  hasPermissionPrompt: boolean
  /** The type of permission being requested */
  permissionType?: 'bash' | 'edit' | 'write' | 'other'
  /** Last visible message/output */
  lastMessage: string
  /** Whether Claude is currently processing */
  isProcessing: boolean
  /** Error if detected */
  error?: string
  /** Whether context limit was reached (needs /compact or /clear) */
  hasContextLimit: boolean
}

/**
 * TerminalReader provides high-level access to terminal content
 */
export class TerminalReader {
  /**
   * Capture terminal content from a pane
   * Default to 500 lines to get more context for AI analysis
   */
  static async capture(
    paneId: string,
    sessionName: string,
    lines: number = 500
  ): Promise<TerminalContent> {
    logger.debug(`Capturing terminal content from ${paneId} (${lines} lines)`)

    const content = await TmuxCommands.capturePane(paneId, -lines)

    return {
      content,
      paneId,
      sessionName,
      capturedAt: new Date().toISOString(),
      lineCount: content.split('\n').length,
    }
  }

  /**
   * Parse terminal content to understand Claude's state
   */
  static parseState(content: string): TerminalState {
    // Strip trailing empty lines — tmux panes pad with blanks below actual content
    const rawLines = content.split('\n')
    let lastNonEmpty = rawLines.length - 1
    while (lastNonEmpty >= 0 && rawLines[lastNonEmpty].trim() === '') {
      lastNonEmpty--
    }
    const lines = rawLines.slice(0, lastNonEmpty + 1)
    const lastLines = lines.slice(-50) // Check last 50 lines
    const lastContent = lastLines.join('\n')
    const veryLastLines = lines.slice(-10).join('\n')
    // === PROCESSING DETECTION ===
    // Check spinner characters (Claude Code's animated progress indicator)
    const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    const hasSpinner = spinnerChars.some(char => veryLastLines.includes(char))

    // Claude Code status line words that appear while working
    // These appear at the start of a line during active processing
    const processingIndicators = [
      'Thinking', 'Processing', 'Reading', 'Writing', 'Searching',
      'Analyzing', 'Running', 'Editing', 'Creating', 'Installing',
      'Building', 'Compiling', 'Fetching', 'Downloading', 'Updating',
      'Compacting', 'Resuming',
    ]
    const hasProcessingWord = processingIndicators.some(word => {
      // Must appear as a status indicator (start of a line in last few lines),
      // not just mentioned in Claude's output text
      const lastFew = lines.slice(-5)
      return lastFew.some(l => l.trimStart().startsWith(word))
    })

    // Progress bar pattern — only thick bar ━ (actual progress indicator).
    // NOT thin bar ─ which is Claude Code's UI chrome/separator lines.
    const hasProgressBar = /━{4,}/.test(veryLastLines)

    const isProcessing = hasSpinner || hasProcessingWord || hasProgressBar

    // === PERMISSION PROMPT DETECTION ===
    const permissionPatterns = [
      /Allow\s+\w+\s+to/i,
      /Do you want to (allow|proceed|continue)/i,
      /\(y\/n\)\s*$/m,
      /\[Y\/n\]\s*$/m,
      /\[y\/N\]\s*$/m,
      /Press\s+y\s+to\s+allow/i,
      /Allow\s+.*\?/i,
    ]
    const hasPermissionPrompt = !isProcessing && permissionPatterns.some(pattern => pattern.test(lastContent))

    // Detect permission type
    let permissionType: 'bash' | 'edit' | 'write' | 'other' | undefined
    if (hasPermissionPrompt) {
      if (/Bash|command|execute|run/i.test(lastContent)) {
        permissionType = 'bash'
      } else if (/Edit|modify|update/i.test(lastContent)) {
        permissionType = 'edit'
      } else if (/Write|create\s+file|new\s+file/i.test(lastContent)) {
        permissionType = 'write'
      } else {
        permissionType = 'other'
      }
    }

    // === WAITING FOR INPUT DETECTION ===
    // Claude Code shows "❯" on a line when ready for input.
    // The status bar (username@host, context %) sits BELOW the prompt,
    // so we can't just check the very last line — we check the last ~8 lines.
    const lastFewForPrompt = lines.slice(-8)
    const hasPromptLine = lastFewForPrompt.some(l => {
      const t = l.trim()
      return t === '>' || t === '❯'
    })

    // Also check for the idle notification pattern
    const hasIdleIndicator = veryLastLines.includes('waiting for your input') ||
      veryLastLines.includes('idle_prompt')

    const isWaitingForInput =
      !isProcessing && (
        hasPromptLine ||
        hasPermissionPrompt ||
        hasIdleIndicator
      )

    // Extract last message (non-empty lines, excluding prompts)
    const nonEmptyLines = lastLines
      .filter(l => l.trim().length > 0)
      .filter(l => !['>', '❯', '$'].includes(l.trim()))
    const lastMessage = nonEmptyLines.slice(-10).join('\n')

    // === CONTEXT LIMIT DETECTION ===
    const hasContextLimit =
      lastContent.includes('Context limit reached') ||
      lastContent.includes('0% remaining') ||
      /context\s+(limit|full|exhausted)/i.test(lastContent)

    // === ERROR DETECTION ===
    // Only check errors in the very last lines to avoid matching old output
    let error: string | undefined
    const errorCheckLines = lines.slice(-10).join('\n')
    const errorPatterns = [
      /Error:\s*(.+)/i,
      /error:\s*(.+)/i,
      /failed:\s*(.+)/i,
      /exception:\s*(.+)/i,
      /ENOENT|EPERM|EACCES/,
    ]
    for (const pattern of errorPatterns) {
      const match = errorCheckLines.match(pattern)
      if (match) {
        error = match[1]?.trim() || match[0]?.trim() || 'Unknown error'
        break
      }
    }

    return {
      isWaitingForInput,
      hasPermissionPrompt,
      permissionType,
      lastMessage,
      isProcessing,
      error,
      hasContextLimit,
    }
  }

  /**
   * Send text to a terminal pane
   */
  static async sendText(paneId: string, text: string): Promise<void> {
    logger.debug(`Sending text to ${paneId}: ${text.substring(0, 50)}...`)
    await TmuxCommands.sendKeys(paneId, text)
  }

  /**
   * Send text and press Enter
   * Small delay between text and Enter to ensure tmux processes the text first.
   */
  static async sendTextWithEnter(paneId: string, text: string): Promise<void> {
    await this.sendText(paneId, text)
    await new Promise(resolve => setTimeout(resolve, 50))
    await TmuxCommands.sendEnter(paneId)
  }

  /**
   * Send approval (y + Enter)
   */
  static async sendApproval(paneId: string): Promise<void> {
    logger.debug(`Sending approval to ${paneId}`)
    await TmuxCommands.sendKeys(paneId, 'y')
    await TmuxCommands.sendEnter(paneId)
  }

  /**
   * Send rejection (n + Enter)
   */
  static async sendRejection(paneId: string): Promise<void> {
    logger.debug(`Sending rejection to ${paneId}`)
    await TmuxCommands.sendKeys(paneId, 'n')
    await TmuxCommands.sendEnter(paneId)
  }

  /**
   * Send Escape key
   */
  static async sendEscape(paneId: string): Promise<void> {
    logger.debug(`Sending Escape to ${paneId}`)
    await TmuxCommands.sendSpecialKey(paneId, 'Escape')
  }

  /**
   * Send Ctrl+C to interrupt
   * Uses sendSpecialKey because C-c is a key name, not literal text.
   */
  static async sendInterrupt(paneId: string): Promise<void> {
    logger.debug(`Sending Ctrl+C to ${paneId}`)
    await TmuxCommands.sendSpecialKey(paneId, 'C-c')
  }

  /**
   * Send /compact command to Claude
   */
  static async sendCompact(paneId: string): Promise<void> {
    logger.debug(`Sending /compact to ${paneId}`)
    await this.sendTextWithEnter(paneId, '/compact')
  }

  /**
   * Send /clear command to Claude (full context reset)
   */
  static async sendClear(paneId: string): Promise<void> {
    logger.debug(`Sending /clear to ${paneId}`)
    await this.sendTextWithEnter(paneId, '/clear')
  }

  /**
   * Wait for Claude to be ready for input
   */
  static async waitForReady(
    paneId: string,
    sessionName: string,
    timeoutMs: number = 30000,
    pollIntervalMs: number = 500
  ): Promise<boolean> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
      const content = await this.capture(paneId, sessionName)
      const state = this.parseState(content.content)

      if (state.isWaitingForInput && !state.isProcessing) {
        return true
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    return false
  }
}
