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
 * Per-session metadata used by Orka's id-recovery logic. Despite the name
 * (historical), it is now sourced by scanning per-session `.jsonl` files
 * directly (see `listProjectSessions`) — Claude Code stopped maintaining
 * the original `sessions-index.json`.
 */
export interface SessionsIndexEntry {
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
 * Scan every `<sessionId>.jsonl` file in the project's Claude folder and
 * return one entry per session, enriched with the JSONL's first-record
 * metadata (so we know `cwd` of the session) and the file's mtime.
 *
 * Replaces the older `sessions-index.json` strategy. That file was removed
 * by recent Claude Code versions, which broke the lookups that depended
 * on it — `findLatestSessionFromIndex` / `findLatestUnassignedSession` /
 * `syncSessionIds` would all silently return null. Reading the `.jsonl`
 * directories is slightly slower but always available.
 */
export async function listProjectSessions(projectPath: string): Promise<SessionsIndexEntry[]> {
  const encoded = encodeProjectPath(projectPath)
  const projectDir = path.join(CLAUDE_PROJECTS_PATH, encoded)
  if (!(await fs.pathExists(projectDir))) return []

  let files: string[]
  try {
    files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }

  const entries: SessionsIndexEntry[] = []
  for (const file of files) {
    const sessionId = file.slice(0, -'.jsonl'.length)
    const full = path.join(projectDir, file)
    let stat
    try {
      stat = await fs.stat(full)
    } catch {
      continue
    }

    // Read the first non-meta entry to capture the session's cwd. The very
    // first line is usually `type=mode` with no cwd; the actual content
    // lines carry cwd. Read up to the first 20 lines to be safe — bails
    // early as soon as we have what we need.
    let cwd = ''
    let firstPrompt = ''
    let isSidechain = false
    try {
      const text = await fs.readFile(full, 'utf-8')
      const lines = text.split('\n')
      for (let i = 0; i < Math.min(lines.length, 20); i++) {
        const line = lines[i]
        if (!line) continue
        try {
          const obj = JSON.parse(line) as Record<string, unknown>
          if (typeof obj.cwd === 'string' && !cwd) cwd = obj.cwd
          if (obj.isSidechain === true) isSidechain = true
          if (obj.type === 'user' && typeof obj.message === 'object' && obj.message !== null) {
            const msg = obj.message as { content?: unknown }
            if (typeof msg.content === 'string' && !firstPrompt) firstPrompt = msg.content
          }
          if (cwd && firstPrompt) break
        } catch {
          // skip malformed line
        }
      }
    } catch {
      // unreadable; still keep the bare entry so the heuristic can fall
      // back to mtime alone
    }

    entries.push({
      sessionId,
      fullPath: full,
      fileMtime: stat.mtimeMs,
      firstPrompt: firstPrompt.slice(0, 200),
      summary: '',
      messageCount: 0, // unknown without scanning the whole file; not used by callers
      created: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
      modified: new Date(stat.mtimeMs).toISOString(),
      projectPath: cwd || projectPath,
      isSidechain,
    })
  }

  // Most-recent first — every downstream consumer wants this order.
  entries.sort((a, b) => b.fileMtime - a.fileMtime)
  return entries
}

/**
 * Find the most recent Claude session for a project. Useful as fallback
 * when the original session JSONL no longer exists (e.g., after `/clear`
 * which creates a new session).
 */
export async function findLatestSessionFromIndex(
  projectPath: string,
  excludeSessionId?: string
): Promise<SessionsIndexEntry | null> {
  const entries = (await listProjectSessions(projectPath))
    .filter((e) => !e.isSidechain)
    .filter((e) => !excludeSessionId || e.sessionId !== excludeSessionId)
  return entries[0] ?? null
}

/**
 * Find the latest Claude session for a project that is NOT already tracked
 * by Orka. Used for runtime detection: when the user does `/clear`, a new
 * session appears that isn't in our tracked set — that's the replacement.
 *
 * @param projectPath Absolute project path
 * @param trackedSessionIds Set of all Claude session IDs currently tracked
 * @param afterTimestamp Only consider sessions modified after this ISO ts
 */
export async function findLatestUnassignedSession(
  projectPath: string,
  trackedSessionIds: Set<string>,
  afterTimestamp?: string
): Promise<SessionsIndexEntry | null> {
  const afterMs = afterTimestamp ? new Date(afterTimestamp).getTime() : 0
  const entries = (await listProjectSessions(projectPath))
    .filter((e) => !e.isSidechain)
    .filter((e) => !trackedSessionIds.has(e.sessionId))
    .filter((e) => e.fileMtime > afterMs)
  return entries[0] ?? null
}

/**
 * Pair each Orka branch (main + active forks) with the freshest unassigned
 * Claude session on disk, using a greedy newest-first match. Sessions
 * already assigned to OTHER branches are skipped. Returns a map from
 * `branchKey` ('main' or fork id) to the chosen session entry, or an
 * empty map if no rotations were detected.
 *
 * `existingIds` is the set of currently-stored claudeSessionIds across
 * ALL Orka branches in the project (across every Orka session) — so we
 * don't reassign an id that's already in use by a sibling branch.
 *
 * @param projectPath  Absolute project path
 * @param branchKeys   Ordered list of branches to assign (main first, then
 *                     forks sorted by createdAt asc). Order matters: the
 *                     greedy algorithm hands the newest sessions to the
 *                     earliest entries in this list.
 * @param existingIds  Already-tracked claudeSessionIds (skipped in matching)
 */
export async function discoverBranchSessions(
  projectPath: string,
  branchKeys: Array<{ key: string; storedId: string; storedMtime: number | null; activitySince: string }>,
  existingIds: Set<string>
): Promise<Map<string, SessionsIndexEntry>> {
  // Available pool: every non-sidechain jsonl for this project, MINUS the
  // sessions already owned by branches in OTHER Orka sessions. We allow
  // our own incoming branches' stored ids to remain in the pool so the
  // matcher can re-pick them if they truly are the freshest.
  const ownStoredIds = new Set(branchKeys.map((b) => b.storedId))
  const available = (await listProjectSessions(projectPath))
    .filter((e) => !e.isSidechain)
    .filter((e) => !existingIds.has(e.sessionId) || ownStoredIds.has(e.sessionId))

  // Pure greedy: each branch claims the newest unclaimed jsonl whose mtime
  // is fresher than `activitySince` (so we never assign a session that
  // predates the branch — that would be data theft from history).
  //
  // The previous logic tried to "pin" a stored id if it still existed on
  // disk, but that masked stale ids: a year-old jsonl still exists too,
  // and would block the rotation onto a freshly-modified one. With pure
  // greedy + caller-controlled ordering (most-recently-active branches
  // first), the freshest jsonl always lands on the branch that needs it.
  const result = new Map<string, SessionsIndexEntry>()
  const claimed = new Set<string>()
  for (const b of branchKeys) {
    const afterMs = new Date(b.activitySince).getTime()
    const candidate = available.find(
      (e) => !claimed.has(e.sessionId) && e.fileMtime > afterMs
    )
    if (candidate) {
      result.set(b.key, candidate)
      claimed.add(candidate.sessionId)
    }
  }
  return result
}

/**
 * Get the modification time of a Claude session JSONL file.
 * @returns mtime in ms or null if file doesn't exist
 */
export async function getSessionFileMtime(
  projectPath: string,
  sessionId: string
): Promise<number | null> {
  const encoded = encodeProjectPath(projectPath)
  const sessionFile = path.join(CLAUDE_PROJECTS_PATH, encoded, `${sessionId}.jsonl`)
  try {
    const stat = await fs.stat(sessionFile)
    return stat.mtimeMs
  } catch {
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
