import { Command } from 'commander'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { startServer } from '../../server'
import { getGlobalStateManager } from '../../core/GlobalStateManager'
import { Output } from '../utils/output'
import { findCertPair } from '../../utils/certs'
import {
  LOG_FILE,
  getRunningServerPid,
  writeServerState,
  clearServerState,
} from '../utils/daemon'

export const startCommand = new Command('start')
  .description('Start the Orka web server (daemonized by default; use --foreground to attach)')
  .option('-p, --port <port>', 'Port to run the server on', '3456')
  .option('--no-open', 'Do not open browser automatically')
  .option('--cert <path>', 'Path to SSL certificate file (enables HTTPS)')
  .option('--key <path>', 'Path to SSL private key file (required with --cert)')
  .option('--http', 'Force HTTP even if SSL certs are available')
  .option('-f, --foreground', 'Run in the foreground (do not daemonize)')
  .action(async (options) => {
    try {
      const port = parseInt(options.port, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        Output.error('Invalid port number')
        process.exit(1)
      }

      const certPath: string | undefined = options.cert
      const keyPath: string | undefined = options.key
      if ((certPath && !keyPath) || (!certPath && keyPath)) {
        Output.error('Both --cert and --key must be provided together')
        process.exit(1)
      }

      // Foreground path (also used by the daemonized child to actually
      // host the server). Does the real work.
      if (options.foreground) {
        await runForeground({ port, certPath, keyPath, http: options.http, open: options.open })
        return
      }

      // Daemonize path: spawn a detached copy of ourselves with --foreground,
      // pipe its stdio to ~/.orka/orka.log, write the PID to ~/.orka/server.pid,
      // and exit cleanly.
      const existing = await getRunningServerPid()
      if (existing) {
        Output.warn(`Orka server is already running (PID ${existing})`)
        Output.info('Use "orka stop" to stop it, or "orka restart" to recycle.')
        return
      }

      await daemonize(options)
    } catch (error: any) {
      Output.error(`Failed to start server: ${error.message}`)
      process.exit(1)
    }
  })

/**
 * The real "run a server" path. Called either:
 *  - directly when the user passes `--foreground` (for debugging)
 *  - inside the detached child when daemonizing
 */
async function runForeground(opts: {
  port: number
  certPath?: string
  keyPath?: string
  http?: boolean
  open?: boolean
}) {
  let certPath = opts.certPath
  let keyPath = opts.keyPath

  if (!certPath && !keyPath && !opts.http) {
    const found = await findCertPair()
    if (found) {
      certPath = found.certPath
      keyPath = found.keyPath
      Output.info(`Auto-detected SSL cert for ${found.hostname}`)
    }
  }

  const useHttps = !!(certPath && keyPath)
  const protocol: 'http' | 'https' = useHttps ? 'https' : 'http'

  Output.info('Starting Orka server...')
  const globalState = await getGlobalStateManager()
  Output.info(`Config directory: ${globalState.getConfigDir()}`)

  await startServer({ port: opts.port, certPath, keyPath })

  // Best-effort: record our PID + bind info so `orka stop` / `orka logs`
  // / `orka status` find us. This path also runs for `--foreground`, which
  // is fine — the lifecycle commands work the same either way.
  await writeServerState(process.pid, {
    port: opts.port,
    protocol,
    startedAt: new Date().toISOString(),
  })

  if (opts.open !== false) {
    const open = await import('open')
    setTimeout(() => { open.default(`${protocol}://localhost:${opts.port}`) }, 500)
  }

  Output.success(`Server running at ${protocol}://localhost:${opts.port}`)

  const shutdown = async (sig: NodeJS.Signals) => {
    Output.info(`\nReceived ${sig}, shutting down...`)
    await clearServerState()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

/**
 * Re-exec ourselves in the background with `--foreground`, piping output to
 * the orka log file. We rebuild the CLI argv from the user's flags so the
 * child sees the same port/cert/etc. settings — except --foreground gets
 * forced on and --no-open gets forced on (no point opening a browser from
 * a detached child the user won't see).
 */
async function daemonize(options: any) {
  // Rebuild argv from the user's options (skip flags only meaningful in
  // the parent — `--open`/`--no-open` is forced off in the child).
  const childArgs: string[] = ['start', '--foreground', '--no-open']
  childArgs.push('--port', String(options.port))
  if (options.cert) childArgs.push('--cert', options.cert)
  if (options.key) childArgs.push('--key', options.key)
  if (options.http) childArgs.push('--http')

  // Open the log file in append mode so the child's stdout/stderr feed it
  // — and so the existing logger that writes to the same path is layered
  // on top instead of fighting it.
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  const logFd = fs.openSync(LOG_FILE, 'a')

  // The CLI bundle is the same file we're running from. Argv[0] is node;
  // argv[1] is the script path. Spawn node with the same script so dev
  // (`tsx`) and prod (`dist/cli.js`) both work without bespoke detection.
  const child = spawn(process.execPath, [process.argv[1], ...childArgs], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    cwd: process.cwd(),
  })

  // Close our handle to the log file — the child has its own copy via
  // the inherited fd. Without this, our process can keep the file
  // descriptor alive after we exit.
  fs.closeSync(logFd)

  // Detach: stop the parent from waiting on the child, let the child
  // outlive the parent shell.
  child.unref()

  // The child writes its own PID/info to server.pid via writeServerState
  // once startServer succeeds. Give it a moment to either start cleanly
  // or fail loudly — if it failed, the pidfile won't exist and we tell
  // the user where to look.
  await new Promise((r) => setTimeout(r, 1200))
  const livePid = await getRunningServerPid()
  if (!livePid) {
    Output.error('Server failed to start in background')
    Output.info(`Check ${LOG_FILE} for details, or run with --foreground to debug.`)
    process.exit(1)
  }

  // Resolve the URL we should point the user at. We deliberately don't
  // open the browser here — the user often runs `orka start` over SSH,
  // and a browser-on-the-server-host is rarely what they want.
  const protocol = options.http
    ? 'http'
    : (options.cert && options.key) || (await findCertPair())
      ? 'https'
      : 'http'

  Output.success(`Orka server started in background (PID ${livePid})`)
  Output.info(`  URL:  ${protocol}://localhost:${options.port}`)
  Output.info(`  Logs: orka logs   (or: tail -f ${LOG_FILE})`)
  Output.info(`  Stop: orka stop`)
}
