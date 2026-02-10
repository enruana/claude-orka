/**
 * MCP Terminal Tools for Agent
 * These tools allow the Agent's Claude session to interact with monitored terminals
 */

import { TerminalReader } from '../TerminalReader'
import { logger } from '../../utils'

/**
 * Tool definitions for MCP
 */
export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, {
      type: string
      description: string
      enum?: string[]
    }>
    required: string[]
  }
}

/**
 * Tool execution result
 */
export interface MCPToolResult {
  success: boolean
  content?: string
  error?: string
}

/**
 * Terminal tools for MCP
 */
export const terminalTools: MCPToolDefinition[] = [
  {
    name: 'read_terminal',
    description: 'Read the current content of the monitored terminal. Returns the last N lines of terminal output.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'string',
          description: 'The tmux pane ID to read from (e.g., "%0", "%1")',
        },
        lines: {
          type: 'string',
          description: 'Number of lines to read (default: 200)',
        },
      },
      required: ['pane_id'],
    },
  },
  {
    name: 'send_to_terminal',
    description: 'Send text input to the monitored terminal. The text will be typed as if a user was typing.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'string',
          description: 'The tmux pane ID to send to',
        },
        text: {
          type: 'string',
          description: 'The text to send',
        },
        press_enter: {
          type: 'string',
          description: 'Whether to press Enter after sending (default: true)',
          enum: ['true', 'false'],
        },
      },
      required: ['pane_id', 'text'],
    },
  },
  {
    name: 'send_approval',
    description: 'Send an approval response (y + Enter) to a permission prompt in the terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'string',
          description: 'The tmux pane ID',
        },
      },
      required: ['pane_id'],
    },
  },
  {
    name: 'send_rejection',
    description: 'Send a rejection response (n + Enter) to a permission prompt in the terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'string',
          description: 'The tmux pane ID',
        },
      },
      required: ['pane_id'],
    },
  },
  {
    name: 'compact_context',
    description: 'Send the /compact command to Claude in the terminal to reduce context size.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'string',
          description: 'The tmux pane ID',
        },
      },
      required: ['pane_id'],
    },
  },
  {
    name: 'send_interrupt',
    description: 'Send Ctrl+C to interrupt the current operation in the terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'string',
          description: 'The tmux pane ID',
        },
      },
      required: ['pane_id'],
    },
  },
  {
    name: 'request_human_help',
    description: 'Request help from the human operator. Use this when you cannot determine the appropriate action or when the situation requires human judgment.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Explanation of why human help is needed',
        },
        context: {
          type: 'string',
          description: 'Additional context about the current situation',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'get_terminal_state',
    description: 'Analyze the current terminal state to understand what Claude is doing and whether it needs input.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'string',
          description: 'The tmux pane ID',
        },
      },
      required: ['pane_id'],
    },
  },
]

/**
 * Execute a terminal tool
 */
export async function executeTerminalTool(
  toolName: string,
  args: Record<string, string>,
  context: { agentId: string; sessionName: string }
): Promise<MCPToolResult> {
  logger.debug(`Executing terminal tool: ${toolName}`, args)

  try {
    switch (toolName) {
      case 'read_terminal': {
        const lines = parseInt(args.lines || '200', 10)
        const content = await TerminalReader.capture(args.pane_id, context.sessionName, lines)
        return {
          success: true,
          content: content.content,
        }
      }

      case 'send_to_terminal': {
        const pressEnter = args.press_enter !== 'false'
        if (pressEnter) {
          await TerminalReader.sendTextWithEnter(args.pane_id, args.text)
        } else {
          await TerminalReader.sendText(args.pane_id, args.text)
        }
        return {
          success: true,
          content: `Sent text to terminal${pressEnter ? ' and pressed Enter' : ''}`,
        }
      }

      case 'send_approval': {
        await TerminalReader.sendApproval(args.pane_id)
        return {
          success: true,
          content: 'Sent approval (y + Enter)',
        }
      }

      case 'send_rejection': {
        await TerminalReader.sendRejection(args.pane_id)
        return {
          success: true,
          content: 'Sent rejection (n + Enter)',
        }
      }

      case 'compact_context': {
        await TerminalReader.sendCompact(args.pane_id)
        return {
          success: true,
          content: 'Sent /compact command',
        }
      }

      case 'send_interrupt': {
        await TerminalReader.sendInterrupt(args.pane_id)
        return {
          success: true,
          content: 'Sent Ctrl+C interrupt',
        }
      }

      case 'request_human_help': {
        // This tool is handled by the AgentDaemon
        // Here we just return a message
        return {
          success: true,
          content: JSON.stringify({
            type: 'human_help_request',
            reason: args.reason,
            context: args.context,
            agentId: context.agentId,
          }),
        }
      }

      case 'get_terminal_state': {
        const content = await TerminalReader.capture(args.pane_id, context.sessionName)
        const state = TerminalReader.parseState(content.content)
        return {
          success: true,
          content: JSON.stringify(state, null, 2),
        }
      }

      default:
        return {
          success: false,
          error: `Unknown tool: ${toolName}`,
        }
    }
  } catch (error: any) {
    logger.error(`Terminal tool ${toolName} failed:`, error)
    return {
      success: false,
      error: error.message,
    }
  }
}
