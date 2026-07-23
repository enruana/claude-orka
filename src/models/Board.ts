/**
 * Board sessions — Jira-integrated Kanban boards.
 *
 * A Board owns a **master terminal** (a persistent Claude session that pulls
 * from Jira on demand) and one **task terminal** per task in `in-progress`
 * or later. All data lives at:
 *
 *   <project>/.claude-orka/.boards/
 *     index.json                       — manifest of boards in this project
 *     <boardId>/
 *       config.json                    — jiraUrl, jql, columns, sync state
 *       tasks.json                     — BoardTask[]
 *       events.jsonl                   — append-only audit log
 *       pending-drift.json             — [{taskKey, fromStatus, toStatus, detectedAt}]
 *       attachments/<taskKey>/         — comments and docs pulled from Jira
 *
 * All mutations flow through `BoardManager`, which enforces the schema and
 * appends to `events.jsonl`. Both Claude (via the `orka board` CLI) and the
 * web UI (via `/api/board/*`) use the same write path — no direct file
 * editing anywhere.
 */

/** Version of the on-disk board schema. Bump when breaking layout changes. */
export const BOARD_SCHEMA_VERSION = 'v1'

/** Default set of columns when creating a fresh board. Custom Jira workflows
 *  can extend this via `BoardConfig.columns`. */
export const DEFAULT_BOARD_COLUMNS = ['todo', 'in-progress', 'review', 'done'] as const

/**
 * A single ticket mirrored from Jira. Fields are frozen at the moment we
 * pull (or a user command runs); anything the local UI adds — the linked
 * KB entity, the task terminal handles, the worktree — lives inline so the
 * UI can render without a join.
 */
export interface BoardTask {
  /** Jira issue key, e.g. "PROJ-123". Doubles as the primary key locally. */
  key: string

  /** Title / summary shown on the Kanban card. */
  title: string

  /** Full description body (may include markdown / ADF plain-text) */
  description?: string

  /** Current column. Must match one of BoardConfig.columns. */
  status: string

  /** Jira priority label ("High", "Medium", …) */
  priority?: string

  /** Assignee display name (from Jira). Not resolved to an Orka user id. */
  assignee?: string

  /** Reporter display name (from Jira). */
  reporter?: string

  /** Jira labels array. */
  labels?: string[]

  /** Canonical URL to the ticket. */
  jiraUrl: string

  /** Orka KB entity id for the linked `task` entity. Set at task boot. */
  kbEntityId?: string

  /** Claude session id (`claude --session-id`) of the task terminal. Kept
   *  across close/reopen so we can `claude --resume` and preserve the
   *  full conversation history when the user re-enters an old task. */
  claudeSessionId?: string

  /** tmux pane id of the task's terminal (only meaningful while alive). */
  terminalPaneId?: string

  /** tmux session name owning that pane, e.g. `orka-board-task-PROJ-123`. */
  terminalTmuxSessionId?: string

  /** ttyd port serving the task terminal's browser iframe. */
  ttydPort?: number

  /** ttyd PID for cleanup. */
  ttydPid?: number

  /** Absolute worktree path created by moxikit (or manual git worktree). */
  worktreePath?: string

  /** Branch name for the worktree. */
  branchName?: string

  /** ISO timestamp of first local creation. */
  createdAt: string

  /** ISO timestamp of last local mutation (any field). */
  updatedAt: string

  /** Arbitrary Jira dump — useful for custom fields the schema doesn't
   *  spell out (customfield_XXXXX). Never rendered directly by the UI. */
  raw?: unknown
}

/**
 * Per-board configuration.
 */
export interface BoardConfig {
  /** Stable board id (nanoid). Used as directory name under .boards/. */
  id: string

  /** Human-readable name shown in the UI. Editable. */
  name: string

  /** Canonical Jira URL of the board (or of the Jira instance if we don't
   *  need per-board granularity). */
  jiraUrl: string

  /** Optional JQL that overrides the default "assignee = currentUser() AND
   *  resolution = Unresolved". */
  jql?: string

  /** Ordered column names. Cards render in the order of this array. */
  columns: string[]

  /** Id of the master prompt template to run at boot. Falls back to the
   *  hard-coded default if empty. */
  masterPromptId?: string

  /** Id of the sync prompt the master runs on `sync`. */
  syncPromptId?: string

  /** ISO timestamp of the last successful sync (server-side clock). */
  lastSyncedAt?: string

  /** ISO creation timestamp. */
  createdAt: string

  /** Schema version this board file was written under. */
  schemaVersion: string
}

/**
 * Manifest of all boards in a project. Lets the CLI and API answer
 * "which boards live here?" without walking the directory.
 */
export interface BoardIndex {
  boards: Array<Pick<BoardConfig, 'id' | 'name' | 'jiraUrl' | 'createdAt'>>
}

/**
 * A single pending drift record — a Jira status change we noticed during
 * sync that has no matching local mutation. Surfaced to the UI as a badge
 * on the affected card; user accepts (spawns a terminal) or dismisses.
 */
export interface BoardDrift {
  taskKey: string
  fromStatus: string
  toStatus: string
  detectedAt: string
}

/** Everything under `pending-drift.json`. */
export interface BoardPendingDrifts {
  drifts: BoardDrift[]
}

/**
 * Append-only audit event. Same shape as KB events for consistency.
 * `payload` shape depends on `event`.
 */
export interface BoardEvent {
  ts: string
  event:
    | 'board.created'
    | 'board.updated'
    | 'board.deleted'
    | 'task.added'
    | 'task.updated'
    | 'task.removed'
    | 'task.terminal.attached'
    | 'task.terminal.detached'
    | 'drift.marked'
    | 'drift.acknowledged'
    | 'sync.started'
    | 'sync.completed'
    | 'attachment.comment'
    | 'attachment.doc'
  actor?: string
  taskKey?: string
  payload?: Record<string, unknown>
}

/**
 * A comment mirrored from Jira and stashed under
 * `attachments/<taskKey>/comments.jsonl`.
 */
export interface BoardCommentRecord {
  author: string
  body: string
  createdAt?: string
  jiraCommentId?: string
  storedAt: string
}
