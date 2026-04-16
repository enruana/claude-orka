import { Fork } from './Fork'

/**
 * Position for UI node placement
 */
export interface NodePosition {
  x: number
  y: number
}

/**
 * Representa una sesión de Claude Code
 */
export interface Session {
  /** ID único de la sesión (session-{nanoid}) */
  id: string

  /** Descriptive session name */
  name: string

  /** Session ID tmux (orka-{id}) */
  tmuxSessionId: string

  /** Estado: active = tmux corriendo, saved = guardado en disco */
  status: 'active' | 'saved'

  /** Creation date (ISO timestamp) */
  createdAt: string

  /** Last activity en cualquier parte de la sesión (ISO timestamp) */
  lastActivity: string

  /** Rama principal de la sesión */
  main: MainBranch

  /** Forks (ramas) de esta sesión */
  forks: Fork[]

  /** UI node positions (keyed by node id: 'main' or fork id) */
  nodePositions?: Record<string, NodePosition>

  /** ttyd web terminal port (for remote access) */
  ttydPort?: number

  /** ttyd process ID (for cleanup) */
  ttydPid?: number

  /** Manually-created tmux panes (e.g. via Ctrl-B "). Persisted so the layout
   *  is recreated on session resume. Content/shell state is not preserved —
   *  recreated panes just re-cd into the saved path. */
  untrackedPanes?: UntrackedPane[]
}

/** A tmux pane the user created manually (not a Claude fork) */
export interface UntrackedPane {
  /** tmux pane id (e.g. %3) — may change across restarts */
  tmuxPaneId: string
  /** Current working directory of the pane, used to re-cd on recovery */
  currentPath?: string
  /** Last command running in the pane (informational only) */
  currentCommand?: string
  /** When this pane was first detected */
  createdAt: string
}

/**
 * Representa la rama principal de una sesión
 */
export interface MainBranch {
  /** Claude session ID (UUID) */
  claudeSessionId: string

  /** ID del pane tmux (solo si status = 'active') */
  tmuxPaneId?: string

  /** Main branch status */
  status: 'active' | 'saved'

  /** Path al contexto exportado (solo para merge, relativo a projectPath) */
  contextPath?: string

  /** Cached context summary from last close/detach (used during resume as fallback) */
  lastContextSummary?: string
}
