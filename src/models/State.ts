import { Session } from './Session'

/**
 * A task/todo item associated with a project
 */
export interface ProjectTask {
  id: string
  title: string
  completed: boolean
  createdAt: string
  completedAt?: string
}

/**
 * A review comment anchored to a file location
 */
export interface ProjectComment {
  id: string
  filePath: string
  startLine: number
  endLine: number
  selectedText: string
  body: string
  resolved: boolean
  createdAt: string
  resolvedAt?: string
}

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

  /** Project tasks/todos */
  tasks?: ProjectTask[]

  /** Document review comments */
  comments?: ProjectComment[]

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
