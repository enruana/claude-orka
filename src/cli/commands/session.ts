import { Command } from 'commander'
import ora from 'ora'
import chalk from 'chalk'
import { ClaudeOrka } from '../../core/ClaudeOrka'
import { Output } from '../utils/output'
import { handleError, validateInitialized, validateSessionId } from '../utils/errors'
import { Session } from '../../models/Session'
import { ClaudeSessionSummary } from '../../utils/claude-history'
import readline from 'readline'

/**
 * Interactive Orka session selector
 */
async function selectSession(sessions: Session[]): Promise<Session | null> {
  if (sessions.length === 0) {
    Output.warn('No sessions available.')
    return null
  }

  console.log(chalk.bold.cyan('\n📋 Select a session:\n'))

  // Display sessions with index
  sessions.forEach((session, index) => {
    const statusColor = session.status === 'active' ? chalk.green : chalk.yellow
    const status = statusColor(`[${session.status}]`)
    const forks = session.forks || []
    const forkCount = forks.length > 0 ? chalk.gray(` (${forks.length} forks)`) : ''

    console.log(`  ${chalk.bold(index + 1)}. ${session.name || 'Unnamed'} ${status}${forkCount}`)
    console.log(chalk.gray(`     ID: ${session.id.slice(0, 8)}...`))
    console.log()
  })

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.cyan('Enter number (or q to quit): '), resolve)
  })

  rl.close()

  if (answer.toLowerCase() === 'q') {
    return null
  }

  const index = parseInt(answer, 10) - 1

  if (isNaN(index) || index < 0 || index >= sessions.length) {
    Output.error('Invalid selection')
    return null
  }

  return sessions[index]
}

/**
 * Format relative time from timestamp
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / (1000 * 60))
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`
  if (minutes > 0) return `${minutes} min${minutes > 1 ? 's' : ''} ago`
  return 'just now'
}

/**
 * Interactive Claude session selector for continuing from existing session
 */
async function selectClaudeSession(
  sessions: ClaudeSessionSummary[]
): Promise<ClaudeSessionSummary | 'new' | null> {
  console.log(chalk.bold.cyan('\n🔄 Select a Claude session to continue from:\n'))

  // Option 0: Create new session
  console.log(`  ${chalk.bold('0')}. ${chalk.green('Create new session')} ${chalk.gray('(fresh start)')}`)
  console.log()

  // Display Claude sessions with index
  sessions.forEach((session, index) => {
    const timeAgo = chalk.gray(formatRelativeTime(session.lastTimestamp))
    const msgCount = chalk.blue(`[${session.messageCount} msgs]`)
    const preview = session.firstMessage.length > 50
      ? session.firstMessage.substring(0, 50) + '...'
      : session.firstMessage

    console.log(`  ${chalk.bold(index + 1)}. ${msgCount} ${chalk.white(`"${preview}"`)}`)
    console.log(chalk.gray(`     ${timeAgo} • ID: ${session.sessionId.slice(0, 8)}...`))
    console.log()
  })

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.cyan('Enter number (or q to quit): '), resolve)
  })

  rl.close()

  if (answer.toLowerCase() === 'q') {
    return null
  }

  const index = parseInt(answer, 10)

  if (isNaN(index) || index < 0 || index > sessions.length) {
    Output.error('Invalid selection')
    return null
  }

  // Option 0 = new session
  if (index === 0) {
    return 'new'
  }

  return sessions[index - 1]
}

export function sessionCommand(program: Command) {
  const session = program.command('session').description('Manage Claude sessions')

  // Create session
  session
    .command('create [name]')
    .description('Create a new Claude session')
    .option('--no-terminal', 'Do not open terminal window')
    .option('-c, --continue', 'Continue from an existing Claude session (interactive selector)')
    .option('--from <session-id>', 'Continue from a specific Claude session ID')
    .action(async (name, options) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        let continueFromClaudeSession: string | undefined

        // Handle --continue flag (interactive selector)
        if (options.continue) {
          const claudeSessions = await orka.listClaudeSessions(10)

          if (claudeSessions.length === 0) {
            Output.warn('No previous Claude sessions found for this project.')
            Output.info('Creating a new session instead...')
          } else {
            const selected = await selectClaudeSession(claudeSessions)

            if (selected === null) {
              Output.info('Cancelled.')
              process.exit(0)
            }

            if (selected !== 'new') {
              continueFromClaudeSession = selected.sessionId
              Output.success(`Continuing from Claude session: ${selected.sessionId.slice(0, 8)}...`)
            }
          }
        }

        // Handle --from flag (specific session ID)
        if (options.from) {
          continueFromClaudeSession = options.from
          Output.info(`Continuing from Claude session: ${options.from.slice(0, 8)}...`)
        }

        const spinner = ora('Creating session...').start()

        const newSession = await orka.createSession({
          name,
          openTerminal: options.terminal,
          continueFromClaudeSession,
        })

        spinner.succeed('Session created!')

        Output.session(newSession)
        Output.newline()

        if (continueFromClaudeSession) {
          Output.info('Claude will continue with the context from the previous session.')
        }

        Output.info(`You can now interact with Claude in the tmux window.`)
        Output.info(`To create a fork: orka fork create ${newSession.id}`)
      } catch (error) {
        handleError(error)
      }
    })

  // List sessions
  session
    .command('list')
    .description('List all sessions')
    .option('-s, --status <status>', 'Filter by status (active, saved)')
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const filters = options.status ? { status: options.status } : undefined
        const sessions = await orka.listSessions(filters)

        if (options.json) {
          Output.json(sessions)
        } else {
          Output.header('📋 Sessions')
          Output.sessionsTable(sessions)
        }
      } catch (error) {
        handleError(error)
      }
    })

  // Get session
  session
    .command('get <session-id>')
    .description('Get session details')
    .option('-j, --json', 'Output as JSON')
    .action(async (sessionId, options) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const session = await orka.getSession(sessionId)

        if (!session) {
          Output.error(`Session not found: ${sessionId}`)
          process.exit(1)
        }

        if (options.json) {
          Output.json(session)
        } else {
          Output.session(session)

          const sessionForks = session.forks || []
          if (sessionForks.length > 0) {
            Output.section('\n🌿 Forks:')
            for (const fork of sessionForks) {
              Output.fork(fork)
            }
          }
        }
      } catch (error) {
        handleError(error)
      }
    })

  // Resume session
  session
    .command('resume [session-id]')
    .description('Resume a saved session (interactive if no ID provided)')
    .option('--no-terminal', 'Do not open terminal window')
    .action(async (sessionId, options) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        // If no session ID provided, show interactive selector
        if (!sessionId) {
          const sessions = await orka.listSessions()

          if (sessions.length === 0) {
            Output.warn('No sessions available to resume.')
            Output.info('Create a new session with: orka session create')
            process.exit(0)
          }

          const selectedSession = await selectSession(sessions)

          if (!selectedSession) {
            Output.info('Cancelled.')
            process.exit(0)
          }

          sessionId = selectedSession.id
        } else {
          validateSessionId(sessionId)
        }

        const spinner = ora('Resuming session...').start()

        const resumedSession = await orka.resumeSession(sessionId, options.terminal)

        spinner.succeed('Session resumed!')

        Output.session(resumedSession)
        Output.newline()
        Output.info('Session and all saved forks have been restored.')
        Output.info('Claude will remember the context of all conversations.')

        if (resumedSession.forks.length > 0) {
          const activeForks = resumedSession.forks.filter((f) => f.status === 'active')
          if (activeForks.length > 0) {
            Output.newline()
            Output.section('Restored forks:')
            for (const fork of activeForks) {
              Output.fork(fork)
            }
          }
        }
      } catch (error) {
        handleError(error)
      }
    })

  // Close session
  session
    .command('close <session-id>')
    .description('Close a session (saves it for later)')
    .action(async (sessionId) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const spinner = ora('Closing session...').start()

        await orka.closeSession(sessionId)

        spinner.succeed('Session closed!')

        Output.info('Session has been saved. You can resume it later with:')
        Output.info(`  orka session resume ${sessionId}`)
      } catch (error) {
        handleError(error)
      }
    })

  // Verify session — audit claudeSessionIds for cross-contamination
  session
    .command('verify [session-id]')
    .description('Audit each branch of a session for missing / cross-contaminated Claude session IDs')
    .action(async (sessionId) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        let target = sessionId
        if (!target) {
          const sessions = await orka.listSessions()
          const picked = await selectSession(sessions)
          if (!picked) return
          target = picked.id
        }
        validateSessionId(target)

        const { StateManager } = await import('../../core/StateManager')
        const { claudeSessionFileExists, listProjectSessions } = await import('../../utils/claude-history')

        const sm = new StateManager(projectPath)
        await sm.initialize()
        const session = await sm.getSession(target)
        if (!session) {
          Output.error(`Session ${target} not found`)
          return
        }

        const allSessions = await sm.getAllSessions()
        const owners = new Map<string, Array<{ sessionName: string; branch: string }>>()
        for (const s of allSessions) {
          if (s.main.claudeSessionId) {
            const arr = owners.get(s.main.claudeSessionId) || []
            arr.push({ sessionName: s.name, branch: 'main' })
            owners.set(s.main.claudeSessionId, arr)
          }
          for (const f of s.forks) {
            if (f.status !== 'active' && f.status !== 'saved') continue
            if (!f.claudeSessionId) continue
            const arr = owners.get(f.claudeSessionId) || []
            arr.push({ sessionName: s.name, branch: f.name || f.id })
            owners.set(f.claudeSessionId, arr)
          }
        }

        const { getSessionContextSummary, readMeaningfulUserPrompt } = await import('../../utils/claude-history')

        const jsonls = await listProjectSessions(projectPath)
        const cwdById = new Map(jsonls.map((e) => [e.sessionId, e.projectPath] as const))

        console.log()
        console.log(chalk.bold.cyan(`Audit — ${session.name}`))
        console.log(chalk.gray(`Project: ${projectPath}`))
        console.log()

        const rows: Array<{
          branch: string
          name: string
          id: string
          issues: string[]
          extra?: string
          summary?: string
          firstPrompt?: string
        }> = []

        const audit = async (branch: string, name: string, id: string) => {
          const issues: string[] = []
          let extra = ''
          if (!id) {
            issues.push('missing-id')
          } else {
            const exists = await claudeSessionFileExists(projectPath, id)
            if (!exists) issues.push('missing')
            const cwd = cwdById.get(id)
            if (cwd && cwd !== projectPath) {
              issues.push('mismatched-cwd')
              extra = `cwd=${cwd}`
            }
            const list = owners.get(id) || []
            if (list.length > 1) {
              issues.push('duplicate')
              extra = 'shared by: ' + list.map((o) => `${o.sessionName}/${o.branch}`).join(', ')
            }
          }
          let summary: string | undefined
          let firstPrompt: string | undefined
          if (id) {
            try { summary = (await getSessionContextSummary(projectPath, id)) || undefined } catch {}
            try { firstPrompt = (await readMeaningfulUserPrompt(projectPath, id)) || undefined } catch {}
          }
          rows.push({ branch, name, id, issues, extra, summary, firstPrompt })
        }

        await audit('main', session.main.label || 'main', session.main.claudeSessionId)
        for (const f of session.forks) {
          if (f.status !== 'active' && f.status !== 'saved') continue
          await audit(f.id, f.name, f.claudeSessionId)
        }

        for (const r of rows) {
          const idShort = r.id ? r.id.slice(0, 8) + '…' : '(none)'
          const preview = r.summary || r.firstPrompt || ''
          const previewLine = preview
            ? chalk.gray(`      "${preview.slice(0, 90)}${preview.length > 90 ? '…' : ''}"`)
            : ''
          if (r.issues.length === 0) {
            console.log(`  ${chalk.green('✓')} ${chalk.bold(r.name)} ${chalk.gray(idShort)}`)
            if (previewLine) console.log(previewLine)
          } else {
            console.log(`  ${chalk.red('✗')} ${chalk.bold(r.name)} ${chalk.gray(idShort)}  ${chalk.red(r.issues.join(', '))}`)
            if (previewLine) console.log(previewLine)
            if (r.extra) console.log(chalk.gray(`      ${r.extra}`))
            console.log(chalk.gray(`      Fix: orka session reset-branch ${target} ${r.branch}`))
          }
        }

        const bad = rows.filter((r) => r.issues.length > 0).length
        console.log()
        if (bad === 0) {
          Output.success(`All ${rows.length} branches look structurally healthy.`)
          console.log(chalk.gray('If a preview above does not match the branch name, the id is semantically wrong.'))
          console.log(chalk.gray(`Reset it with: orka session reset-branch ${target} <branch>`))
        } else {
          Output.warn(`${bad}/${rows.length} branch(es) need attention.`)
        }
      } catch (error) {
        handleError(error)
      }
    })

  // Reset a branch's claude session id — remedy for contamination
  session
    .command('reset-branch <session-id> <branch-id>')
    .description('Wipe a branch\'s Claude session id so the next resume starts a fresh conversation. Use \'main\' or a fork id.')
    .action(async (sessionId, branchId) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const { v4: uuidv4 } = await import('uuid')
        const { StateManager } = await import('../../core/StateManager')

        const sm = new StateManager(projectPath)
        await sm.initialize()
        const session = await sm.getSession(sessionId)
        if (!session) {
          Output.error(`Session ${sessionId} not found`)
          return
        }

        const oldId: string | undefined = branchId === 'main'
          ? session.main.claudeSessionId
          : session.forks.find((f) => f.id === branchId)?.claudeSessionId

        const newId = uuidv4()
        if (branchId === 'main') {
          session.main.claudeSessionId = newId
          session.main.lastContextSummary = undefined
        } else {
          const fork = session.forks.find((f) => f.id === branchId)
          if (!fork) {
            Output.error(`Fork ${branchId} not found in session ${sessionId}`)
            return
          }
          fork.claudeSessionId = newId
          fork.lastContextSummary = undefined
        }
        session.lastActivity = new Date().toISOString()
        await sm.replaceSession(session)

        Output.success(
          `Reset ${session.name}/${branchId}: ${(oldId || 'none').slice(0, 8)}… → ${newId.slice(0, 8)}…`
        )
        Output.info('Next resume for this branch will create a fresh Claude conversation.')
      } catch (error) {
        handleError(error)
      }
    })

  // Show pane-to-branch mapping — helps diagnose state/tmux drift
  session
    .command('panes <session-id>')
    .description('Show live tmux panes vs. state-expected branches for a session (diagnose drift)')
    .action(async (sessionId) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const { StateManager } = await import('../../core/StateManager')
        const { TmuxCommands } = await import('../../utils/tmux')

        const sm = new StateManager(projectPath)
        await sm.initialize()
        const session = await sm.getSession(sessionId)
        if (!session) {
          Output.error(`Session ${sessionId} not found`)
          return
        }

        const live = await TmuxCommands.listPanesDetailed(session.tmuxSessionId).catch(() => [])

        console.log()
        console.log(chalk.bold.cyan(`Panes — ${session.name}`))
        console.log(chalk.gray(`Tmux session: ${session.tmuxSessionId}`))
        console.log()

        // State side
        console.log(chalk.bold('State branches:'))
        const stateBranches: Array<{ id: string; name: string; label?: string; paneId?: string; status: string }> = [
          { id: 'main', name: session.main.label || 'main', label: session.main.label, paneId: session.main.tmuxPaneId, status: session.main.status || 'active' },
          ...session.forks
            .filter((f) => f.status === 'active' || f.status === 'saved')
            .map((f) => ({ id: f.id, name: f.name, label: f.name, paneId: f.tmuxPaneId, status: f.status || 'active' })),
        ]
        const livePaneIds = new Set(live.map((p) => p.paneId))
        for (const b of stateBranches) {
          const paneAlive = b.paneId && livePaneIds.has(b.paneId)
          const check = paneAlive ? chalk.green('✓') : chalk.red('✗')
          const paneInfo = b.paneId ? chalk.gray(b.paneId + (paneAlive ? '' : ' (missing)')) : chalk.red('(no pane)')
          console.log(`  ${check} ${chalk.bold(b.name.padEnd(30))} ${paneInfo}  ${chalk.gray('id=' + b.id.slice(0, 8))}`)
        }

        // Live side
        console.log()
        console.log(chalk.bold('Live tmux panes:'))
        const claimedPaneIds = new Set<string>()
        if (session.main.tmuxPaneId) claimedPaneIds.add(session.main.tmuxPaneId)
        for (const f of session.forks) if (f.tmuxPaneId) claimedPaneIds.add(f.tmuxPaneId)
        if (live.length === 0) {
          console.log(chalk.red('  (no panes / tmux session not found)'))
        } else {
          for (const p of live) {
            const claimed = claimedPaneIds.has(p.paneId)
            const marker = claimed ? chalk.green('claimed') : chalk.yellow('orphan ')
            const label = p.label || chalk.gray('(no label)')
            console.log(`  ${p.paneId.padEnd(4)}  ${marker}  ${chalk.bold(label)}  ${chalk.gray(p.currentCommand)}`)
          }
        }

        // Untracked side
        console.log()
        console.log(chalk.bold('State untrackedPanes:'))
        const up = session.untrackedPanes || []
        if (up.length === 0) {
          console.log(chalk.gray('  (none)'))
        } else {
          for (const u of up) {
            const alive = livePaneIds.has(u.tmuxPaneId)
            const check = alive ? chalk.green('✓') : chalk.gray('✗')
            console.log(`  ${check} ${u.tmuxPaneId.padEnd(4)}  ${u.label || '(no label)'}  ${chalk.gray(u.currentPath)}`)
          }
        }

        // Hints
        const disconnected = stateBranches.filter((b) => !b.paneId || !livePaneIds.has(b.paneId))
        const orphans = live.filter((p) => !claimedPaneIds.has(p.paneId))
        if (disconnected.length > 0 || orphans.length > 0) {
          console.log()
          console.log(chalk.bold.yellow('Hints:'))
          for (const b of disconnected) {
            console.log(chalk.gray(`  Branch "${b.name}" has no live pane — adopt one with:`))
            console.log(chalk.gray(`    orka session adopt-pane ${sessionId} ${b.id} <pane-id>`))
          }
        }
      } catch (error) {
        handleError(error)
      }
    })

  // Adopt an existing tmux pane into a branch — remedy when state and
  // tmux are so far out of sync that automatic recovery can't decide.
  session
    .command('adopt-pane <session-id> <branch-id> <pane-id>')
    .description('Associate a live tmux pane with a branch (main or fork id). Use when state and tmux drifted apart.')
    .action(async (sessionId, branchId, paneId) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const { StateManager } = await import('../../core/StateManager')
        const { TmuxCommands } = await import('../../utils/tmux')

        const sm = new StateManager(projectPath)
        await sm.initialize()
        const session = await sm.getSession(sessionId)
        if (!session) {
          Output.error(`Session ${sessionId} not found`)
          return
        }

        // Sanity: pane must exist in this session's tmux window.
        const livePanes: string[] = await TmuxCommands.listPanes(session.tmuxSessionId).catch(() => [] as string[])
        if (!livePanes.includes(paneId)) {
          Output.error(`Pane ${paneId} not found in tmux session ${session.tmuxSessionId}`)
          Output.info(`Live panes: ${livePanes.join(', ') || '(none)'}`)
          return
        }

        // Guard: the pane must not already be claimed by another branch.
        if (session.main.tmuxPaneId === paneId && branchId !== 'main') {
          Output.error(`Pane ${paneId} is already claimed by main`)
          return
        }
        const claimingFork = session.forks.find((f) => f.tmuxPaneId === paneId)
        if (claimingFork && claimingFork.id !== branchId) {
          Output.error(`Pane ${paneId} is already claimed by fork "${claimingFork.name}"`)
          return
        }

        if (branchId === 'main') {
          session.main.tmuxPaneId = paneId
          await TmuxCommands.setPaneLabel(paneId, session.main.label || 'main')
        } else {
          const fork = session.forks.find((f) => f.id === branchId)
          if (!fork) {
            Output.error(`Fork ${branchId} not found in session ${sessionId}`)
            return
          }
          fork.tmuxPaneId = paneId
          fork.status = 'active'
          await TmuxCommands.setPaneLabel(paneId, fork.name)
        }
        session.lastActivity = new Date().toISOString()
        await sm.replaceSession(session)

        Output.success(`Adopted pane ${paneId} into ${session.name}/${branchId}`)
      } catch (error) {
        handleError(error)
      }
    })

  // Delete session
  session
    .command('delete <session-id>')
    .description('Permanently delete a session')
    .action(async (sessionId) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const spinner = ora('Deleting session...').start()

        await orka.deleteSession(sessionId)

        spinner.succeed('Session deleted!')

        Output.warn('Session has been permanently deleted.')
      } catch (error) {
        handleError(error)
      }
    })
}
