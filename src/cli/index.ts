#!/usr/bin/env node

import { Command } from 'commander'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { initCommand } from './commands/init'
import { statusCommand } from './commands/status'
import { sessionCommand } from './commands/session'
import { forkCommand } from './commands/fork'
import { mergeCommand } from './commands/merge'
import { doctorCommand } from './commands/doctor'
import { prepareCommand } from './commands/prepare'
import { startCommand } from './commands/start'
import { stopCommand } from './commands/stop'
import { restartCommand } from './commands/restart'
import { logsCommand } from './commands/logs'
import { telegramCommand } from './commands/telegram'
import { gitAccountCommand } from './commands/git-account'
import { awsAccountCommand } from './commands/aws-account'
import { kbCommand } from './commands/kb'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Read version from package.json
// In development (src/cli/index.ts): ../../package.json
// When bundled (dist/cli.js): ../package.json
let packageJsonPath = join(__dirname, '../package.json')
// Try the production path first, fallback to development path
try {
  readFileSync(packageJsonPath, 'utf-8')
} catch {
  packageJsonPath = join(__dirname, '../../package.json')
}
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
const version = packageJson.version

const program = new Command()

program
  .name('orka')
  .description('Claude-Orka: Orchestrate Claude Code sessions with tmux')
  .version(version)

// Register commands
program.addCommand(startCommand)
stopCommand(program)
restartCommand(program)
logsCommand(program)
prepareCommand(program)
initCommand(program)
doctorCommand(program)
statusCommand(program)
sessionCommand(program)
forkCommand(program)
mergeCommand(program)
telegramCommand(program)
gitAccountCommand(program)
awsAccountCommand(program)
kbCommand(program)

// Parse arguments
program.parseAsync().then(() => {
  // Exit cleanly after short-lived commands complete. The two paths that
  // own their own event loop are:
  //  - `orka start --foreground`  (the server)
  //  - `orka logs` (tail -F in inherit mode keeps stdin alive until the
  //    user hits Ctrl-C; we let it call process.exit itself with tail's code)
  // Default `orka start` (daemonized) returns within ~1.5s and should
  // exit normally here too.
  const command = process.argv[2]
  const isForegroundStart = command === 'start' && process.argv.includes('--foreground')
  if (!isForegroundStart && command !== 'logs') {
    process.exit(0)
  }
})
