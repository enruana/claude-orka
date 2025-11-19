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
prepareCommand(program)
initCommand(program)
doctorCommand(program)
statusCommand(program)
sessionCommand(program)
forkCommand(program)
mergeCommand(program)

// Parse arguments
program.parse()
