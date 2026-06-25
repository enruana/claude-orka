import { Command } from 'commander'
import { Output } from '../utils/output'
import {
  getRunningServerPid,
  isProcessAlive,
  clearServerState,
} from '../utils/daemon'

export function stopCommand(program: Command) {
  program
    .command('stop')
    .description('Stop the backgrounded Orka server (if running)')
    .option('--force', 'Use SIGKILL instead of SIGTERM if the server does not exit promptly')
    .action(async (opts) => {
      const pid = await getRunningServerPid()
      if (!pid) {
        Output.warn('No running Orka server found')
        return
      }

      // SIGTERM first — gives the server a chance to clean up its ttyd
      // processes, flush logs, and clear its pidfile via the SIGTERM
      // handler installed in start.ts. If it's still alive after a few
      // seconds, fall back to SIGKILL.
      try {
        process.kill(pid, 'SIGTERM')
        Output.info(`Sent SIGTERM to PID ${pid} (waiting up to 5s for clean exit)…`)
      } catch (err: any) {
        Output.error(`Failed to signal PID ${pid}: ${err.message}`)
        await clearServerState()
        return
      }

      // Poll for exit.
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) break
        await new Promise((r) => setTimeout(r, 150))
      }

      if (isProcessAlive(pid)) {
        if (opts.force) {
          Output.warn('Server still alive after 5s — sending SIGKILL')
          try { process.kill(pid, 'SIGKILL') } catch { /* already dead */ }
        } else {
          Output.warn(
            `Server (PID ${pid}) did not exit after 5s. Re-run with --force to SIGKILL.`
          )
          return
        }
      }

      // Clean up pidfile in case the server didn't get to its own cleanup
      // (forced exit, crash before SIGTERM handler, etc.).
      await clearServerState()
      Output.success('Orka server stopped')
    })
}
