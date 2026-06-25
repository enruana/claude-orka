import { Command } from 'commander'
import { spawn } from 'child_process'
import fs from 'fs'
import { Output } from '../utils/output'
import { LOG_FILE, getRunningServerPid } from '../utils/daemon'

/**
 * Stream the Orka log file. By default behaves like `tail -f`: prints the
 * last 50 lines and follows new ones until Ctrl-C. `--no-follow` makes it
 * a plain `tail -n`. `--lines N` controls the back-history shown.
 */
export function logsCommand(program: Command) {
  program
    .command('logs')
    .description('Tail the Orka server log (~/.orka/orka.log)')
    .option('-n, --lines <n>', 'Number of trailing lines to show', '50')
    .option('--no-follow', 'Print the trailing lines and exit (no follow)')
    .action(async (opts) => {
      if (!fs.existsSync(LOG_FILE)) {
        Output.warn(`Log file not found: ${LOG_FILE}`)
        Output.info('Start the server first: orka start')
        return
      }

      const pid = await getRunningServerPid()
      if (!pid) {
        Output.warn('No running Orka server detected — showing historical logs only.')
      } else {
        Output.info(`Following ${LOG_FILE}  (server PID ${pid}, Ctrl-C to detach)`)
      }

      const lines = String(parseInt(opts.lines, 10) || 50)
      const tailArgs = opts.follow !== false
        ? ['-n', lines, '-F', LOG_FILE]  // -F (capital) re-opens on rotation
        : ['-n', lines, LOG_FILE]

      const tail = spawn('tail', tailArgs, { stdio: 'inherit' })

      // Forward Ctrl-C to tail so it dies cleanly.
      const onSig = () => { try { tail.kill('SIGTERM') } catch {} }
      process.on('SIGINT', onSig)
      process.on('SIGTERM', onSig)

      await new Promise<void>((resolve) => {
        tail.on('exit', (code) => {
          process.off('SIGINT', onSig)
          process.off('SIGTERM', onSig)
          // Exit with tail's code (0 normally, 130 on Ctrl-C) so shell
          // pipelines/scripts behave naturally.
          process.exit(code ?? 0)
          resolve()
        })
      })
    })
}
