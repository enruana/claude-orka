import { Command } from 'commander'
import { spawn } from 'child_process'
import { Output } from '../utils/output'
import {
  getRunningServerPid,
  isProcessAlive,
  clearServerState,
  readServerInfo,
} from '../utils/daemon'

/**
 * Stop the running server (if any) and start a new one. Forwards any
 * port/cert/http flags to the new `orka start` invocation; if none are
 * given we reuse the previous server.json so the user doesn't have to
 * retype them.
 */
export function restartCommand(program: Command) {
  program
    .command('restart')
    .description('Stop the running Orka server and start a fresh one')
    .option('-p, --port <port>', 'Port to bind to (defaults to previous run)')
    .option('--cert <path>', 'Path to SSL cert (defaults to previous run)')
    .option('--key <path>', 'Path to SSL key (defaults to previous run)')
    .option('--http', 'Force HTTP even if SSL certs are available')
    .option('--no-open', 'Do not open browser automatically')
    .action(async (opts) => {
      const prev = await readServerInfo()
      const pid = await getRunningServerPid()

      if (pid) {
        Output.info(`Stopping current server (PID ${pid})…`)
        try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
        // Wait up to 5s for clean exit, then SIGKILL.
        const deadline = Date.now() + 5000
        while (Date.now() < deadline && isProcessAlive(pid)) {
          await new Promise((r) => setTimeout(r, 150))
        }
        if (isProcessAlive(pid)) {
          Output.warn('Clean shutdown timed out — forcing SIGKILL')
          try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
        }
        await clearServerState()
      } else {
        Output.info('No server running — starting a fresh one')
      }

      // Rebuild argv for the new `orka start`. Re-use previous port if
      // the user didn't pass one; otherwise the explicit flag wins.
      const args: string[] = ['start']
      if (opts.open === false) args.push('--no-open')
      const port = opts.port || prev?.port
      if (port) args.push('--port', String(port))
      if (opts.cert) args.push('--cert', opts.cert)
      if (opts.key) args.push('--key', opts.key)
      if (opts.http) args.push('--http')

      // Re-exec the orka binary. We can't `await import('./start')` and
      // run it inline — start's daemonize path would race with the
      // pidfile we just removed. A fresh process keeps everything tidy.
      const child = spawn(process.execPath, [process.argv[1], ...args], {
        stdio: 'inherit',
        env: { ...process.env },
        cwd: process.cwd(),
      })
      // Wait for the new `orka start` to finish (it daemonizes itself
      // and exits within ~1–2s).
      await new Promise((resolve) => child.on('exit', resolve))
    })
}
