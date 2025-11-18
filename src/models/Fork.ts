/**
 * Representa un fork (rama de conversación) de una sesión
 */
export interface Fork {
  /** ID único del fork (fork-{name?}-{nanoid}) */
  id: string

  /** Nombre descriptivo del fork */
  name: string

  /** ID del pane tmux (solo si status = 'active') */
  tmuxPaneId?: string

  /** ID del padre: 'main' o ID de otro fork */
  parentId: string

  /** Fecha de creación (ISO timestamp) */
  createdAt: string

  /** Path al contexto guardado (relativo a projectPath) */
  contextPath?: string

  /** Estado del fork */
  status: 'active' | 'saved' | 'merged'

  /** Última actividad en este fork (ISO timestamp) */
  lastActivity: string

  /** Si el fork ya fue mergeado a main */
  mergedToMain?: boolean

  /** Fecha en que se hizo merge (ISO timestamp) */
  mergedAt?: string
}
