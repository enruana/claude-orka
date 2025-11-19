/**
 * Representa un fork (rama de conversación) de una sesión
 */
export interface Fork {
  /** ID único del fork (internal) */
  id: string

  /** Descriptive fork name */
  name: string

  /** Claude fork session ID (UUID) */
  claudeSessionId: string

  /** ID del pane tmux (solo si status = 'active') */
  tmuxPaneId?: string

  /** Creation date (ISO timestamp) */
  createdAt: string

  /** Fork status */
  status: 'active' | 'saved' | 'merged'

  /** Path al contexto exportado (solo para merge, relativo a projectPath) */
  contextPath?: string

  /** Si el fork ya fue mergeado a main */
  mergedToMain?: boolean

  /** Fecha en que se hizo merge (ISO timestamp) */
  mergedAt?: string
}
