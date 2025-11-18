import { Fork } from './Fork'

/**
 * Representa una sesión de Claude Code
 */
export interface Session {
  /** ID único de la sesión (session-{nanoid}) */
  id: string

  /** Nombre descriptivo de la sesión */
  name: string

  /** Nombre de la sesión tmux (orchestrator-{id}) */
  tmuxSessionName: string

  /** Path absoluto del proyecto */
  projectPath: string

  /** Fecha de creación (ISO timestamp) */
  createdAt: string

  /** Estado: active = tmux corriendo, saved = guardado en disco */
  status: 'active' | 'saved'

  /** Rama principal de la sesión */
  main: MainBranch

  /** Forks (ramas) de esta sesión */
  forks: Fork[]

  /** Última actividad en cualquier parte de la sesión (ISO timestamp) */
  lastActivity: string
}

/**
 * Representa la rama principal de una sesión
 */
export interface MainBranch {
  /** ID del pane tmux (solo si status = 'active') */
  tmuxPaneId?: string

  /** ID de la ventana tmux (solo si status = 'active') */
  tmuxWindowId?: string

  /** Path al contexto guardado (relativo a projectPath) */
  contextPath?: string

  /** Última actividad en main (ISO timestamp) */
  lastActivity: string
}
