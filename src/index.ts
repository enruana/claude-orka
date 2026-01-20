/**
 * Claude-Orka SDK
 * Orquestador de sesiones de Claude Code con tmux
 */

// API Principal
export { ClaudeOrka } from './core/ClaudeOrka'

// Modelos
export type {
  Session,
  MainBranch,
  Fork,
  ProjectState,
  SessionFilters,
} from './models'

// Utilidades exportadas (opcional)
export { logger, LogLevel } from './utils/logger'
export { TmuxCommands, TmuxError } from './utils/tmux'

// Global State (multi-project support)
export { GlobalStateManager, getGlobalStateManager } from './core/GlobalStateManager'
export type { GlobalConfig, RegisteredProject } from './core/GlobalStateManager'

// Server
export { createServer, startServer } from './server'
