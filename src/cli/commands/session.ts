import { Command } from 'commander'
import ora from 'ora'
import chalk from 'chalk'
import { ClaudeOrka } from '../../core/ClaudeOrka'
import { Output } from '../utils/output'
import { handleError, validateInitialized, validateSessionId } from '../utils/errors'
import { Session } from '../../models/Session'
import readline from 'readline'

/**
 * Interactive session selector
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

export function sessionCommand(program: Command) {
  const session = program.command('session').description('Manage Claude sessions')

  // Create session
  session
    .command('create [name]')
    .description('Create a new Claude session')
    .option('--no-terminal', 'Do not open terminal window')
    .action(async (name, options) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const spinner = ora('Creating session...').start()

        const newSession = await orka.createSession(name, options.terminal)

        spinner.succeed('Session created!')

        Output.session(newSession)
        Output.newline()
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
          const sessions = await orka.listSessions({ status: 'saved' })

          if (sessions.length === 0) {
            Output.warn('No saved sessions available to resume.')
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
