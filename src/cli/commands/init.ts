import { Command } from 'commander'
import { ClaudeOrka } from '../../core/ClaudeOrka'
import { Output } from '../utils/output'
import { handleError } from '../utils/errors'

export function initCommand(program: Command) {
  program
    .command('init')
    .description('Initialize Claude-Orka in the current project')
    .action(async () => {
      try {
        const projectPath = process.cwd()

        Output.info(`Initializing Claude-Orka in: ${projectPath}`)

        const orka = new ClaudeOrka(projectPath)
        await orka.initialize()

        Output.success('Claude-Orka initialized successfully!')
        Output.info('You can now create sessions with: orka session create')
      } catch (error) {
        handleError(error)
      }
    })
}
