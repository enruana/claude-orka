import { spawn } from 'child_process'
import execa from 'execa'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../utils'
import { TmuxCommands } from '../utils/tmux'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
import { getGlobalStateManager } from './GlobalStateManager'
import { BoardManager } from './BoardManager'
import type { BoardPromptTemplate } from './GlobalStateManager'

/**
 * Standalone spawner for Board master / task tmux+ttyd+claude terminals.
 *
 * These deliberately live outside `SessionManager` (which is per-project
 * and already large). Board terminals are per-Board, so calling code
 * passes the projectPath explicitly. They mirror the shape of
 * `startSystemTerminal` in SessionManager.ts:
 *   1. Ensure tmux session exists.
 *   2. Ensure a main pane label so the UI can identify it.
 *   3. Spawn ttyd attached to that tmux session.
 *   4. Start claude inside the pane with a --session-id we pre-generate,
 *      followed by the boot prompt.
 */

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function spawnTtydForTmux(tmuxSessionId: string): Promise<{ port: number; pid: number }> {
  const globalState = await getGlobalStateManager()

  // Ensure ttyd is present.
  try {
    await execa('which', ['ttyd'])
  } catch {
    throw new Error('ttyd not found. Run: orka prepare')
  }

  const port = await globalState.getNextTtydPort()
  const ttydProcess = spawn(
    'ttyd',
    [
      '-W',
      '-p',
      port.toString(),
      '-t',
      'fontSize=10',
      '-t',
      'fontFamily=monospace',
      '-t',
      'cursorBlink=true',
      '-t',
      'macOptionIsMeta=true',
      '-t',
      'scrollOnUserInput=true',
      'tmux',
      'attach',
      '-t',
      tmuxSessionId,
    ],
    { detached: true, stdio: 'ignore' },
  )
  ttydProcess.unref()

  const pid = ttydProcess.pid
  if (!pid) throw new Error(`Failed to start ttyd for tmux session ${tmuxSessionId}`)
  return { port, pid }
}

/**
 * Substitute `{{placeholders}}` in a template body. Missing keys are
 * left untouched — the prompt will still be usable and Claude will ask
 * for the missing bits itself rather than getting a literal string
 * silently blanked.
 */
export function renderTemplate(body: string, vars: Record<string, string | undefined>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
    const v = vars[key]
    return v === undefined ? m : v
  })
}

/**
 * Escape a string for embedding inside a bash `"double-quoted"` argument.
 * Same trick `SessionManager.initializeClaude` uses.
 */
function escapeQuotes(s: string): string {
  return s.replace(/"/g, '\\"')
}

// ---------- Master terminal ----------

export interface StartBoardMasterOptions {
  projectPath: string
  boardId: string
  boardName: string
  jiraUrl: string
  masterTemplate: BoardPromptTemplate
}

export interface BoardMasterHandles {
  tmuxSessionId: string
  paneId: string
  ttydPort: number
  ttydPid: number
  claudeSessionId: string
}

function masterTmuxName(boardId: string): string {
  return `orka-board-master-${boardId}`
}

export async function startBoardMaster(
  opts: StartBoardMasterOptions,
): Promise<BoardMasterHandles> {
  const tmuxSessionId = masterTmuxName(opts.boardId)

  // 1. Ensure tmux session exists.
  let created = false
  try {
    await execa('tmux', ['has-session', '-t', tmuxSessionId])
  } catch {
    await execa('tmux', ['new-session', '-d', '-s', tmuxSessionId, '-c', opts.projectPath])
    created = true
  }

  // 2. Get the main pane + label it.
  const paneId = await TmuxCommands.getMainPaneId(tmuxSessionId)
  try {
    await TmuxCommands.setPaneLabel(paneId, 'board-master')
  } catch {
    // Label failure isn't fatal — cosmetic only.
  }

  // 3. Spin ttyd.
  const { port, pid } = await spawnTtydForTmux(tmuxSessionId)

  // 4. Boot claude with a pre-generated session id + master prompt (only
  //    on the first creation — otherwise we'd interrupt an in-flight
  //    Claude session).
  const claudeSessionId = uuidv4()
  if (created) {
    const rendered = renderTemplate(opts.masterTemplate.body, {
      boardId: opts.boardId,
      boardName: opts.boardName,
      jiraUrl: opts.jiraUrl,
      projectPath: opts.projectPath,
    })
    await TmuxCommands.sendKeys(paneId, `cd ${opts.projectPath}`)
    await TmuxCommands.sendEnter(paneId)
    await sleep(300)
    const command = `claude --session-id ${claudeSessionId} "${escapeQuotes(rendered)}"`
    await TmuxCommands.sendKeys(paneId, command)
    await TmuxCommands.sendEnter(paneId)
    await sleep(1500)
    logger.info(`Board master started for ${opts.boardId} on tmux ${tmuxSessionId}, ttyd :${port}`)
  } else {
    logger.info(`Board master reattached for ${opts.boardId} on tmux ${tmuxSessionId}, ttyd :${port}`)
  }

  return { tmuxSessionId, paneId, ttydPort: port, ttydPid: pid, claudeSessionId }
}

export async function stopBoardMaster(boardId: string, ttydPid?: number): Promise<void> {
  const tmuxSessionId = masterTmuxName(boardId)
  if (ttydPid && isProcessAlive(ttydPid)) {
    try {
      process.kill(ttydPid, 'SIGTERM')
    } catch (err: any) {
      logger.warn(`Failed to kill board master ttyd: ${err.message}`)
    }
  }
  try {
    await execa('tmux', ['kill-session', '-t', tmuxSessionId])
  } catch {
    // Session may not exist — fine.
  }
  logger.info(`Board master stopped for ${boardId}`)
}

/**
 * Send the sync trigger to a running master. Fire-and-forget — the master
 * writes its own summary back into its buffer.
 */
export async function triggerBoardMasterSync(
  boardId: string,
  syncTemplate: BoardPromptTemplate,
): Promise<void> {
  const tmuxSessionId = masterTmuxName(boardId)
  // Check the session is alive.
  try {
    await execa('tmux', ['has-session', '-t', tmuxSessionId])
  } catch {
    throw new Error(`Board master not running for ${boardId} — start it first`)
  }
  const paneId = await TmuxCommands.getMainPaneId(tmuxSessionId)
  const rendered = renderTemplate(syncTemplate.body, { boardId })
  await TmuxCommands.sendKeys(paneId, rendered)
  await TmuxCommands.sendEnter(paneId)
}

// ---------- Task terminal ----------

export interface StartBoardTaskOptions {
  projectPath: string
  boardId: string
  taskKey: string
  taskTitle: string
  jiraUrl: string
  branchName: string
  worktreeParent?: string
  template: BoardPromptTemplate
  /** If set AND we're spawning fresh tmux, use `claude --resume <id>`
   *  instead of a brand-new session — preserves the full conversation
   *  history from the previous run of this task. */
  existingClaudeSessionId?: string
  /** Signals "the user hit Reopen on a Done task" — used to log the
   *  event more clearly and to skip the init template (a resumed task
   *  shouldn't re-run moxikit / re-create the KB entity). */
  isReopen?: boolean
}

export interface BoardTaskHandles {
  tmuxSessionId: string
  paneId: string
  ttydPort: number
  ttydPid: number
  claudeSessionId: string
  /** How Claude was booted this time: `fresh` = new --session-id + init
   *  template, `resumed` = --resume of a prior session, `attached` = tmux
   *  was already alive and we did nothing (assumes Claude is still there). */
  bootMode: 'fresh' | 'resumed' | 'attached'
}

function taskTmuxName(taskKey: string): string {
  // Jira keys use ASCII letters and digits and hyphens — safe for tmux.
  return `orka-board-task-${taskKey}`
}

export async function startBoardTask(
  opts: StartBoardTaskOptions,
): Promise<BoardTaskHandles> {
  const tmuxSessionId = taskTmuxName(opts.taskKey)
  let created = false
  try {
    await execa('tmux', ['has-session', '-t', tmuxSessionId])
  } catch {
    await execa('tmux', ['new-session', '-d', '-s', tmuxSessionId, '-c', opts.projectPath])
    created = true
  }

  const paneId = await TmuxCommands.getMainPaneId(tmuxSessionId)
  try {
    await TmuxCommands.setPaneLabel(paneId, opts.taskKey)
  } catch {
    // cosmetic only
  }

  const { port, pid } = await spawnTtydForTmux(tmuxSessionId)

  let claudeSessionId: string
  let bootMode: BoardTaskHandles['bootMode']

  if (!created) {
    // Tmux survived — assume Claude is still running there (or, if it
    // exited, the user will see a shell prompt and can `claude --resume`
    // themselves). Don't perturb by re-sending anything.
    claudeSessionId = opts.existingClaudeSessionId ?? ''
    bootMode = 'attached'
    logger.info(`Board task ${opts.taskKey} attached to existing tmux ${tmuxSessionId}`)
  } else if (opts.existingClaudeSessionId) {
    // Fresh tmux + known prior Claude session → resume history.
    claudeSessionId = opts.existingClaudeSessionId
    const resumePrompt = opts.isReopen
      ? `Reopening task ${opts.taskKey} — ${opts.taskTitle}. Continue where we left off; the ticket is back in In Progress on Jira.`
      : `Resuming task ${opts.taskKey}. Continue where we left off.`
    await TmuxCommands.sendKeys(paneId, `cd ${opts.projectPath}`)
    await TmuxCommands.sendEnter(paneId)
    await sleep(300)
    const command = `claude --resume ${claudeSessionId} "${escapeQuotes(resumePrompt)}"`
    await TmuxCommands.sendKeys(paneId, command)
    await TmuxCommands.sendEnter(paneId)
    await sleep(1500)
    bootMode = 'resumed'
    logger.info(`Board task terminal resumed for ${opts.taskKey} (session ${claudeSessionId})`)
  } else {
    // Fresh tmux + no prior session → new Claude with init template.
    claudeSessionId = uuidv4()
    const rendered = renderTemplate(opts.template.body, {
      taskKey: opts.taskKey,
      taskTitle: opts.taskTitle,
      jiraUrl: opts.jiraUrl,
      boardId: opts.boardId,
      projectPath: opts.projectPath,
      branchName: opts.branchName,
      worktreeParent: opts.worktreeParent ?? '',
    })
    await TmuxCommands.sendKeys(paneId, `cd ${opts.projectPath}`)
    await TmuxCommands.sendEnter(paneId)
    await sleep(300)
    const command = `claude --session-id ${claudeSessionId} "${escapeQuotes(rendered)}"`
    await TmuxCommands.sendKeys(paneId, command)
    await TmuxCommands.sendEnter(paneId)
    await sleep(1500)
    bootMode = 'fresh'
    logger.info(`Board task terminal started for ${opts.taskKey} on tmux ${tmuxSessionId}, ttyd :${port}`)
  }

  return { tmuxSessionId, paneId, ttydPort: port, ttydPid: pid, claudeSessionId, bootMode }
}

/**
 * Recovery result for a task terminal after a server restart.
 *
 * - `alive`   — tmux survived, we spawned a fresh ttyd and updated the
 *               task's handles. The web UI can iframe the new port.
 * - `dead`    — tmux is gone (a `tmux kill-server`, a reboot, whatever).
 *               The task's stored handles are cleared. UI should show a
 *               "Restart terminal" affordance that calls `startBoardTask`.
 * - `no-handles` — this task never had a terminal (kbEntityId set but the
 *               spawn was skipped), so nothing to recover.
 */
export type BoardTaskResumeStatus = 'alive' | 'dead' | 'no-handles'

export interface BoardTaskResumeResult {
  status: BoardTaskResumeStatus
  handles?: BoardTaskHandles
}

/**
 * Check whether a task's tmux session is still alive, and if so spawn a
 * fresh ttyd on top of it — updating the persisted handles so the UI
 * points at the live port. Idempotent-ish: calling twice on the same
 * alive task spawns two ttyds (the old one becomes orphaned when its
 * port is overwritten). To avoid that, upstream callers use the `alive`
 * result to short-circuit further calls in the same page load.
 */
export async function resumeBoardTask(
  projectPath: string,
  boardId: string,
  taskKey: string,
): Promise<BoardTaskResumeResult> {
  const mgr = new BoardManager(projectPath)
  const task = await mgr.getTask(boardId, taskKey)
  if (!task) throw new Error(`Task not found: ${taskKey}`)
  if (!task.terminalTmuxSessionId) return { status: 'no-handles' }

  // Reuse the ttyd if the pid we stored is still alive (same session
  // instance kept running). Otherwise fall back to tmux checks + fresh
  // ttyd. Guards the sweep from re-spawning ttyds it just spawned.
  if (task.ttydPid && isProcessAlive(task.ttydPid) && task.ttydPort && task.terminalPaneId) {
    return {
      status: 'alive',
      handles: {
        tmuxSessionId: task.terminalTmuxSessionId,
        paneId: task.terminalPaneId,
        ttydPort: task.ttydPort,
        ttydPid: task.ttydPid,
        claudeSessionId: task.claudeSessionId ?? '',
        bootMode: 'attached',
      },
    }
  }

  // Is the tmux session still there?
  try {
    await execa('tmux', ['has-session', '-t', task.terminalTmuxSessionId])
  } catch {
    // Dead — clear stale handles so the UI stops trying to iframe a
    // dead port on every re-render.
    await mgr.detachTaskTerminal(boardId, taskKey)
    return { status: 'dead' }
  }

  // Tmux is alive but ttyd died with the previous server process.
  // Spawn a fresh one and persist the new handles.
  const paneId = await TmuxCommands.getMainPaneId(task.terminalTmuxSessionId)
  const { port, pid } = await spawnTtydForTmux(task.terminalTmuxSessionId)
  const handles: BoardTaskHandles = {
    tmuxSessionId: task.terminalTmuxSessionId,
    paneId,
    ttydPort: port,
    ttydPid: pid,
    claudeSessionId: task.claudeSessionId ?? '',
    bootMode: 'attached',
  }
  await mgr.attachTaskTerminal(boardId, taskKey, {
    terminalPaneId: paneId,
    terminalTmuxSessionId: task.terminalTmuxSessionId,
    ttydPort: port,
    ttydPid: pid,
    claudeSessionId: task.claudeSessionId,
  })
  logger.info(`Board task ${taskKey} ttyd revived on port ${port}`)
  return { status: 'alive', handles }
}

export async function stopBoardTask(taskKey: string, ttydPid?: number): Promise<void> {
  const tmuxSessionId = taskTmuxName(taskKey)
  if (ttydPid && isProcessAlive(ttydPid)) {
    try {
      process.kill(ttydPid, 'SIGTERM')
    } catch (err: any) {
      logger.warn(`Failed to kill board task ttyd: ${err.message}`)
    }
  }
  try {
    await execa('tmux', ['kill-session', '-t', tmuxSessionId])
  } catch {
    // fine
  }
}

/**
 * Send the close-template prompt to a running task terminal so Claude runs
 * its wrap-up ritual (PR, Jira comment, KB update, worktree cleanup).
 */
export async function sendCloseToBoardTask(
  taskKey: string,
  closeTemplate: BoardPromptTemplate,
  vars: Record<string, string | undefined>,
): Promise<void> {
  const tmuxSessionId = taskTmuxName(taskKey)
  try {
    await execa('tmux', ['has-session', '-t', tmuxSessionId])
  } catch {
    // If the terminal was already killed, nothing to send.
    logger.info(`Task terminal ${tmuxSessionId} not alive — skipping close prompt`)
    return
  }
  const paneId = await TmuxCommands.getMainPaneId(tmuxSessionId)
  const rendered = renderTemplate(closeTemplate.body, vars)
  await TmuxCommands.sendKeys(paneId, rendered)
  await TmuxCommands.sendEnter(paneId)
}

/**
 * Re-send the init-template prompt to an already-running task terminal.
 * Used by the "Restart init" action so the user can pick up updated
 * skills or a new template without closing + reopening (which would lose
 * the current in-flight Claude context).
 *
 * The prompt renders with the same placeholders `startBoardTask` uses,
 * so it stays in sync with the boot flow.
 */
export async function sendInitToBoardTask(
  taskKey: string,
  initTemplate: BoardPromptTemplate,
  vars: Record<string, string | undefined>,
): Promise<void> {
  const tmuxSessionId = taskTmuxName(taskKey)
  try {
    await execa('tmux', ['has-session', '-t', tmuxSessionId])
  } catch {
    throw new Error(`Task terminal for ${taskKey} is not running — cannot restart init prompt`)
  }
  const paneId = await TmuxCommands.getMainPaneId(tmuxSessionId)
  const rendered = renderTemplate(initTemplate.body, vars)
  await TmuxCommands.sendKeys(paneId, rendered)
  await TmuxCommands.sendEnter(paneId)
  logger.info(`Board task ${taskKey} init prompt re-sent`)
}

/**
 * Convenience: attach the freshly-spawned terminal handles back to the
 * BoardTask row so the UI can render "terminal is up" and the server can
 * later shut it down.
 */
export async function persistTaskHandles(
  projectPath: string,
  boardId: string,
  taskKey: string,
  h: BoardTaskHandles,
): Promise<void> {
  const mgr = new BoardManager(projectPath)
  await mgr.attachTaskTerminal(boardId, taskKey, {
    terminalPaneId: h.paneId,
    terminalTmuxSessionId: h.tmuxSessionId,
    ttydPort: h.ttydPort,
    ttydPid: h.ttydPid,
    // Only overwrite `claudeSessionId` when we actually know it — an
    // `attached` boot mode returns whatever we had (which may be
    // undefined for pre-migration tasks); leaving it untouched then.
    claudeSessionId: h.claudeSessionId || undefined,
  })
}
