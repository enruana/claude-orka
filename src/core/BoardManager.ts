import path from 'path'
import fs from 'fs-extra'
import { nanoid } from 'nanoid'
import {
  BoardConfig,
  BoardTask,
  BoardIndex,
  BoardDrift,
  BoardPendingDrifts,
  BoardEvent,
  BoardCommentRecord,
  BOARD_SCHEMA_VERSION,
  DEFAULT_BOARD_COLUMNS,
} from '../models/Board'

const BOARDS_ROOT = path.join('.claude-orka', '.boards')
const INDEX_FILE = 'index.json'
const CONFIG_FILE = 'config.json'
const TASKS_FILE = 'tasks.json'
const EVENTS_FILE = 'events.jsonl'
const DRIFT_FILE = 'pending-drift.json'
const ATTACHMENTS_DIR = 'attachments'

/**
 * File-based store for Board sessions.
 *
 * One instance per project. Every mutation is atomic (temp-file + rename),
 * appends an event to `events.jsonl`, and updates `updatedAt` timestamps
 * on affected records. Both the `orka board` CLI and the `/api/board/*`
 * router route through this class — no direct file writes elsewhere.
 */
export class BoardManager {
  private boardsRoot: string

  constructor(projectPath: string) {
    this.boardsRoot = path.join(projectPath, BOARDS_ROOT)
  }

  // ---------- Layout / bootstrap ----------

  isInitialized(): boolean {
    return fs.existsSync(path.join(this.boardsRoot, INDEX_FILE))
  }

  async initialize(): Promise<void> {
    await fs.ensureDir(this.boardsRoot)
    const indexPath = path.join(this.boardsRoot, INDEX_FILE)
    if (!(await fs.pathExists(indexPath))) {
      await this.writeJson(indexPath, { boards: [] } as BoardIndex)
    }
  }

  private boardDir(boardId: string): string {
    return path.join(this.boardsRoot, boardId)
  }

  // ---------- Board CRUD ----------

  async createBoard(opts: {
    name: string
    jiraUrl: string
    jql?: string
    columns?: string[]
    masterPromptId?: string
    syncPromptId?: string
  }): Promise<BoardConfig> {
    await this.initialize()
    const id = `brd-${nanoid(10)}`
    const now = new Date().toISOString()
    const cfg: BoardConfig = {
      id,
      name: opts.name,
      jiraUrl: opts.jiraUrl,
      jql: opts.jql,
      columns: opts.columns && opts.columns.length > 0 ? opts.columns : [...DEFAULT_BOARD_COLUMNS],
      masterPromptId: opts.masterPromptId,
      syncPromptId: opts.syncPromptId,
      createdAt: now,
      schemaVersion: BOARD_SCHEMA_VERSION,
    }

    await fs.ensureDir(this.boardDir(id))
    await fs.ensureDir(path.join(this.boardDir(id), ATTACHMENTS_DIR))
    await this.writeJson(path.join(this.boardDir(id), CONFIG_FILE), cfg)
    await this.writeJson(path.join(this.boardDir(id), TASKS_FILE), [])
    await this.writeJson(path.join(this.boardDir(id), DRIFT_FILE), { drifts: [] } as BoardPendingDrifts)

    // Update index
    const idx = await this.readIndex()
    idx.boards.push({ id, name: cfg.name, jiraUrl: cfg.jiraUrl, createdAt: cfg.createdAt })
    await this.writeIndex(idx)

    await this.appendEvent(id, { ts: now, event: 'board.created', payload: { name: cfg.name, jiraUrl: cfg.jiraUrl } })
    return cfg
  }

  async listBoards(): Promise<BoardIndex['boards']> {
    if (!this.isInitialized()) return []
    const idx = await this.readIndex()
    return idx.boards
  }

  async getBoard(boardId: string): Promise<BoardConfig | null> {
    const p = path.join(this.boardDir(boardId), CONFIG_FILE)
    if (!(await fs.pathExists(p))) return null
    return this.readJson<BoardConfig>(p)
  }

  async updateBoard(
    boardId: string,
    patch: Partial<Pick<BoardConfig, 'name' | 'jiraUrl' | 'jql' | 'columns' | 'masterPromptId' | 'syncPromptId' | 'lastSyncedAt'>>,
  ): Promise<BoardConfig> {
    const cfg = await this.getBoard(boardId)
    if (!cfg) throw new Error(`Board not found: ${boardId}`)
    const next: BoardConfig = { ...cfg, ...patch }
    await this.writeJson(path.join(this.boardDir(boardId), CONFIG_FILE), next)

    if (patch.name || patch.jiraUrl) {
      const idx = await this.readIndex()
      const entry = idx.boards.find((b) => b.id === boardId)
      if (entry) {
        if (patch.name) entry.name = patch.name
        if (patch.jiraUrl) entry.jiraUrl = patch.jiraUrl
        await this.writeIndex(idx)
      }
    }
    await this.appendEvent(boardId, {
      ts: new Date().toISOString(),
      event: 'board.updated',
      payload: patch as Record<string, unknown>,
    })
    return next
  }

  async deleteBoard(boardId: string): Promise<void> {
    const dir = this.boardDir(boardId)
    if (!(await fs.pathExists(dir))) return
    await fs.remove(dir)
    const idx = await this.readIndex()
    idx.boards = idx.boards.filter((b) => b.id !== boardId)
    await this.writeIndex(idx)
  }

  // ---------- Task CRUD ----------

  private async readTasks(boardId: string): Promise<BoardTask[]> {
    const p = path.join(this.boardDir(boardId), TASKS_FILE)
    if (!(await fs.pathExists(p))) return []
    return this.readJson<BoardTask[]>(p)
  }

  private async writeTasks(boardId: string, tasks: BoardTask[]): Promise<void> {
    await this.writeJson(path.join(this.boardDir(boardId), TASKS_FILE), tasks)
  }

  async listTasks(boardId: string, filter?: { status?: string }): Promise<BoardTask[]> {
    const all = await this.readTasks(boardId)
    if (!filter?.status) return all
    return all.filter((t) => t.status === filter.status)
  }

  async getTask(boardId: string, key: string): Promise<BoardTask | null> {
    const all = await this.readTasks(boardId)
    return all.find((t) => t.key === key) ?? null
  }

  async addTask(
    boardId: string,
    task: Omit<BoardTask, 'createdAt' | 'updatedAt'>,
  ): Promise<BoardTask> {
    const cfg = await this.getBoard(boardId)
    if (!cfg) throw new Error(`Board not found: ${boardId}`)
    if (!cfg.columns.includes(task.status)) {
      throw new Error(
        `Invalid status "${task.status}" for board ${boardId}. Valid columns: ${cfg.columns.join(', ')}`,
      )
    }
    const all = await this.readTasks(boardId)
    if (all.some((t) => t.key === task.key)) {
      throw new Error(`Task ${task.key} already exists in board ${boardId}. Use update-task instead.`)
    }
    const now = new Date().toISOString()
    const full: BoardTask = { ...task, createdAt: now, updatedAt: now }
    all.push(full)
    await this.writeTasks(boardId, all)
    await this.appendEvent(boardId, {
      ts: now,
      event: 'task.added',
      taskKey: task.key,
      payload: { title: task.title, status: task.status },
    })
    return full
  }

  async updateTask(
    boardId: string,
    key: string,
    patch: Partial<Omit<BoardTask, 'key' | 'createdAt' | 'updatedAt'>>,
  ): Promise<BoardTask> {
    const cfg = await this.getBoard(boardId)
    if (!cfg) throw new Error(`Board not found: ${boardId}`)
    if (patch.status && !cfg.columns.includes(patch.status)) {
      throw new Error(
        `Invalid status "${patch.status}" for board ${boardId}. Valid columns: ${cfg.columns.join(', ')}`,
      )
    }
    const all = await this.readTasks(boardId)
    const idx = all.findIndex((t) => t.key === key)
    if (idx === -1) throw new Error(`Task not found: ${key}`)
    const now = new Date().toISOString()
    const next: BoardTask = { ...all[idx], ...patch, updatedAt: now }
    all[idx] = next
    await this.writeTasks(boardId, all)
    await this.appendEvent(boardId, {
      ts: now,
      event: 'task.updated',
      taskKey: key,
      payload: patch as Record<string, unknown>,
    })
    return next
  }

  async removeTask(boardId: string, key: string): Promise<void> {
    const all = await this.readTasks(boardId)
    const idx = all.findIndex((t) => t.key === key)
    if (idx === -1) return
    all.splice(idx, 1)
    await this.writeTasks(boardId, all)
    await this.appendEvent(boardId, {
      ts: new Date().toISOString(),
      event: 'task.removed',
      taskKey: key,
    })
  }

  /**
   * Terminal handles are set when the server spawns the tmux + ttyd for a
   * task and cleared when they die. Kept separate from `updateTask` so
   * they don't need to appear in every UI-level patch.
   */
  async attachTaskTerminal(
    boardId: string,
    key: string,
    handles: Pick<BoardTask, 'terminalPaneId' | 'terminalTmuxSessionId' | 'ttydPort' | 'ttydPid' | 'claudeSessionId'>,
  ): Promise<BoardTask> {
    const updated = await this.updateTask(boardId, key, handles)
    await this.appendEvent(boardId, {
      ts: new Date().toISOString(),
      event: 'task.terminal.attached',
      taskKey: key,
      payload: handles as Record<string, unknown>,
    })
    return updated
  }

  async detachTaskTerminal(boardId: string, key: string): Promise<BoardTask> {
    // Clear the transient terminal handles but KEEP `claudeSessionId` —
    // that's the durable link to Claude's own history and is what lets
    // `Reopen` on a closed task pick up the previous conversation.
    const updated = await this.updateTask(boardId, key, {
      terminalPaneId: undefined,
      terminalTmuxSessionId: undefined,
      ttydPort: undefined,
      ttydPid: undefined,
    })
    await this.appendEvent(boardId, {
      ts: new Date().toISOString(),
      event: 'task.terminal.detached',
      taskKey: key,
    })
    return updated
  }

  // ---------- Drift ----------

  private async readDrifts(boardId: string): Promise<BoardPendingDrifts> {
    const p = path.join(this.boardDir(boardId), DRIFT_FILE)
    if (!(await fs.pathExists(p))) return { drifts: [] }
    return this.readJson<BoardPendingDrifts>(p)
  }

  private async writeDrifts(boardId: string, data: BoardPendingDrifts): Promise<void> {
    await this.writeJson(path.join(this.boardDir(boardId), DRIFT_FILE), data)
  }

  async listDrifts(boardId: string): Promise<BoardDrift[]> {
    return (await this.readDrifts(boardId)).drifts
  }

  async markDrift(
    boardId: string,
    taskKey: string,
    fromStatus: string,
    toStatus: string,
  ): Promise<BoardDrift> {
    const data = await this.readDrifts(boardId)
    // Replace any existing drift for this key — most recent wins.
    data.drifts = data.drifts.filter((d) => d.taskKey !== taskKey)
    const drift: BoardDrift = {
      taskKey,
      fromStatus,
      toStatus,
      detectedAt: new Date().toISOString(),
    }
    data.drifts.push(drift)
    await this.writeDrifts(boardId, data)
    await this.appendEvent(boardId, {
      ts: drift.detectedAt,
      event: 'drift.marked',
      taskKey,
      payload: { fromStatus, toStatus },
    })
    return drift
  }

  async ackDrift(boardId: string, taskKey: string): Promise<void> {
    const data = await this.readDrifts(boardId)
    const before = data.drifts.length
    data.drifts = data.drifts.filter((d) => d.taskKey !== taskKey)
    if (data.drifts.length === before) return
    await this.writeDrifts(boardId, data)
    await this.appendEvent(boardId, {
      ts: new Date().toISOString(),
      event: 'drift.acknowledged',
      taskKey,
    })
  }

  // ---------- Sync bookkeeping ----------

  async markSyncStarted(boardId: string, actor?: string): Promise<void> {
    await this.appendEvent(boardId, {
      ts: new Date().toISOString(),
      event: 'sync.started',
      actor,
    })
  }

  async markSyncCompleted(
    boardId: string,
    summary?: { added?: number; updated?: number; unchanged?: number; drift?: number },
  ): Promise<void> {
    const ts = new Date().toISOString()
    await this.updateBoard(boardId, { lastSyncedAt: ts })
    await this.appendEvent(boardId, {
      ts,
      event: 'sync.completed',
      payload: summary as Record<string, unknown> | undefined,
    })
  }

  // ---------- Attachments ----------

  async attachComment(
    boardId: string,
    taskKey: string,
    comment: Omit<BoardCommentRecord, 'storedAt'>,
  ): Promise<void> {
    const dir = path.join(this.boardDir(boardId), ATTACHMENTS_DIR, taskKey)
    await fs.ensureDir(dir)
    const rec: BoardCommentRecord = { ...comment, storedAt: new Date().toISOString() }
    const jsonlPath = path.join(dir, 'comments.jsonl')
    await fs.appendFile(jsonlPath, JSON.stringify(rec) + '\n', 'utf-8')
    await this.appendEvent(boardId, {
      ts: rec.storedAt,
      event: 'attachment.comment',
      taskKey,
      payload: { author: rec.author, jiraCommentId: rec.jiraCommentId },
    })
  }

  async listComments(boardId: string, taskKey: string): Promise<BoardCommentRecord[]> {
    const p = path.join(this.boardDir(boardId), ATTACHMENTS_DIR, taskKey, 'comments.jsonl')
    if (!(await fs.pathExists(p))) return []
    const raw = await fs.readFile(p, 'utf-8')
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as BoardCommentRecord)
  }

  async attachDoc(boardId: string, taskKey: string, sourcePath: string): Promise<string> {
    const dir = path.join(this.boardDir(boardId), ATTACHMENTS_DIR, taskKey, 'docs')
    await fs.ensureDir(dir)
    const filename = path.basename(sourcePath)
    const dest = path.join(dir, filename)
    await fs.copy(sourcePath, dest, { overwrite: true })
    await this.appendEvent(boardId, {
      ts: new Date().toISOString(),
      event: 'attachment.doc',
      taskKey,
      payload: { path: dest },
    })
    return dest
  }

  // ---------- Events (audit log) ----------

  async listEvents(boardId: string): Promise<BoardEvent[]> {
    const p = path.join(this.boardDir(boardId), EVENTS_FILE)
    if (!(await fs.pathExists(p))) return []
    const raw = await fs.readFile(p, 'utf-8')
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as BoardEvent)
  }

  private async appendEvent(boardId: string, evt: BoardEvent): Promise<void> {
    const p = path.join(this.boardDir(boardId), EVENTS_FILE)
    await fs.appendFile(p, JSON.stringify(evt) + '\n', 'utf-8')
  }

  // ---------- Low-level file helpers ----------

  private async readIndex(): Promise<BoardIndex> {
    const p = path.join(this.boardsRoot, INDEX_FILE)
    if (!(await fs.pathExists(p))) return { boards: [] }
    return this.readJson<BoardIndex>(p)
  }

  private async writeIndex(idx: BoardIndex): Promise<void> {
    await this.writeJson(path.join(this.boardsRoot, INDEX_FILE), idx)
  }

  private async readJson<T>(p: string): Promise<T> {
    const raw = await fs.readFile(p, 'utf-8')
    return JSON.parse(raw) as T
  }

  private async writeJson(p: string, data: unknown): Promise<void> {
    // Atomic write — same pattern StateManager uses.
    const tmp = `${p}.${nanoid(6)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
    await fs.rename(tmp, p)
  }
}
