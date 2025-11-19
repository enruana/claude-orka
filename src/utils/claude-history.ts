import * as fs from 'fs-extra'
import * as os from 'os'
import * as path from 'path'
import { logger } from './logger'

/**
 * Path al archivo history.jsonl de Claude
 */
const CLAUDE_HISTORY_PATH = path.join(os.homedir(), '.claude', 'history.jsonl')

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
