/**
 * Hook event payload - received from Claude Code hooks
 */

/**
 * Hook event type (matches Claude Code hook names — complete list as of 2026)
 */
export type HookEventType =
  | 'Stop'
  | 'Notification'
  | 'SubagentStop'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PreCompact'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PermissionRequest'
  | 'UserPromptSubmit'
  | 'SubagentStart'
  | 'TeammateIdle'
  | 'TaskCompleted'

/**
 * Tool use information for PreToolUse/PostToolUse hooks
 */
export interface ToolUseInfo {
  /** Tool name */
  tool_name: string
  /** Tool input parameters */
  tool_input: Record<string, unknown>
}

/**
 * Stop hook payload - sent when Claude Code stops
 */
export interface StopHookPayload {
  /** Reason for stopping */
  stop_hook_active: boolean
  /** Session transcript path */
  session_id?: string
  /** Working directory */
  cwd?: string
  /** Last message from Claude */
  last_message?: string
}

/**
 * Notification hook payload
 */
export interface NotificationHookPayload {
  /** Notification title */
  title?: string
  /** Notification body */
  body?: string
  /** Notification type */
  type?: 'info' | 'warning' | 'error'
}

/**
 * PreCompact hook payload
 */
export interface PreCompactHookPayload {
  /** What triggered the compact */
  trigger: 'manual' | 'auto'
  /** Custom instructions for compact */
  custom_instructions?: string | null
}

/**
 * SessionStart hook payload
 */
export interface SessionStartHookPayload {
  /** What caused the session to start */
  source: 'startup' | 'resume' | 'clear' | 'compact'
}

/**
 * SessionEnd hook payload
 */
export interface SessionEndHookPayload {
  /** Reason for session end */
  reason: string
}

/**
 * PostToolUseFailure hook payload — fires when a tool execution fails
 */
export interface PostToolUseFailurePayload {
  /** Tool that failed */
  tool_name: string
  /** Input that was passed to the tool */
  tool_input?: Record<string, unknown>
  /** Tool use ID */
  tool_use_id?: string
  /** Error message */
  error: string
  /** Whether the failure was due to a user interrupt */
  is_interrupt: boolean
}

/**
 * PermissionRequest hook payload — fires when a permission dialog appears
 */
export interface PermissionRequestPayload {
  /** Tool requesting permission */
  tool_name: string
  /** Tool input parameters */
  tool_input?: Record<string, unknown>
}

/**
 * Generic hook event payload received from Claude Code
 */
export interface HookEventPayload {
  /** Event type */
  event_type: HookEventType

  /** Timestamp of the event */
  timestamp: string

  /** Session ID (Claude session, not Orka session) */
  session_id?: string

  /** Working directory where Claude is running */
  cwd?: string

  /** Stop hook specific data */
  stop_data?: StopHookPayload

  /** Notification specific data */
  notification_data?: NotificationHookPayload

  /** Tool use specific data */
  tool_data?: ToolUseInfo

  /** PreCompact specific data */
  compact_data?: PreCompactHookPayload

  /** SessionStart specific data */
  session_start_data?: SessionStartHookPayload

  /** SessionEnd specific data */
  session_end_data?: SessionEndHookPayload

  /** PostToolUseFailure specific data */
  tool_failure_data?: PostToolUseFailurePayload

  /** PermissionRequest specific data */
  permission_request_data?: PermissionRequestPayload

  /** Raw stdin data if available */
  raw_stdin?: string
}

/**
 * Processed hook event with additional metadata
 */
export interface ProcessedHookEvent {
  /** Original payload */
  payload: HookEventPayload

  /** Agent ID that should handle this event */
  agentId: string

  /** Project path the event came from */
  projectPath: string

  /** Orka session ID (if known) */
  orkaSessionId?: string

  /** Terminal content at time of event */
  terminalContent?: string

  /** Received timestamp */
  receivedAt: string

  /** Processing status */
  status: 'pending' | 'processing' | 'completed' | 'failed'

  /** Error message if failed */
  error?: string
}
