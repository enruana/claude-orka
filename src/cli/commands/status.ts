import { Command } from 'commander'
import { ClaudeOrka } from '../../core/ClaudeOrka'
import { Output } from '../utils/output'
import { handleError, validateInitialized } from '../utils/errors'

export function statusCommand(program: Command) {
  program
    .command('status')
    .description('Show project status and all sessions')
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => {
      try {
        const projectPath = process.cwd()
        validateInitialized(projectPath)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        const summary = await orka.getProjectSummary()

        if (options.json) {
          Output.json(summary)
        } else {
          Output.projectSummary(summary)
        }
      } catch (error) {
        handleError(error)
      }
    })
}
