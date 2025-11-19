import { Fork } from './Fork'

/**
 * Representa una sesión de Claude Code
 */
export interface Session {
  /** ID único de la sesión (session-{nanoid}) */
  id: string

  /** Nombre descriptivo de la sesión */
  name: string

  /** ID de la sesión tmux (orka-{id}) */
  tmuxSessionId: string

  /** Estado: active = tmux corriendo, saved = guardado en disco */
  status: 'active' | 'saved'

  /** Fecha de creación (ISO timestamp) */
  createdAt: string

  /** Última actividad en cualquier parte de la sesión (ISO timestamp) */
  lastActivity: string

  /** Rama principal de la sesión */
  main: MainBranch

  /** Forks (ramas) de esta sesión */
  forks: Fork[]
}

/**
 * Representa la rama principal de una sesión
 */
export interface MainBranch {
  /** ID de la sesión de Claude (UUID) */
  claudeSessionId: string

  /** ID del pane tmux (solo si status = 'active') */
  tmuxPaneId?: string

  /** Estado de la rama principal */
  status: 'active' | 'saved'

  /** Path al contexto exportado (solo para merge, relativo a projectPath) */
  contextPath?: string
}
