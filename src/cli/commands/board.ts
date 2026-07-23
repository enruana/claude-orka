import { Command } from 'commander'
import chalk from 'chalk'
import { Output } from '../utils/output'
import { handleError } from '../utils/errors'
import { BoardManager } from '../../core/BoardManager'
import { BoardTask } from '../../models/Board'

/**
 * Parse a repeatable `--property key=value` flag into a plain object.
 * Values are always stored as strings; downstream consumers can coerce.
 */
function parseProperties(props: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of props ?? []) {
    const idx = p.indexOf('=')
    if (idx === -1) throw new Error(`Invalid --property "${p}": expected key=value`)
    out[p.slice(0, idx).trim()] = p.slice(idx + 1)
  }
  return out
}

function parseCsv(v: string | undefined): string[] | undefined {
  if (!v) return undefined
  return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * `orka board *` — CRUD + lifecycle for Board sessions and their Jira-mirrored
 * tasks. Same file/CLI shape as `orka kb *`. All mutations flow through
 * `BoardManager` so schema and event log stay consistent.
 */
export function boardCommand(program: Command): void {
  const board = program.command('board').description('Manage Jira-integrated boards')

  // ---------- Board lifecycle ----------

  board
    .command('create')
    .description('Create a new board in the current project')
    .requiredOption('--name <name>', 'Board name')
    .requiredOption('--jira-url <url>', 'Jira board URL')
    .option('--jql <jql>', 'Custom JQL (defaults to assignee = currentUser())')
    .option('--columns <csv>', 'Comma-separated column list (defaults to todo,in-progress,review,done)')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        const cfg = await mgr.createBoard({
          name: opts.name,
          jiraUrl: opts.jiraUrl,
          jql: opts.jql,
          columns: parseCsv(opts.columns),
        })
        Output.success(`Created board ${cfg.id} (${cfg.name})`)
        console.log(chalk.gray(`  Jira URL: ${cfg.jiraUrl}`))
        console.log(chalk.gray(`  Columns:  ${cfg.columns.join(' → ')}`))
      } catch (error) {
        handleError(error)
      }
    })

  board
    .command('list')
    .description('List all boards in the current project')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        const boards = await mgr.listBoards()
        if (opts.json) {
          console.log(JSON.stringify(boards, null, 2))
          return
        }
        if (boards.length === 0) {
          Output.info('No boards in this project. Create one with: orka board create --name ... --jira-url ...')
          return
        }
        for (const b of boards) {
          console.log(chalk.bold(`${b.id}`) + `  ${b.name}`)
          console.log(chalk.gray(`  ${b.jiraUrl}`))
        }
      } catch (error) {
        handleError(error)
      }
    })

  board
    .command('show')
    .description('Show board configuration')
    .requiredOption('--board <id>', 'Board id')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        const cfg = await mgr.getBoard(opts.board)
        if (!cfg) {
          Output.error(`Board not found: ${opts.board}`)
          return
        }
        if (opts.json) {
          console.log(JSON.stringify(cfg, null, 2))
          return
        }
        console.log(chalk.bold(cfg.name) + chalk.gray(` (${cfg.id})`))
        console.log(`  Jira URL:      ${cfg.jiraUrl}`)
        if (cfg.jql) console.log(`  JQL:           ${cfg.jql}`)
        console.log(`  Columns:       ${cfg.columns.join(' → ')}`)
        if (cfg.lastSyncedAt) console.log(`  Last synced:   ${cfg.lastSyncedAt}`)
        console.log(chalk.gray(`  Created:       ${cfg.createdAt}`))
      } catch (error) {
        handleError(error)
      }
    })

  board
    .command('update')
    .description('Update board configuration')
    .requiredOption('--board <id>', 'Board id')
    .option('--name <name>', 'Rename the board')
    .option('--jira-url <url>', 'Change the Jira URL')
    .option('--jql <jql>', 'Change the JQL')
    .option('--columns <csv>', 'Replace the column list (comma-separated)')
    .option('--add-column <name>', 'Append a column')
    .option('--master-prompt <id>', 'Master prompt template id')
    .option('--sync-prompt <id>', 'Sync prompt template id')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        const patch: any = {}
        if (opts.name) patch.name = opts.name
        if (opts.jiraUrl) patch.jiraUrl = opts.jiraUrl
        if (opts.jql) patch.jql = opts.jql
        if (opts.columns) patch.columns = parseCsv(opts.columns)
        if (opts.addColumn) {
          const cur = await mgr.getBoard(opts.board)
          if (!cur) throw new Error(`Board not found: ${opts.board}`)
          if (!cur.columns.includes(opts.addColumn)) {
            patch.columns = [...cur.columns, opts.addColumn]
          }
        }
        if (opts.masterPrompt) patch.masterPromptId = opts.masterPrompt
        if (opts.syncPrompt) patch.syncPromptId = opts.syncPrompt
        const next = await mgr.updateBoard(opts.board, patch)
        Output.success(`Updated board ${next.id}`)
      } catch (error) {
        handleError(error)
      }
    })

  board
    .command('delete')
    .description('Delete a board and all its local data (Jira not touched)')
    .requiredOption('--board <id>', 'Board id')
    .option('--yes', 'Skip confirmation')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        const cfg = await mgr.getBoard(opts.board)
        if (!cfg) {
          Output.error(`Board not found: ${opts.board}`)
          return
        }
        if (!opts.yes) {
          Output.warn(`This will delete board "${cfg.name}" (${cfg.id}) and all its local tasks/attachments.`)
          Output.info('Re-run with --yes to confirm.')
          return
        }
        await mgr.deleteBoard(opts.board)
        Output.success(`Deleted board ${opts.board}`)
      } catch (error) {
        handleError(error)
      }
    })

  // ---------- Task CRUD ----------

  board
    .command('add-task')
    .description('Add a task to a board')
    .requiredOption('--board <id>', 'Board id')
    .requiredOption('--key <PROJ-123>', 'Jira issue key')
    .requiredOption('--title <title>', 'Task title')
    .requiredOption('--status <status>', 'Column name — must match one of the board columns')
    .requiredOption('--jira-url <url>', 'Canonical URL to the ticket')
    .option('--description <text>', 'Longer description')
    .option('--priority <p>', 'Priority label')
    .option('--assignee <name>', 'Assignee display name')
    .option('--reporter <name>', 'Reporter display name')
    .option('--labels <csv>', 'Comma-separated labels')
    .option('--raw <json>', 'Raw Jira issue dump (JSON string)')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        const raw = opts.raw ? JSON.parse(opts.raw) : undefined
        const created = await mgr.addTask(opts.board, {
          key: opts.key,
          title: opts.title,
          status: opts.status,
          jiraUrl: opts.jiraUrl,
          description: opts.description,
          priority: opts.priority,
          assignee: opts.assignee,
          reporter: opts.reporter,
          labels: parseCsv(opts.labels),
          raw,
        })
        Output.success(`Added task ${created.key} in board ${opts.board}`)
      } catch (error) {
        handleError(error)
      }
    })

  board
    .command('update-task')
    .description('Update fields on a task (partial patch)')
    .requiredOption('--board <id>', 'Board id')
    .requiredOption('--key <PROJ-123>', 'Jira issue key')
    .option('--title <title>')
    .option('--description <text>')
    .option('--status <status>')
    .option('--priority <p>')
    .option('--assignee <name>')
    .option('--reporter <name>')
    .option('--labels <csv>')
    .option('--kb-entity <id>', 'KB entity id linked to this task')
    .option('--worktree-path <path>')
    .option('--branch-name <name>')
    .option('--property <k=v...>', 'Additional inline property to store under raw (repeatable)', (v: string, prev: string[] = []) => [...prev, v])
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        const patch: Partial<BoardTask> = {}
        if (opts.title) patch.title = opts.title
        if (opts.description) patch.description = opts.description
        if (opts.status) patch.status = opts.status
        if (opts.priority) patch.priority = opts.priority
        if (opts.assignee) patch.assignee = opts.assignee
        if (opts.reporter) patch.reporter = opts.reporter
        if (opts.labels) patch.labels = parseCsv(opts.labels)
        if (opts.kbEntity) patch.kbEntityId = opts.kbEntity
        if (opts.worktreePath) patch.worktreePath = opts.worktreePath
        if (opts.branchName) patch.branchName = opts.branchName
        const extra = parseProperties(opts.property)
        if (Object.keys(extra).length > 0) {
          // Fold extra k=v pairs into the existing raw dump so custom
          // fields survive without a schema change.
          const cur = await mgr.getTask(opts.board, opts.key)
          const rawBase: Record<string, unknown> = cur?.raw && typeof cur.raw === 'object' ? { ...(cur.raw as any) } : {}
          patch.raw = { ...rawBase, ...extra }
        }
        const next = await mgr.updateTask(opts.board, opts.key, patch)
        Output.success(`Updated task ${next.key}`)
      } catch (error) {
        handleError(error)
      }
    })

  board
    .command('remove-task')
    .description('Remove a task from a board (does NOT touch Jira)')
    .requiredOption('--board <id>')
    .requiredOption('--key <PROJ-123>')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        await mgr.removeTask(opts.board, opts.key)
        Output.success(`Removed task ${opts.key}`)
      } catch (error) {
        handleError(error)
      }
    })

  board
    .command('list-tasks')
    .description('List tasks in a board')
    .requiredOption('--board <id>')
    .option('--status <status>', 'Filter by column')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        const tasks = await mgr.listTasks(opts.board, opts.status ? { status: opts.status } : undefined)
        if (opts.json) {
          console.log(JSON.stringify(tasks, null, 2))
          return
        }
        if (tasks.length === 0) {
          Output.info('No tasks match.')
          return
        }
        for (const t of tasks) {
          const status = chalk.gray(`[${t.status}]`)
          const assignee = t.assignee ? chalk.gray(` @${t.assignee}`) : ''
          console.log(`${chalk.bold(t.key)} ${status} ${t.title}${assignee}`)
        }
      } catch (error) {
        handleError(error)
      }
    })

  board
    .command('show-task')
    .description('Show a single task')
    .requiredOption('--board <id>')
    .requiredOption('--key <PROJ-123>')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        const t = await mgr.getTask(opts.board, opts.key)
        if (!t) {
          Output.error(`Task not found: ${opts.key}`)
          return
        }
        if (opts.json) {
          console.log(JSON.stringify(t, null, 2))
          return
        }
        console.log(chalk.bold(`${t.key} — ${t.title}`))
        console.log(`  Status:        ${t.status}`)
        if (t.priority) console.log(`  Priority:      ${t.priority}`)
        if (t.assignee) console.log(`  Assignee:      ${t.assignee}`)
        if (t.reporter) console.log(`  Reporter:      ${t.reporter}`)
        if (t.labels && t.labels.length > 0) console.log(`  Labels:        ${t.labels.join(', ')}`)
        console.log(`  Jira:          ${t.jiraUrl}`)
        if (t.kbEntityId) console.log(`  KB entity:     ${t.kbEntityId}`)
        if (t.worktreePath) console.log(`  Worktree:      ${t.worktreePath}`)
        if (t.branchName) console.log(`  Branch:        ${t.branchName}`)
        if (t.terminalPaneId) console.log(chalk.gray(`  Terminal:      pane ${t.terminalPaneId} (ttyd :${t.ttydPort})`))
        if (t.description) {
          console.log()
          console.log(t.description)
        }
      } catch (error) {
        handleError(error)
      }
    })

  // ---------- Drift ----------

  board
    .command('mark-drift')
    .description('Flag a task as drifted (Jira status ≠ local, no active terminal)')
    .requiredOption('--board <id>')
    .requiredOption('--key <PROJ-123>')
    .requiredOption('--from <status>', 'Local status')
    .requiredOption('--to <status>', 'Remote (Jira) status')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        const d = await mgr.markDrift(opts.board, opts.key, opts.from, opts.to)
        Output.success(`Drift marked on ${opts.key}: ${d.fromStatus} → ${d.toStatus}`)
      } catch (error) {
        handleError(error)
      }
    })

  board
    .command('ack-drift')
    .description('Acknowledge / dismiss a drift alert')
    .requiredOption('--board <id>')
    .requiredOption('--key <PROJ-123>')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        await mgr.ackDrift(opts.board, opts.key)
        Output.success(`Drift acknowledged for ${opts.key}`)
      } catch (error) {
        handleError(error)
      }
    })

  board
    .command('list-drifts')
    .description('List all pending drift alerts on a board')
    .requiredOption('--board <id>')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        const drifts = await mgr.listDrifts(opts.board)
        if (opts.json) {
          console.log(JSON.stringify(drifts, null, 2))
          return
        }
        if (drifts.length === 0) {
          Output.info('No drift.')
          return
        }
        for (const d of drifts) {
          console.log(`${chalk.yellow(d.taskKey)}: ${d.fromStatus} → ${d.toStatus} ${chalk.gray('(' + d.detectedAt + ')')}`)
        }
      } catch (error) {
        handleError(error)
      }
    })

  // ---------- Sync bookkeeping ----------

  board
    .command('sync')
    .description('Mark a sync completed (bumps lastSyncedAt). Trigger for the master lives in the API.')
    .requiredOption('--board <id>')
    .option('--started', 'Mark sync as started (append event only)')
    .option('--added <n>', 'Task counts to record')
    .option('--updated <n>')
    .option('--unchanged <n>')
    .option('--drift <n>')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        if (opts.started) {
          await mgr.markSyncStarted(opts.board)
          Output.info('Sync started')
          return
        }
        await mgr.markSyncCompleted(opts.board, {
          added: opts.added !== undefined ? Number(opts.added) : undefined,
          updated: opts.updated !== undefined ? Number(opts.updated) : undefined,
          unchanged: opts.unchanged !== undefined ? Number(opts.unchanged) : undefined,
          drift: opts.drift !== undefined ? Number(opts.drift) : undefined,
        })
        Output.success('Sync recorded')
      } catch (error) {
        handleError(error)
      }
    })

  // ---------- Attachments ----------

  board
    .command('attach-comment')
    .description('Store a Jira comment locally under attachments/<taskKey>/comments.jsonl')
    .requiredOption('--board <id>')
    .requiredOption('--key <PROJ-123>')
    .requiredOption('--author <name>')
    .requiredOption('--body <text>')
    .option('--created-at <iso>')
    .option('--jira-comment-id <id>')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        await mgr.attachComment(opts.board, opts.key, {
          author: opts.author,
          body: opts.body,
          createdAt: opts.createdAt,
          jiraCommentId: opts.jiraCommentId,
        })
        Output.success(`Comment stored on ${opts.key}`)
      } catch (error) {
        handleError(error)
      }
    })

  board
    .command('attach-doc')
    .description('Copy a doc into attachments/<taskKey>/docs/')
    .requiredOption('--board <id>')
    .requiredOption('--key <PROJ-123>')
    .requiredOption('--path <file>', 'Source file to copy')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        const stored = await mgr.attachDoc(opts.board, opts.key, opts.path)
        Output.success(`Doc stored at ${stored}`)
      } catch (error) {
        handleError(error)
      }
    })

  // ---------- Task lifecycle (server-side spawn) ----------
  // These are placeholders that only mutate local state so the CLI
  // contract is complete. The actual tmux/ttyd/claude spawn happens in
  // `SessionManager.startBoardTask` — the API route calls both.

  board
    .command('start-task')
    .description('Mark a task as started (server API spawns the terminal separately)')
    .requiredOption('--board <id>')
    .requiredOption('--key <PROJ-123>')
    .option('--template <id>', 'Init template id (default: full)')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        await mgr.updateTask(opts.board, opts.key, { status: 'in-progress' })
        Output.success(`Task ${opts.key} marked in-progress (template: ${opts.template || 'full'})`)
        Output.info('Terminal spawn is handled by the Orka server. Use the web UI or the API to spawn it.')
      } catch (error) {
        handleError(error)
      }
    })

  board
    .command('close-task')
    .description('Mark a task as closed / done and (optionally) detach its terminal handles')
    .requiredOption('--board <id>')
    .requiredOption('--key <PROJ-123>')
    .option('--status <status>', 'Target status', 'done')
    .option('--terminal <mode>', 'Terminal action: keep|detach|shutdown', 'keep')
    .action(async (opts) => {
      try {
        const mgr = new BoardManager(process.cwd())
        await mgr.updateTask(opts.board, opts.key, { status: opts.status })
        if (opts.terminal === 'detach' || opts.terminal === 'shutdown') {
          await mgr.detachTaskTerminal(opts.board, opts.key)
        }
        Output.success(`Task ${opts.key} closed (${opts.status})`)
        if (opts.terminal === 'shutdown') {
          Output.info('Terminal shutdown is handled by the Orka server. Use the web UI or API.')
        }
      } catch (error) {
        handleError(error)
      }
    })
}
