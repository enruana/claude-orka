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
 * A KB entity the user has pinned to the floating action button as a
 * quick shortcut. Denormalized: title/type/folderPath are frozen at pin
 * time so the FAB can render without hitting the KB on every draw.
 * Re-pin to refresh.
 */
export interface ProjectPin {
  /** KB entity id (e.g. "prj-0DoR4EtJ"). Doubles as the unpin key. */
  entityId: string

  /** KB entity title at pin time. */
  title: string

  /** KB entity type ("project", "initiative", "task", …) — used for the
   *  chip color/icon. */
  type: string

  /** Project-relative folder path — where a click on the pin navigates
   *  to (via `/projects/<encoded>/files?path=<folderPath>`). Resolved
   *  from the entity's path-like properties at pin time. */
  folderPath: string

  /** ISO timestamp — pins are rendered most-recent first. */
  pinnedAt: string
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

  /** KB entities pinned to the floating action button. */
  pins?: ProjectPin[]

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
