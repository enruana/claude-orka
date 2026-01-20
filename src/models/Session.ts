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

  /** Web wrapper server port (serves virtual keyboard UI) */
  webWrapperPort?: number

  /** Web wrapper server PID (for cleanup) */
  webWrapperPid?: number
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
}
