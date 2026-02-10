/**
 * Agent model - represents a Master Agent that monitors and controls Claude Code sessions
 */

/**
 * Agent status
 */
export type AgentStatus = 'idle' | 'active' | 'paused' | 'waiting_human' | 'error'

/**
 * Hook event types that can trigger an agent
 * Based on Claude Code's available hooks
 */
export type AgentHookTrigger =
  | 'Stop'              // Claude Code stopped, waiting for input
  | 'Notification'      // Notification sent (including errors)
  | 'SubagentStop'      // A subagent stopped
  | 'PreCompact'        // About to compact (trigger: 'auto' = context full)
  | 'SessionStart'      // Session started (source: 'compact'|'clear'|'resume'|'startup')
  | 'SessionEnd'        // Session ended (reason: error, user exit, etc)
  | 'PreToolUse'        // Before a tool is used
  | 'PostToolUse'       // After a tool is used

/**
 * Description of each hook event for UI display
 */
export const HOOK_EVENT_DESCRIPTIONS: Record<AgentHookTrigger, string> = {
  Stop: 'When Claude Code stops and waits for input',
  Notification: 'When a notification is sent (including errors)',
  SubagentStop: 'When a subagent (Task) stops',
  PreCompact: 'Before compacting context (auto = context window full)',
  SessionStart: 'After session starts (compact/clear finished, or resume)',
  SessionEnd: 'When session ends (error, user exit, etc)',
  PreToolUse: 'Before any tool is executed',
  PostToolUse: 'After any tool is executed',
}

/**
 * Notification channel configuration
 */
export interface NotificationConfig {
  /** Enable Telegram notifications */
  telegram?: {
    enabled: boolean
    botToken?: string
    chatId?: string
  }
  /** Enable Web Push notifications */
  webPush?: {
    enabled: boolean
    endpoint?: string
    p256dh?: string
    auth?: string
  }
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

  /** Agent's own Claude session ID (for its Claude Code instance) */
  claudeSessionId?: string

  /** Agent's own tmux session ID (orka-agent-{id}) */
  tmuxSessionId?: string

  /** Agent's own tmux pane ID */
  tmuxPaneId?: string

  /** Hook events that trigger this agent */
  hookEvents: AgentHookTrigger[]

  /** Notification configuration */
  notifications: NotificationConfig

  /** Auto-approve tool calls in monitored sessions */
  autoApprove: boolean

  /** Maximum consecutive responses before requiring human input */
  maxConsecutiveResponses: number

  /** Current consecutive response count */
  consecutiveResponses: number

  /** Number of recent decisions to include as context (rolling window) */
  decisionHistorySize: number

  /** Creation timestamp */
  createdAt: string

  /** Last activity timestamp */
  lastActivity?: string

  /** Last error message (if status is 'error') */
  lastError?: string
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
    notifications: {},
    autoApprove: false,
    maxConsecutiveResponses: 5,
    consecutiveResponses: 0,
    decisionHistorySize: 5,
    createdAt: new Date().toISOString(),
    ...options,
  }
}
