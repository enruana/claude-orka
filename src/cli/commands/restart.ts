import { Command } from 'commander'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs-extra'
import execa from 'execa'
import { fileURLToPath } from 'url'
import { Output } from '../utils/output'
import {
  getRunningServerPid,
  isProcessAlive,
  clearServerState,
  readServerInfo,
} from '../utils/daemon'

/**
 * Locate the Orka repo root when Orka is running as a linked source
 * install (`npm link`). Only returns a path if the parent of `dist/`
 * has a package.json declaring `@enruana/claude-orka` — otherwise this is
 * a real global install and rebuilding from source doesn't make sense.
 */
function findRepoRoot(): string | null {
  try {
    const __filename = fileURLToPath(import.meta.url)
    // Walk up from the current file toward a package.json we own.
    let dir = path.dirname(__filename)
    for (let i = 0; i < 6; i++) {
      const pkgPath = path.join(dir, 'package.json')
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
          if (pkg.name === '@enruana/claude-orka' && pkg.scripts?.build) {
            return dir
          }
        } catch { /* fall through */ }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* no import.meta.url in some paths */ }
  return null
}

/**
 * Run `npm run build` in the Orka repo. Used by `orka build` and by
 * `orka restart --build`. Streams stdout/stderr so the user sees progress.
 */
export async function runBuild(repoRoot: string): Promise<void> {
  Output.info(`Building Orka from ${repoRoot}…`)
  await execa('npm', ['run', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  Output.success('Build complete')
}

/**
 * Stop the running server (if any) and start a new one. Forwards any
 * port/cert/http flags to the new `orka start` invocation; if none are
 * given we reuse the previous server.json so the user doesn't have to
 * retype them.
 *
 * With `--build`, runs `npm run build` in the linked repo BEFORE stopping
 * the old server — that way if the build fails, the current server stays
 * up untouched.
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
    .option('-b, --build', 'Run `npm run build` before restarting (linked-source installs only)')
    .action(async (opts) => {
      // Optional rebuild step — must complete before we touch the running
      // server so a broken build doesn't take Orka down.
      if (opts.build) {
        const repo = findRepoRoot()
        if (!repo) {
          Output.error('`--build` requires a linked-source install. This looks like a published npm install.')
          process.exitCode = 1
          return
        }
        try {
          await runBuild(repo)
        } catch (err: any) {
          Output.error(`Build failed: ${err?.shortMessage || err?.message || err}`)
          Output.info('Server was NOT restarted — fix the build and try again.')
          process.exitCode = 1
          return
        }
      }

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

  // Standalone `orka build` — runs the same npm build without touching
  // the server. Useful when you want to type-check a change locally
  // without disturbing anything already running.
  program
    .command('build')
    .description('Rebuild Orka from source (linked-source installs only)')
    .action(async () => {
      const repo = findRepoRoot()
      if (!repo) {
        Output.error('`orka build` requires a linked-source install. This looks like a published npm install.')
        process.exitCode = 1
        return
      }
      try {
        await runBuild(repo)
      } catch (err: any) {
        Output.error(`Build failed: ${err?.shortMessage || err?.message || err}`)
        process.exitCode = 1
      }
    })
}
