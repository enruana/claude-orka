import { Command } from 'commander'
import ora from 'ora'
import { ClaudeOrka } from '../../core/ClaudeOrka'
import { Output } from '../utils/output'
import { handleError, validateInitialized, validateSessionId, validateForkId } from '../utils/errors'

export function forkCommand(program: Command) {
  const fork = program.command('fork').description('Manage conversation forks')

  // Create fork
  fork
    .command('create <session-id> [name]')
    .description('Create a new fork in a session')
    .option('-v, --vertical', 'Split vertically instead of horizontally')
    .action(async (sessionId, name, options) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const spinner = ora('Creating fork...').start()
        spinner.text = 'Creating fork and detecting session ID...'

        const newFork = await orka.createFork(sessionId, name, options.vertical)

        spinner.succeed('Fork created!')

        Output.fork(newFork)
        Output.newline()
        Output.info('Fork created in a new tmux pane.')
        Output.info('You can now explore an alternative approach in this fork.')
        Output.newline()
        Output.info(`To merge this fork: orka merge ${sessionId} ${newFork.id}`)
      } catch (error) {
        handleError(error)
      }
    })

  // List forks
  fork
    .command('list <session-id>')
    .description('List all forks in a session')
    .option('-s, --status <status>', 'Filter by status (active, saved, merged)')
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

        let forks = session.forks || []

        if (options.status) {
          forks = forks.filter((f) => f.status === options.status)
        }

        if (options.json) {
          Output.json(forks)
        } else {
          Output.header(`🌿 Forks in ${session.name}`)
          Output.forksTable(forks)
        }
      } catch (error) {
        handleError(error)
      }
    })

  // Resume fork
  fork
    .command('resume <session-id> <fork-id>')
    .description('Resume a saved fork')
    .action(async (sessionId, forkId) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)
        validateForkId(forkId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const spinner = ora('Resuming fork...').start()

        const resumedFork = await orka.resumeFork(sessionId, forkId)

        spinner.succeed('Fork resumed!')

        Output.fork(resumedFork)
        Output.newline()
        Output.info('Fork has been restored in a new tmux pane.')
        Output.info('Claude will remember the context of this conversation.')
      } catch (error) {
        handleError(error)
      }
    })

  // Close fork
  fork
    .command('close <session-id> <fork-id>')
    .description('Close a fork (saves it for later)')
    .action(async (sessionId, forkId) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)
        validateForkId(forkId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const spinner = ora('Closing fork...').start()

        await orka.closeFork(sessionId, forkId)

        spinner.succeed('Fork closed!')

        Output.info('Fork has been saved. You can resume it later with:')
        Output.info(`  orka fork resume ${sessionId} ${forkId}`)
      } catch (error) {
        handleError(error)
      }
    })

  // Delete fork
  fork
    .command('delete <session-id> <fork-id>')
    .description('Permanently delete a fork')
    .action(async (sessionId, forkId) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)
        validateForkId(forkId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const spinner = ora('Deleting fork...').start()

        await orka.deleteFork(sessionId, forkId)

        spinner.succeed('Fork deleted!')

        Output.warn('Fork has been permanently deleted.')
      } catch (error) {
        handleError(error)
      }
    })
}
