import { Command } from 'commander'
import ora from 'ora'
import { ClaudeOrka } from '../../core/ClaudeOrka'
import { Output } from '../utils/output'
import { handleError, validateInitialized, validateSessionId } from '../utils/errors'

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
    .command('resume <session-id>')
    .description('Resume a saved session')
    .option('--no-terminal', 'Do not open terminal window')
    .action(async (sessionId, options) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

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
