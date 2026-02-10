/**
 * AgentMCPServer - MCP server configuration for Agent tools
 * Provides terminal control tools to the Agent's Claude session
 *
 * Note: This file provides the configuration and interface for MCP tools.
 * The actual MCP server would be implemented when @modelcontextprotocol/sdk is installed.
 */

import { logger } from '../../utils'
import { terminalTools, executeTerminalTool, MCPToolDefinition, MCPToolResult } from './terminal-tools'

/**
 * MCP Server configuration
 */
export interface AgentMCPServerConfig {
  agentId: string
  agentName: string
  sessionName: string
  paneId: string
}

/**
 * Simple tool executor for agent operations
 * This can be used directly without the MCP SDK
 */
export class AgentToolExecutor {
  private config: AgentMCPServerConfig

  constructor(config: AgentMCPServerConfig) {
    this.config = config
  }

  /**
   * Get available tools
   */
  getTools(): MCPToolDefinition[] {
    return terminalTools
  }

  /**
   * Execute a tool
   */
  async execute(toolName: string, args: Record<string, string>): Promise<MCPToolResult> {
    // Add default pane_id if not provided
    const toolArgs = { ...args }
    if (!toolArgs.pane_id && this.config.paneId) {
      toolArgs.pane_id = this.config.paneId
    }

    return executeTerminalTool(toolName, toolArgs, {
      agentId: this.config.agentId,
      sessionName: this.config.sessionName,
    })
  }
}

/**
 * Create an agent tool executor
 */
export function createAgentToolExecutor(config: AgentMCPServerConfig): AgentToolExecutor {
  logger.info(`Creating tool executor for agent: ${config.agentName} (${config.agentId})`)
  return new AgentToolExecutor(config)
}

/**
 * Generate MCP server configuration for Claude settings
 * This is the configuration that would be added to Claude's settings.json
 * to enable MCP tools for the agent
 */
export function generateMCPConfig(config: AgentMCPServerConfig): object {
  return {
    mcpServers: {
      [`orka-agent-${config.agentId}`]: {
        command: 'node',
        args: [
          // Path to the MCP server entry point (when MCP SDK is installed)
          'dist/agent/mcp/server.js',
        ],
        env: {
          ORKA_AGENT_ID: config.agentId,
          ORKA_AGENT_NAME: config.agentName,
          ORKA_SESSION_NAME: config.sessionName,
          ORKA_PANE_ID: config.paneId,
        },
      },
    },
  }
}

/**
 * Export tool definitions for external use
 */
export { terminalTools, executeTerminalTool }
export type { MCPToolDefinition, MCPToolResult }
