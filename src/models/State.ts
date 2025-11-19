import { Session } from './Session'

/**
 * Estado global del proyecto almacenado en .claude-orka/state.json
 */
export interface ProjectState {
  /** Versión del formato del estado */
  version: string

  /** Path absoluto del proyecto */
  projectPath: string

  /** Todas las sesiones del proyecto (activas y guardadas) */
  sessions: Session[]

  /** Last state update (ISO timestamp) */
  lastUpdated: string
}

/**
 * Filtros para buscar sesiones
 */
export interface SessionFilters {
  /** Filtrar por estado: active = tmux corriendo, saved = guardado */
  status?: 'active' | 'saved'

  /** Filtrar por nombre de sesión */
  name?: string
}
