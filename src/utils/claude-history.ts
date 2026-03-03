import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { logger } from './logger'

/**
 * Path al archivo history.jsonl de Claude
 */
const CLAUDE_HISTORY_PATH = path.join(os.homedir(), '.claude', 'history.jsonl')

/**
 * Base path for Claude project session files
 */
const CLAUDE_PROJECTS_PATH = path.join(os.homedir(), '.claude', 'projects')

/**
 * Entrada del history.jsonl de Claude
 */
interface ClaudeHistoryEntry {
  sessionId: string
  timestamp: number
  project: string
  display: string
  pastedContents: Record<string, unknown>
}

/**
 * Lee todas las sesiones del history.jsonl
 */
export async function readClaudeHistory(): Promise<ClaudeHistoryEntry[]> {
  try {
    const exists = await fs.pathExists(CLAUDE_HISTORY_PATH)
    if (!exists) {
      logger.warn(`Claude history file not found: ${CLAUDE_HISTORY_PATH}`)
      return []
    }

    const content = await fs.readFile(CLAUDE_HISTORY_PATH, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)

    const entries: ClaudeHistoryEntry[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ClaudeHistoryEntry
        entries.push(entry)
      } catch (err) {
        logger.warn(`Failed to parse history line: ${line}`)
      }
    }

    return entries
  } catch (error) {
    logger.error(`Error reading Claude history: ${error}`)
    return []
  }
}

/**
 * Obtiene todos los session IDs únicos del history
 */
export async function getExistingSessionIds(): Promise<Set<string>> {
  const entries = await readClaudeHistory()
  return new Set(entries.map((e) => e.sessionId))
}

/**
 * Detecta un nuevo session ID que no existía antes
 * Útil para capturar el ID de un fork recién creado
 *
 * @param previousIds Set de session IDs que existían antes
 * @param maxWaitMs Tiempo máximo de espera en ms (default: 10000)
 * @param pollIntervalMs Intervalo de polling en ms (default: 500)
 * @returns El nuevo session ID o null si no se detectó
 */
export async function detectNewSessionId(
  previousIds: Set<string>,
  maxWaitMs: number = 10000,
  pollIntervalMs: number = 500
): Promise<string | null> {
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    const currentIds = await getExistingSessionIds()

    // Buscar IDs nuevos
    for (const id of currentIds) {
      if (!previousIds.has(id)) {
        logger.info(`Detected new Claude session: ${id}`)
        return id
      }
    }

    // Esperar antes de reintentar
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  logger.warn('Timeout waiting for new Claude session ID')
  return null
}

/**
 * Obtiene el session ID más reciente del history
 */
export async function getLatestSessionId(): Promise<string | null> {
  const entries = await readClaudeHistory()
  if (entries.length === 0) return null

  // Ordenar por timestamp descendente
  entries.sort((a, b) => b.timestamp - a.timestamp)

  return entries[0].sessionId
}

/**
 * Información resumida de una sesión de Claude
 */
export interface ClaudeSessionSummary {
  sessionId: string
  project: string
  firstMessage: string
  lastTimestamp: number
  messageCount: number
}

/**
 * Obtiene un listado de sesiones de Claude agrupadas y ordenadas
 * @param projectPath Si se proporciona, filtra solo las sesiones de ese proyecto
 * @param limit Número máximo de sesiones a devolver (default: 20)
 */
export async function listClaudeSessions(
  projectPath?: string,
  limit: number = 20
): Promise<ClaudeSessionSummary[]> {
  const entries = await readClaudeHistory()
  if (entries.length === 0) return []

  // Agrupar por sessionId
  const sessionMap = new Map<string, ClaudeHistoryEntry[]>()
  for (const entry of entries) {
    const existing = sessionMap.get(entry.sessionId) || []
    existing.push(entry)
    sessionMap.set(entry.sessionId, existing)
  }

  // Convertir a resumen
  const summaries: ClaudeSessionSummary[] = []
  for (const [sessionId, sessionEntries] of sessionMap) {
    // Ordenar entradas de esta sesión por timestamp
    sessionEntries.sort((a, b) => a.timestamp - b.timestamp)

    const firstEntry = sessionEntries[0]
    const lastEntry = sessionEntries[sessionEntries.length - 1]

    // Filtrar por proyecto si se especificó
    if (projectPath && firstEntry.project !== projectPath) {
      continue
    }

    summaries.push({
      sessionId,
      project: firstEntry.project,
      firstMessage: firstEntry.display.substring(0, 80),
      lastTimestamp: lastEntry.timestamp,
      messageCount: sessionEntries.length,
    })
  }

  // Ordenar por última actividad (más reciente primero)
  summaries.sort((a, b) => b.lastTimestamp - a.lastTimestamp)

  // Limitar resultados
  return summaries.slice(0, limit)
}

/**
 * Obtiene la sesión de Claude más reciente para un proyecto
 */
export async function getLatestSessionForProject(
  projectPath: string
): Promise<ClaudeSessionSummary | null> {
  const sessions = await listClaudeSessions(projectPath, 1)
  return sessions.length > 0 ? sessions[0] : null
}

// ==========================================
// SESSION VALIDATION & CONTEXT UTILITIES
// ==========================================

/**
 * Encode a project path for Claude's projects directory lookup.
 * Claude uses the pattern: replace '/' with '-' and strip leading '-'
 * e.g. "/Users/foo/project" → "-Users-foo-project"
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-')
}

/**
 * Check if a Claude session JSONL file exists on disk.
 * @param projectPath Absolute project path
 * @param sessionId Claude session UUID
 * @returns true if the JSONL file exists
 */
export async function claudeSessionFileExists(
  projectPath: string,
  sessionId: string
): Promise<boolean> {
  const encoded = encodeProjectPath(projectPath)
  const sessionFile = path.join(CLAUDE_PROJECTS_PATH, encoded, `${sessionId}.jsonl`)
  return fs.pathExists(sessionFile)
}

/**
 * Entry in Claude's sessions-index.json
 */
interface SessionsIndexEntry {
  sessionId: string
  fullPath: string
  fileMtime: number
  firstPrompt: string
  summary: string
  messageCount: number
  created: string
  modified: string
  gitBranch?: string
  projectPath: string
  isSidechain: boolean
}

/**
 * Get context summary for a Claude session.
 * Strategy:
 *   1. Read sessions-index.json and find the entry (fast, small file)
 *   2. If not found, fall back to reading the tail of the JSONL file for a summary entry
 * @returns Summary string or null if not found
 */
export async function getSessionContextSummary(
  projectPath: string,
  sessionId: string
): Promise<string | null> {
  const encoded = encodeProjectPath(projectPath)
  const projectDir = path.join(CLAUDE_PROJECTS_PATH, encoded)

  // Strategy 1: sessions-index.json (fast)
  try {
    const indexPath = path.join(projectDir, 'sessions-index.json')
    if (await fs.pathExists(indexPath)) {
      const indexData = await fs.readJson(indexPath)
      const entries: SessionsIndexEntry[] = indexData.entries || []
      const entry = entries.find((e) => e.sessionId === sessionId)
      if (entry?.summary) {
        logger.debug(`Found session summary in index: "${entry.summary}"`)
        return entry.summary
      }
    }
  } catch (error) {
    logger.debug(`Could not read sessions-index.json: ${error}`)
  }

  // Strategy 2: Read tail of JSONL file for summary entry
  try {
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`)
    if (!(await fs.pathExists(sessionFile))) {
      return null
    }

    // Read last 200 lines efficiently using reverse line reader
    const lines = await readLastLines(sessionFile, 200)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i])
        if (entry.type === 'summary' && entry.summary) {
          logger.debug(`Found summary in JSONL tail: "${entry.summary}"`)
          return entry.summary
        }
      } catch {
        // Skip unparseable lines
      }
    }
  } catch (error) {
    logger.debug(`Could not read session JSONL for summary: ${error}`)
  }

  return null
}

/**
 * Find the most recent Claude session for a project from sessions-index.json.
 * Useful as fallback when the original session JSONL no longer exists
 * (e.g., after /clear which creates a new session).
 * @param projectPath Absolute project path
 * @param excludeSessionId Optional session ID to exclude from results
 * @returns The most recent session entry or null
 */
export async function findLatestSessionFromIndex(
  projectPath: string,
  excludeSessionId?: string
): Promise<SessionsIndexEntry | null> {
  const encoded = encodeProjectPath(projectPath)
  const indexPath = path.join(CLAUDE_PROJECTS_PATH, encoded, 'sessions-index.json')

  try {
    if (!(await fs.pathExists(indexPath))) {
      return null
    }

    const indexData = await fs.readJson(indexPath)
    const entries: SessionsIndexEntry[] = (indexData.entries || [])
      .filter((e: SessionsIndexEntry) => !e.isSidechain)
      .filter((e: SessionsIndexEntry) => !excludeSessionId || e.sessionId !== excludeSessionId)

    if (entries.length === 0) return null

    // Sort by modified date descending
    entries.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())

    return entries[0]
  } catch (error) {
    logger.debug(`Could not read sessions-index.json: ${error}`)
    return null
  }
}

/**
 * Read the last N lines of a file efficiently.
 */
async function readLastLines(filePath: string, count: number): Promise<string[]> {
  const lines: string[] = []
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })

  for await (const line of rl) {
    lines.push(line)
    if (lines.length > count) {
      lines.shift()
    }
  }

  return lines
}
