import { Command } from 'commander'
import ora from 'ora'
import { ClaudeOrka } from '../../core/ClaudeOrka'
import { Output } from '../utils/output'
import { handleError, validateInitialized, validateSessionId, validateForkId } from '../utils/errors'

export function mergeCommand(program: Command) {
  const merge = program.command('merge').description('Merge and export operations')

  // Generate export
  merge
    .command('export <session-id> <fork-id>')
    .description('Generate export summary for a fork')
    .action(async (sessionId, forkId) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)
        validateForkId(forkId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        Output.info('Generating export summary...')
        Output.warn('This will send a prompt to Claude to generate a summary.')
        Output.warn('Wait for Claude to finish before running the merge command.')

        const exportPath = await orka.generateForkExport(sessionId, forkId)

        Output.success('Export prompt sent to Claude!')
        Output.info(`Export will be saved to: ${exportPath}`)
        Output.newline()
        Output.info('Next steps:')
        Output.info('  1. Wait for Claude to generate and save the summary (~15-30 seconds)')
        Output.info('  2. Run: orka merge do ' + sessionId + ' ' + forkId)
      } catch (error) {
        handleError(error)
      }
    })

  // Merge fork to main
  merge
    .command('do <session-id> <fork-id>')
    .description('Merge a fork to main (requires export first)')
    .action(async (sessionId, forkId) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)
        validateForkId(forkId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const spinner = ora('Merging fork to main...').start()

        await orka.merge(sessionId, forkId)

        spinner.succeed('Fork merged to main!')

        Output.info('The fork context has been sent to the main conversation.')
        Output.info('Claude in main now has access to the fork exploration.')
        Output.warn('Fork has been closed and marked as merged.')
      } catch (error) {
        handleError(error)
      }
    })

  // Generate export and merge (combined)
  merge
    .command('auto <session-id> <fork-id>')
    .description('Generate export and merge automatically')
    .option('-w, --wait <ms>', 'Wait time in milliseconds for Claude to complete export', '15000')
    .action(async (sessionId, forkId, options) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)
        validateSessionId(sessionId)
        validateForkId(forkId)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const waitTime = parseInt(options.wait)

        Output.info('Starting automatic export and merge...')

        const spinner = ora('Generating export summary...').start()

        await orka.generateExportAndMerge(sessionId, forkId, waitTime)

        spinner.succeed('Fork merged to main!')

        Output.info('The fork context has been sent to the main conversation.')
        Output.info('Claude in main now has access to the fork exploration.')
        Output.warn('Fork has been closed and marked as merged.')
      } catch (error) {
        handleError(error)
      }
    })
}
