/**
 * Representa un fork (rama de conversación) de una sesión
 */
export interface Fork {
  /** ID único del fork (internal) */
  id: string

  /** Nombre descriptivo del fork */
  name: string

  /** ID de la sesión de Claude del fork (UUID) */
  claudeSessionId: string

  /** ID del pane tmux (solo si status = 'active') */
  tmuxPaneId?: string

  /** Fecha de creación (ISO timestamp) */
  createdAt: string

  /** Estado del fork */
  status: 'active' | 'saved' | 'merged'

  /** Path al contexto exportado (solo para merge, relativo a projectPath) */
  contextPath?: string

  /** Si el fork ya fue mergeado a main */
  mergedToMain?: boolean

  /** Fecha en que se hizo merge (ISO timestamp) */
  mergedAt?: string
}
