import { Command } from 'commander'
import { startServer } from '../../server'
import { getGlobalStateManager } from '../../core/GlobalStateManager'
import { Output } from '../utils/output'

export const startCommand = new Command('start')
  .description('Start the Orka web server and UI')
  .option('-p, --port <port>', 'Port to run the server on', '3000')
  .option('--no-open', 'Do not open browser automatically')
  .action(async (options) => {
    try {
      const port = parseInt(options.port, 10)

      if (isNaN(port) || port < 1 || port > 65535) {
        Output.error('Invalid port number')
        process.exit(1)
      }

      Output.info('Starting Orka server...')

      // Initialize global state
      const globalState = await getGlobalStateManager()
      Output.info(`Config directory: ${globalState.getConfigDir()}`)

      // Start the server
      await startServer({ port })

      // Open browser if requested
      if (options.open !== false) {
        const open = await import('open')
        setTimeout(() => {
          open.default(`http://localhost:${port}`)
        }, 500)
      }

      Output.success(`Server running at http://localhost:${port}`)

      // Keep the process running
      process.on('SIGINT', () => {
        Output.info('\nShutting down server...')
        process.exit(0)
      })

      process.on('SIGTERM', () => {
        Output.info('\nShutting down server...')
        process.exit(0)
      })

    } catch (error: any) {
      Output.error(`Failed to start server: ${error.message}`)
      process.exit(1)
    }
  })
