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
    const lines = content.split('\n')
    const lastLines = lines.slice(-50) // Check last 50 lines
    const lastContent = lastLines.join('\n')
    const veryLastLines = lines.slice(-10).join('\n')

    // Check for processing indicators FIRST (spinner characters)
    const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    const hasSpinner = spinnerChars.some(char => veryLastLines.includes(char))
    const isProcessing =
      hasSpinner ||
      veryLastLines.includes('Thinking') ||
      veryLastLines.includes('Processing') ||
      veryLastLines.includes('Reading') ||
      veryLastLines.includes('Writing') ||
      veryLastLines.includes('Searching')

    // Check for permission prompts - be more specific
    const permissionPatterns = [
      /Allow\s+\w+\s+to/i,
      /Do you want to (allow|proceed|continue)/i,
      /\(y\/n\)\s*$/m,
      /\[Y\/n\]\s*$/m,
      /\[y\/N\]\s*$/m,
      /Press\s+y\s+to\s+allow/i,
      /Allow\s+.*\?/i,
    ]
    const hasPermissionPrompt = permissionPatterns.some(pattern => pattern.test(lastContent))

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

    // Check for waiting for input - only if NOT processing
    // Look for Claude's input prompt at the very end
    const inputPromptPatterns = [
      /^>\s*$/m,           // Claude Code's typical prompt
      /❯\s*$/m,            // Alternative prompt
      /\$\s*$/m,           // Shell prompt (shouldn't happen inside Claude)
      /\?\s*$/m,           // Question ending
    ]

    // Claude Code typically shows ">" on a new line when waiting for input
    const trimmedEnd = content.trim()
    const lastLine = trimmedEnd.split('\n').pop() || ''
    const isWaitingForInput =
      !isProcessing && (
        lastLine === '>' ||
        lastLine === '❯' ||
        lastLine.endsWith('>') ||
        hasPermissionPrompt ||
        inputPromptPatterns.some(pattern => pattern.test(veryLastLines))
      )

    // Extract last message (non-empty lines, excluding prompts)
    const nonEmptyLines = lastLines
      .filter(l => l.trim().length > 0)
      .filter(l => !['>', '❯', '$'].includes(l.trim()))
    const lastMessage = nonEmptyLines.slice(-10).join('\n')

    // Check for errors
    let error: string | undefined
    const errorPatterns = [
      /Error:\s*(.+)/i,
      /error:\s*(.+)/i,
      /failed:\s*(.+)/i,
      /exception:\s*(.+)/i,
      /ENOENT|EPERM|EACCES/,
    ]
    for (const pattern of errorPatterns) {
      const match = lastContent.match(pattern)
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
   */
  static async sendTextWithEnter(paneId: string, text: string): Promise<void> {
    await this.sendText(paneId, text)
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
   */
  static async sendInterrupt(paneId: string): Promise<void> {
    logger.debug(`Sending Ctrl+C to ${paneId}`)
    await TmuxCommands.sendKeys(paneId, 'C-c')
  }

  /**
   * Send /compact command to Claude
   */
  static async sendCompact(paneId: string): Promise<void> {
    logger.debug(`Sending /compact to ${paneId}`)
    await this.sendTextWithEnter(paneId, '/compact')
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
