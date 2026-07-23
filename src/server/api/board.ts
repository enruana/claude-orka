/**
 * Board API Router — server-facing surface for Board sessions.
 *
 * Two flavors of endpoint live here:
 *
 * 1. Board / task CRUD proxying to `BoardManager` — used by the Kanban UI.
 * 2. Terminal lifecycle proxying to `BoardTerminals` — spawns and stops
 *    the master + task tmux/ttyd/claude processes.
 *
 * Every write path uses the same `?project=<base64>` convention as the
 * KB router so the client library stays consistent.
 */

import { Router } from 'express'
import { BoardManager } from '../../core/BoardManager'
import { getGlobalStateManager } from '../../core/GlobalStateManager'
import {
  startBoardMaster,
  stopBoardMaster,
  triggerBoardMasterSync,
  startBoardTask,
  stopBoardTask,
  sendCloseToBoardTask,
  sendInitToBoardTask,
  persistTaskHandles,
  resumeBoardTask,
} from '../../core/BoardTerminals'
import { logger } from '../../utils'

export const boardRouter = Router()

function decodeProject(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

function project(req: any): string {
  const encoded = req.query.project as string | undefined
  if (!encoded) throw new Error('Missing project query param')
  return decodeProject(encoded)
}

function mgr(req: any): BoardManager {
  return new BoardManager(project(req))
}

function handle(res: any, err: any, fallbackStatus = 500): void {
  logger.error('Board API error:', err)
  res.status(fallbackStatus).json({ error: err?.message || String(err) })
}

// ---------- Board CRUD ----------

boardRouter.get('/', async (req, res) => {
  try {
    const list = await mgr(req).listBoards()
    res.json(list)
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.post('/', async (req, res) => {
  try {
    const { name, jiraUrl, jql, columns } = req.body || {}
    if (!name || !jiraUrl) { res.status(400).json({ error: 'name and jiraUrl are required' }); return }
    const cfg = await mgr(req).createBoard({ name, jiraUrl, jql, columns })
    res.json(cfg)
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.get('/:boardId', async (req, res) => {
  try {
    const cfg = await mgr(req).getBoard(req.params.boardId)
    if (!cfg) { res.status(404).json({ error: 'Board not found' }); return }
    res.json(cfg)
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.patch('/:boardId', async (req, res) => {
  try {
    const cfg = await mgr(req).updateBoard(req.params.boardId, req.body || {})
    res.json(cfg)
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.delete('/:boardId', async (req, res) => {
  try {
    // Best-effort tear-down of the master before deleting the on-disk state.
    try { await stopBoardMaster(req.params.boardId) } catch { /* ignore */ }
    await mgr(req).deleteBoard(req.params.boardId)
    res.json({ success: true })
  } catch (err) {
    handle(res, err)
  }
})

// ---------- Tasks ----------

boardRouter.get('/:boardId/tasks', async (req, res) => {
  try {
    const status = (req.query.status as string) || undefined
    const list = await mgr(req).listTasks(req.params.boardId, status ? { status } : undefined)
    res.json(list)
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.post('/:boardId/tasks', async (req, res) => {
  try {
    const t = await mgr(req).addTask(req.params.boardId, req.body)
    res.json(t)
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.get('/:boardId/tasks/:key', async (req, res) => {
  try {
    const t = await mgr(req).getTask(req.params.boardId, req.params.key)
    if (!t) { res.status(404).json({ error: 'Task not found' }); return }
    res.json(t)
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.patch('/:boardId/tasks/:key', async (req, res) => {
  try {
    const t = await mgr(req).updateTask(req.params.boardId, req.params.key, req.body || {})
    res.json(t)
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.delete('/:boardId/tasks/:key', async (req, res) => {
  try {
    await mgr(req).removeTask(req.params.boardId, req.params.key)
    res.json({ success: true })
  } catch (err) {
    handle(res, err)
  }
})

// ---------- Drift ----------

boardRouter.get('/:boardId/drifts', async (req, res) => {
  try {
    const drifts = await mgr(req).listDrifts(req.params.boardId)
    res.json(drifts)
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.delete('/:boardId/drifts/:key', async (req, res) => {
  try {
    await mgr(req).ackDrift(req.params.boardId, req.params.key)
    res.json({ success: true })
  } catch (err) {
    handle(res, err)
  }
})

// ---------- Master terminal ----------

boardRouter.post('/:boardId/master/start', async (req, res) => {
  try {
    const projectPath = project(req)
    const cfg = await mgr(req).getBoard(req.params.boardId)
    if (!cfg) { res.status(404).json({ error: 'Board not found' }); return }
    const globalState = await getGlobalStateManager()
    const template =
      (cfg.masterPromptId && globalState.getBoardTemplate(cfg.masterPromptId)) ||
      globalState.getBoardTemplate('master-default')!
    const handles = await startBoardMaster({
      projectPath,
      boardId: cfg.id,
      boardName: cfg.name,
      jiraUrl: cfg.jiraUrl,
      masterTemplate: template,
    })
    res.json(handles)
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.post('/:boardId/master/stop', async (req, res) => {
  try {
    const pid = req.body?.ttydPid
    await stopBoardMaster(req.params.boardId, pid)
    res.json({ success: true })
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.post('/:boardId/master/sync', async (req, res) => {
  try {
    const cfg = await mgr(req).getBoard(req.params.boardId)
    if (!cfg) { res.status(404).json({ error: 'Board not found' }); return }
    const globalState = await getGlobalStateManager()
    const template =
      (cfg.syncPromptId && globalState.getBoardTemplate(cfg.syncPromptId)) ||
      globalState.getBoardTemplate('sync-default')!
    await mgr(req).markSyncStarted(cfg.id)
    await triggerBoardMasterSync(cfg.id, template)
    res.json({ success: true })
  } catch (err) {
    handle(res, err)
  }
})

// ---------- Task lifecycle ----------

boardRouter.post('/:boardId/tasks/:key/start', async (req, res) => {
  try {
    const projectPath = project(req)
    const templateId = (req.body?.template as string) || 'full'
    // `changeStatusTo` is opt-in: caller decides whether spawning a
    // terminal also moves the card between columns. Kanban's
    // "drag → in-progress" passes 'in-progress' explicitly; the modal's
    // Start button omits it so a review-column task keeps its column
    // when you spin up a terminal for it.
    const changeStatusTo = req.body?.changeStatusTo as string | undefined
    const boardId = req.params.boardId
    const taskKey = req.params.key
    const boardMgr = mgr(req)
    const cfg = await boardMgr.getBoard(boardId)
    if (!cfg) { res.status(404).json({ error: 'Board not found' }); return }
    const task = await boardMgr.getTask(boardId, taskKey)
    if (!task) { res.status(404).json({ error: 'Task not found' }); return }

    const globalState = await getGlobalStateManager()
    const template = globalState.getBoardTemplate(templateId)
    if (!template) { res.status(400).json({ error: `Template not found: ${templateId}` }); return }

    // Reopen = a task that already has a claudeSessionId AND is not
    // currently running. Detected from the ORIGINAL status/handles so
    // reopening a Done task via Kanban drag still resumes even if the
    // caller asks us to bump status to in-progress.
    const isReopen = !!task.claudeSessionId && task.status !== 'in-progress'

    // Only touch status if the caller asked. Validation: must be one
    // of the board's columns to prevent typos landing in state.json.
    if (changeStatusTo) {
      if (!cfg.columns.includes(changeStatusTo)) {
        res.status(400).json({ error: `Invalid status "${changeStatusTo}" for this board` })
        return
      }
      await boardMgr.updateTask(boardId, taskKey, { status: changeStatusTo })
    }

    const branchName = task.branchName || `${taskKey}-${slugify(task.title).slice(0, 40)}`

    const handles = await startBoardTask({
      projectPath,
      boardId,
      taskKey,
      taskTitle: task.title,
      jiraUrl: task.jiraUrl,
      branchName,
      template,
      existingClaudeSessionId: task.claudeSessionId,
      isReopen,
    })
    await persistTaskHandles(projectPath, boardId, taskKey, handles)
    res.json({ ...handles, template: template.id, reopen: isReopen, statusChanged: !!changeStatusTo })
  } catch (err) {
    handle(res, err)
  }
})

/**
 * `POST /:boardId/tasks/:key/close` — SILENT close.
 *
 * Only changes the local status (default `done`) and optionally
 * detaches/kills the terminal. NEVER sends a prompt to Claude. Safe as
 * the default target of drag & drop and the status selector so an
 * accidental move doesn't fire off a PR, a Jira transition, or a KB
 * update. For the full wrap-up ritual, use `/wrap-up`.
 */
boardRouter.post('/:boardId/tasks/:key/close', async (req, res) => {
  try {
    const boardId = req.params.boardId
    const taskKey = req.params.key
    const nextStatus = (req.body?.status as string) || 'done'
    const terminalAction = (req.body?.terminal as string) || 'keep' // keep|detach|shutdown

    const boardMgr = mgr(req)
    const task = await boardMgr.getTask(boardId, taskKey)
    if (!task) { res.status(404).json({ error: 'Task not found' }); return }

    await boardMgr.updateTask(boardId, taskKey, { status: nextStatus })

    if (terminalAction === 'shutdown') {
      await stopBoardTask(taskKey, task.ttydPid)
      await boardMgr.detachTaskTerminal(boardId, taskKey)
    } else if (terminalAction === 'detach') {
      await boardMgr.detachTaskTerminal(boardId, taskKey)
    }
    res.json({ success: true, mode: 'silent' })
  } catch (err) {
    handle(res, err)
  }
})

/**
 * `POST /:boardId/tasks/:key/wrap-up` — trigger the full close ritual.
 *
 * Sends the close-template prompt to Claude in the pane so it runs the
 * wrap-up: push, PR, Jira comment, Jira transition, KB update, worktree
 * cleanup. Then updates local status. Explicit endpoint (not the default)
 * because it has side-effects on Jira / GitHub / KB that a user should
 * intentionally opt into.
 */
boardRouter.post('/:boardId/tasks/:key/wrap-up', async (req, res) => {
  try {
    const projectPath = project(req)
    const boardId = req.params.boardId
    const taskKey = req.params.key
    const templateId = (req.body?.template as string) || 'close-default'
    const nextStatus = (req.body?.status as string) || 'done'
    const terminalAction = (req.body?.terminal as string) || 'keep'

    const boardMgr = mgr(req)
    const task = await boardMgr.getTask(boardId, taskKey)
    if (!task) { res.status(404).json({ error: 'Task not found' }); return }
    const globalState = await getGlobalStateManager()
    const template = globalState.getBoardTemplate(templateId)
    if (!template) { res.status(400).json({ error: `Template not found: ${templateId}` }); return }

    await sendCloseToBoardTask(taskKey, template, {
      taskKey,
      taskTitle: task.title,
      jiraUrl: task.jiraUrl,
      boardId,
      projectPath,
      branchName: task.branchName ?? '',
      worktreePath: task.worktreePath ?? '',
      kbEntityId: task.kbEntityId ?? '',
      nextStatus,
    })

    await boardMgr.updateTask(boardId, taskKey, { status: nextStatus })

    if (terminalAction === 'shutdown') {
      await stopBoardTask(taskKey, task.ttydPid)
      await boardMgr.detachTaskTerminal(boardId, taskKey)
    } else if (terminalAction === 'detach') {
      await boardMgr.detachTaskTerminal(boardId, taskKey)
    }
    res.json({ success: true, mode: 'wrap-up' })
  } catch (err) {
    handle(res, err)
  }
})

/**
 * `POST /:boardId/tasks/:key/reinit` — re-fire the init prompt against a
 * running task terminal. Useful when the init template or a referenced
 * skill got updated and the user wants Claude to pick up the new
 * instructions without closing + spawning a fresh session (which would
 * lose the current in-flight context).
 *
 * No status change, no PR, no Jira touch — just a fresh prompt into the
 * pane.
 */
boardRouter.post('/:boardId/tasks/:key/reinit', async (req, res) => {
  try {
    const projectPath = project(req)
    const boardId = req.params.boardId
    const taskKey = req.params.key
    const templateId = (req.body?.template as string) || 'full'
    const boardMgr = mgr(req)
    const task = await boardMgr.getTask(boardId, taskKey)
    if (!task) { res.status(404).json({ error: 'Task not found' }); return }
    const globalState = await getGlobalStateManager()
    const template = globalState.getBoardTemplate(templateId)
    if (!template) { res.status(400).json({ error: `Template not found: ${templateId}` }); return }

    const branchName = task.branchName || `${taskKey}-${slugify(task.title).slice(0, 40)}`
    await sendInitToBoardTask(taskKey, template, {
      taskKey,
      taskTitle: task.title,
      jiraUrl: task.jiraUrl,
      boardId,
      projectPath,
      branchName,
      worktreeParent: '',
    })
    res.json({ success: true, template: template.id })
  } catch (err) {
    handle(res, err)
  }
})

// ---------- Task recovery ----------

/**
 * `POST /:boardId/tasks/:key/resume` — analog of `resumeSession` for
 * classic sessions. After a server restart, the ttyd process that served
 * a task's terminal is gone but the tmux is not; call this to spin up a
 * new ttyd on the surviving tmux and update stored handles. If tmux is
 * also gone, the response says so and the UI can offer to restart from
 * scratch via the `start-task` endpoint.
 */
boardRouter.post('/:boardId/tasks/:key/resume', async (req, res) => {
  try {
    const projectPath = project(req)
    const result = await resumeBoardTask(projectPath, req.params.boardId, req.params.key)
    res.json(result)
  } catch (err) {
    handle(res, err)
  }
})

/**
 * `GET /:boardId/tasks/:key/capture` — capture the current content of the
 * task's tmux pane. Same shape as `/api/sessions/:sid/capture` but resolves
 * the pane through `BoardManager` (task terminals aren't stored in
 * `state.json`, so the classic endpoint 404s them). Powers "Copy from
 * Terminal" and Cmd+K inside the Board task modal.
 */
boardRouter.get('/:boardId/tasks/:key/capture', async (req, res) => {
  try {
    const boardId = req.params.boardId
    const taskKey = req.params.key
    const lines = parseInt((req.query.lines as string) || '300', 10)
    const wantAnsi = req.query.ansi === 'true' || req.query.ansi === '1'

    const task = await mgr(req).getTask(boardId, taskKey)
    if (!task) { res.status(404).json({ error: 'Task not found' }); return }
    if (!task.terminalPaneId) {
      res.status(404).json({ error: 'Task has no active terminal' }); return
    }

    const { TmuxCommands } = await import('../../utils/tmux')
    const text = wantAnsi
      ? await TmuxCommands.capturePaneAnsi(task.terminalPaneId, -lines)
      : await TmuxCommands.capturePane(task.terminalPaneId, -lines)

    res.json({ text, paneId: task.terminalPaneId, ansi: wantAnsi })
  } catch (err) {
    handle(res, err)
  }
})

// ---------- Comments (read-only surface for the UI) ----------

boardRouter.get('/:boardId/tasks/:key/comments', async (req, res) => {
  try {
    const list = await mgr(req).listComments(req.params.boardId, req.params.key)
    res.json(list)
  } catch (err) {
    handle(res, err)
  }
})

// ---------- Events (audit log) ----------

boardRouter.get('/:boardId/events', async (req, res) => {
  try {
    const events = await mgr(req).listEvents(req.params.boardId)
    res.json(events)
  } catch (err) {
    handle(res, err)
  }
})

// ---------- Prompt templates (global) ----------

boardRouter.get('/-/templates', async (_req, res) => {
  try {
    const globalState = await getGlobalStateManager()
    res.json(globalState.getBoardTemplates())
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.put('/-/templates/:id', async (req, res) => {
  try {
    const globalState = await getGlobalStateManager()
    const t = await globalState.upsertBoardTemplate({ ...req.body, id: req.params.id })
    res.json(t)
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.delete('/-/templates/:id', async (req, res) => {
  try {
    const globalState = await getGlobalStateManager()
    await globalState.deleteBoardTemplate(req.params.id)
    res.json({ success: true })
  } catch (err) {
    handle(res, err)
  }
})

// ---------- Jira config ----------

boardRouter.get('/-/jira', async (_req, res) => {
  try {
    const globalState = await getGlobalStateManager()
    // Redact the API token so the UI can indicate whether one is set
    // without ever surfacing it back.
    const cfg = globalState.getJiraConfig()
    res.json({
      instanceUrl: cfg.instanceUrl,
      email: cfg.email,
      apiTokenSet: !!cfg.apiToken,
    })
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.put('/-/jira', async (req, res) => {
  try {
    const globalState = await getGlobalStateManager()
    await globalState.setJiraConfig(req.body || {})
    res.json({ success: true })
  } catch (err) {
    handle(res, err)
  }
})

boardRouter.delete('/-/jira', async (_req, res) => {
  try {
    const globalState = await getGlobalStateManager()
    await globalState.clearJiraConfig()
    res.json({ success: true })
  } catch (err) {
    handle(res, err)
  }
})

// ---------- helpers ----------

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
