/**
 * Agent model - represents a Master Agent that monitors and controls Claude Code sessions
 *
 * Phase 1: Minimal viable agent
 */

/**
 * Agent status
 */
export type AgentStatus = 'idle' | 'active' | 'error'

/**
 * Hook event types that can trigger an agent
 * Based on Claude Code's available hooks (complete list as of 2026)
 */
export type AgentHookTrigger =
  | 'Stop'                // Claude Code stopped, waiting for input
  | 'Notification'        // Notification sent (including errors, permission prompts)
  | 'SubagentStop'        // A subagent stopped
  | 'PreCompact'          // About to compact (trigger: 'auto' = context full)
  | 'SessionStart'        // Session started (source: 'compact'|'clear'|'resume'|'startup')
  | 'SessionEnd'          // Session ended (reason: error, user exit, etc)
  | 'PreToolUse'          // Before a tool is used
  | 'PostToolUse'         // After a tool is used
  | 'PostToolUseFailure'  // After a tool use fails (errors, interrupts)
  | 'PermissionRequest'   // When a permission dialog appears
  | 'UserPromptSubmit'    // When user submits a prompt (before processing)
  | 'SubagentStart'       // When a subagent is spawned
  | 'TeammateIdle'        // When an agent team teammate is about to go idle
  | 'TaskCompleted'       // When a task is being marked as completed

/**
 * Description of each hook event for UI display
 */
export const HOOK_EVENT_DESCRIPTIONS: Record<AgentHookTrigger, string> = {
  Stop: 'When Claude Code stops and waits for input (NOT on user interrupt)',
  Notification: 'When a notification is sent (errors, permission prompts, etc)',
  SubagentStop: 'When a subagent (Task) stops',
  PreCompact: 'Before compacting context (auto = context window full)',
  SessionStart: 'After session starts (compact/clear finished, or resume)',
  SessionEnd: 'When session ends (error, user exit, etc)',
  PreToolUse: 'Before any tool is executed',
  PostToolUse: 'After any tool is executed',
  PostToolUseFailure: 'After a tool use fails (errors, interrupts, context limit)',
  PermissionRequest: 'When a permission dialog appears',
  UserPromptSubmit: 'When user submits a prompt (before processing)',
  SubagentStart: 'When a subagent is spawned',
  TeammateIdle: 'When an agent team teammate is about to go idle',
  TaskCompleted: 'When a task is being marked as completed',
}

/**
 * Agent connection to a project
 */
export interface AgentConnection {
  /** Project path being monitored */
  projectPath: string
  /** Session ID within the project (optional, monitors all if not set) */
  sessionId?: string
  /** tmux pane ID being monitored */
  tmuxPaneId?: string
  /** Claude session UUID for this specific pane (used for hook event filtering) */
  claudeSessionId?: string
  /** Branch identifier: 'main' or fork ID (e.g., 'fork-abc123') */
  branchId?: string
  /** Connected at timestamp */
  connectedAt: string
}

/**
 * Agent represents a Master Agent that acts as a "virtual human"
 * It monitors Claude Code sessions and responds based on a Master Prompt
 */
export interface Agent {
  /** Unique agent ID */
  id: string

  /** Human-readable agent name */
  name: string

  /** Current agent status */
  status: AgentStatus

  /** The Master Prompt that guides agent behavior */
  masterPrompt: string

  /** Connection to a project (if connected) */
  connection?: AgentConnection

  /** Hook events that trigger this agent */
  hookEvents: AgentHookTrigger[]

  /** Auto-approve tool calls in monitored sessions */
  autoApprove: boolean

  /** Telegram bot configuration for this agent */
  telegram?: TelegramConfig

  /** Creation timestamp */
  createdAt: string

  /** Last activity timestamp */
  lastActivity?: string

  /** Last error message (if status is 'error') */
  lastError?: string
}

/**
 * Telegram bot configuration
 */
export interface TelegramConfig {
  /** Bot token from BotFather */
  botToken: string
  /** Authorized chat ID (your Telegram user ID) */
  chatId: number
  /** Whether the bot is enabled */
  enabled: boolean
}

/**
 * Agent state stored in ~/.claude-orka/agents.json
 */
export interface AgentState {
  /** State version for migrations */
  version: string

  /** All registered agents */
  agents: Agent[]

  /** Hook server port */
  hookServerPort: number

  /** Last updated timestamp */
  lastUpdated: string
}

/**
 * Default agent state
 */
export const DEFAULT_AGENT_STATE: AgentState = {
  version: '1.0.0',
  agents: [],
  hookServerPort: 9999,
  lastUpdated: new Date().toISOString(),
}

/**
 * Create a new agent with defaults
 */
export function createAgent(
  id: string,
  name: string,
  masterPrompt: string,
  options: Partial<Agent> = {}
): Agent {
  return {
    id,
    name,
    status: 'idle',
    masterPrompt,
    hookEvents: ['Stop'],
    autoApprove: false,
    createdAt: new Date().toISOString(),
    ...options,
  }
}
