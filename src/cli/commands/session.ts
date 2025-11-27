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
    const forkCount = session.forks.length > 0 ? chalk.gray(` (${session.forks.length} forks)`) : ''

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

          if (session.forks.length > 0) {
            Output.section('\n🌿 Forks:')
            for (const fork of session.forks) {
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
