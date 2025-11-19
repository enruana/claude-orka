#!/usr/bin/env node

import { Command } from 'commander'
import { initCommand } from './commands/init'
import { statusCommand } from './commands/status'
import { sessionCommand } from './commands/session'
import { forkCommand } from './commands/fork'
import { mergeCommand } from './commands/merge'

const program = new Command()

program
  .name('orka')
  .description('Claude-Orka: Orchestrate Claude Code sessions with tmux')
  .version('1.0.0')

// Register commands
initCommand(program)
statusCommand(program)
sessionCommand(program)
forkCommand(program)
mergeCommand(program)

// Parse arguments
program.parse()
