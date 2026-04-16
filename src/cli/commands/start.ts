import { Command } from 'commander'
import { startServer } from '../../server'
import { getGlobalStateManager } from '../../core/GlobalStateManager'
import { Output } from '../utils/output'
import { findCertPair } from '../../utils/certs'

export const startCommand = new Command('start')
  .description('Start the Orka web server and UI')
  .option('-p, --port <port>', 'Port to run the server on', '3456')
  .option('--no-open', 'Do not open browser automatically')
  .option('--cert <path>', 'Path to SSL certificate file (enables HTTPS)')
  .option('--key <path>', 'Path to SSL private key file (required with --cert)')
  .option('--http', 'Force HTTP even if SSL certs are available')
  .action(async (options) => {
    try {
      const port = parseInt(options.port, 10)

      if (isNaN(port) || port < 1 || port > 65535) {
        Output.error('Invalid port number')
        process.exit(1)
      }

      let certPath: string | undefined = options.cert
      let keyPath: string | undefined = options.key

      if ((certPath && !keyPath) || (!certPath && keyPath)) {
        Output.error('Both --cert and --key must be provided together')
        process.exit(1)
      }

      // Auto-detect certs in ~/.orka/certs/ if no flags provided and --http not set
      if (!certPath && !keyPath && !options.http) {
        const found = await findCertPair()
        if (found) {
          certPath = found.certPath
          keyPath = found.keyPath
          Output.info(`Auto-detected SSL cert for ${found.hostname}`)
        }
      }

      const useHttps = !!(certPath && keyPath)
      const protocol = useHttps ? 'https' : 'http'

      Output.info('Starting Orka server...')

      // Initialize global state
      const globalState = await getGlobalStateManager()
      Output.info(`Config directory: ${globalState.getConfigDir()}`)

      // Start the server
      await startServer({ port, certPath, keyPath })

      // Open browser if requested
      if (options.open !== false) {
        const open = await import('open')
        setTimeout(() => {
          open.default(`${protocol}://localhost:${port}`)
        }, 500)
      }

      Output.success(`Server running at ${protocol}://localhost:${port}`)

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
