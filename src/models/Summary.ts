/**
 * Fork summary
 */
export interface ForkSummary {
  /** Fork ID */
  id: string

  /** Fork name */
  name: string

  /** Claude fork session ID (para restaurar) */
  claudeSessionId: string

  /** Fork status */
  status: 'active' | 'saved' | 'closed' | 'merged'

  /** Creation date */
  createdAt: string

  /** Whether it has exported context (para merge) */
  hasContext: boolean

  /** Path to exported context (solo si hasContext = true) */
  contextPath?: string

  /** Whether it was merged to main */
  mergedToMain: boolean

  /** Merge date (si fue mergeado) */
  mergedAt?: string
}

/**
 * Session summary
 */
export interface SessionSummary {
  /** Session ID */
  id: string

  /** Session name */
  name: string

  /** Claude session ID (para restaurar) */
  claudeSessionId: string

  /** Session status */
  status: 'active' | 'saved'

  /** Creation date */
  createdAt: string

  /** Last activity */
  lastActivity: string

  /** Total forks */
  totalForks: number

  /** Active forks */
  activeForks: number

  /** Saved forks */
  savedForks: number

  /** Merged forks */
  mergedForks: number

  /** List of forks with their summary */
  forks: ForkSummary[]
}

/**
 * Complete project summary
 */
export interface ProjectSummary {
  /** Project path */
  projectPath: string

  /** Total sessions */
  totalSessions: number

  /** Active sessions */
  activeSessions: number

  /** Saved sessions */
  savedSessions: number

  /** List of sessions with their summary */
  sessions: SessionSummary[]

  /** Last state update */
  lastUpdated: string
}
