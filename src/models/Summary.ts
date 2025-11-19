/**
 * Resumen de un fork
 */
export interface ForkSummary {
  /** ID del fork */
  id: string

  /** Nombre del fork */
  name: string

  /** Estado del fork */
  status: 'active' | 'saved' | 'merged'

  /** Fecha de creación */
  createdAt: string

  /** Si tiene contexto exportado */
  hasContext: boolean

  /** Path del contexto (si existe) */
  contextPath?: string

  /** Si fue mergeado a main */
  mergedToMain: boolean

  /** Fecha de merge (si fue mergeado) */
  mergedAt?: string
}

/**
 * Resumen de una sesión
 */
export interface SessionSummary {
  /** ID de la sesión */
  id: string

  /** Nombre de la sesión */
  name: string

  /** Estado de la sesión */
  status: 'active' | 'saved'

  /** Fecha de creación */
  createdAt: string

  /** Última actividad */
  lastActivity: string

  /** Si tiene contexto del main exportado */
  hasMainContext: boolean

  /** Path del contexto del main (si existe) */
  mainContextPath?: string

  /** Total de forks */
  totalForks: number

  /** Forks activos */
  activeForks: number

  /** Forks guardados */
  savedForks: number

  /** Forks mergeados */
  mergedForks: number

  /** Lista de forks con su resumen */
  forks: ForkSummary[]
}

/**
 * Resumen completo del proyecto
 */
export interface ProjectSummary {
  /** Path del proyecto */
  projectPath: string

  /** Total de sesiones */
  totalSessions: number

  /** Sesiones activas */
  activeSessions: number

  /** Sesiones guardadas */
  savedSessions: number

  /** Lista de sesiones con su resumen */
  sessions: SessionSummary[]

  /** Última actualización del estado */
  lastUpdated: string
}
