# Claude-Orka 🎭

> SDK and CLI for orchestrating Claude Code sessions with tmux - Branch management for AI conversations

[![npm version](https://img.shields.io/npm/v/@enruana/claude-orka.svg)](https://www.npmjs.com/package/@enruana/claude-orka)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What is Claude-Orka?

Claude-Orka is a powerful SDK and CLI tool that enables you to:

- 🎯 **Orchestrate multiple Claude Code sessions** using tmux
- 🌿 **Create conversation forks** to explore different approaches
- 🔀 **Merge forks back to main** with context preservation
- 💾 **Save and resume sessions** with full context
- 📊 **Manage session state** across your projects

Perfect for complex development workflows where you need to explore multiple solutions in parallel!

## Installation

```bash
npm install -g @enruana/claude-orka
```

## Prerequisites

- Node.js >= 18.0.0
- [tmux](https://github.com/tmux/tmux) - Terminal multiplexer
- [Claude CLI](https://claude.ai/download) - Claude Code CLI

**Quick setup (automatic):**

```bash
# Install dependencies automatically
orka prepare

# Verify installation
orka doctor
```

**Manual setup:**
- macOS: `brew install tmux`
- Ubuntu: `sudo apt-get install tmux`
- Claude CLI: Download from [claude.ai](https://claude.ai/download)

## Quick Start

```bash
# 1. Install dependencies (if needed)
orka prepare

# 2. Initialize in your project
orka init

# 3. Create a new session
orka session create "Implement Feature X"

# 4. Create a fork to explore an alternative
orka fork create <session-id> "Try Alternative Approach"

# 5. When done, merge the fork back to main
orka merge auto <session-id> <fork-id>

# 6. Check project status
orka status
```

## Features

### 🎯 Session Management

- Create and manage multiple Claude Code sessions
- Save sessions for later (preserves Claude context)
- Resume sessions with full conversation history
- **Automatic recovery** - Resume sessions even after system restarts
- List and filter sessions by status

### 🌿 Fork & Merge Workflow

- Create conversation forks to explore alternatives
- Each fork maintains its own Claude session
- Generate summaries of fork explorations
- Merge learnings back to main conversation
- **Validation** - Merge button disabled until fork is exported

### 💾 State Persistence

- All state stored in `.claude-orka/state.json`
- Automatic context preservation via Claude's native sessions
- Export summaries for fork integrations
- **Smart recovery** - Detects missing tmux sessions and recreates them

### 🎨 Beautiful CLI & UI

- **Electron UI** - Visual session tree with fork hierarchy
- Colored output with chalk
- Interactive tables with cli-table3
- Progress spinners with ora
- JSON output for scripting

### 🖥️ Electron UI

- **Visual session tree** showing fork hierarchy
- **Interactive nodes** - Click to select, view fork info
- **Quick actions** - Code, Terminal, Save & Close buttons
- **Real-time updates** - Automatically refreshes on state changes
- **Fork management** - Create, export, merge, and close forks visually

## What's New in v0.4.x

### v0.4.2 (Latest)
- 🐛 **Fixed**: `orka prepare` command now works correctly (readline import fix)
- ✅ **Improved**: Dependency installation more reliable

### v0.4.1
- 🔄 **Session Recovery**: Automatically recovers sessions after system restarts
- 💪 **Resilient**: Detects missing tmux sessions and recreates them with Claude context
- 🔍 **Smart Detection**: Checks tmux session existence before attempting reconnection

### v0.4.0
- 🎨 **Electron UI**: Visual session tree with interactive fork management
- 💾 **Save & Close**: Properly detaches from tmux (sessions stay alive for resume)
- 🔒 **Merge Validation**: Merge button disabled until fork is exported
- 🖥️ **UI Improvements**: Code and Terminal quick action buttons
- 🚫 **No DevTools**: Cleaner UI without automatic developer tools

## Commands

### Setup

```bash
orka prepare           # Install system dependencies (tmux, etc.)
orka doctor            # Check system dependencies
orka init              # Initialize Claude-Orka in current project
```

### Project

```bash
orka status            # Show project status
```

### Sessions

```bash
orka session create [name]         # Create new session
orka session list                  # List all sessions
orka session get <id>              # Get session details
orka session resume <id>           # Resume saved session
orka session close <id>            # Close session (save for later)
orka session delete <id>           # Permanently delete session
```

### Forks

```bash
orka fork create <session-id> [name]       # Create fork
orka fork list <session-id>                # List forks
orka fork resume <session-id> <fork-id>    # Resume fork
orka fork close <session-id> <fork-id>     # Close fork
orka fork delete <session-id> <fork-id>    # Delete fork
```

### Merge

```bash
orka merge export <session-id> <fork-id>   # Generate export
orka merge do <session-id> <fork-id>       # Merge to main
orka merge auto <session-id> <fork-id>     # Export + merge (recommended)
```

## Example Workflow

```bash
# 1. Start a new session for your feature
orka session create "OAuth Implementation"
# → Session ID: abc123...

# 2. Work on the main approach...
# (Claude Code opens in tmux)

# 3. Create a fork to try JWT tokens
orka fork create abc123 "Try JWT Tokens"
# → Fork ID: def456...

# 4. Work on the fork...
# (Fork opens in new tmux pane)

# 5. Merge the successful approach back
orka merge auto abc123 def456

# 6. Check final state
orka status
```

## SDK Usage

You can also use Claude-Orka programmatically:

```typescript
import { ClaudeOrka } from '@enruana/claude-orka'

const orka = new ClaudeOrka('/path/to/project')
await orka.initialize()

// Create session
const session = await orka.createSession('My Feature')

// Create fork
const fork = await orka.createFork(session.id, 'Alternative')

// Generate export and merge
await orka.generateExportAndMerge(session.id, fork.id)

// Get project summary
const summary = await orka.getProjectSummary()
```

## Architecture

```
.claude-orka/
├── state.json          # Project state
└── exports/            # Fork summaries (created on-demand)
    └── fork-*.md       # Generated summaries
```

**Key Concepts:**

- **Session**: A Claude Code conversation with main + forks
- **Main**: The primary conversation branch
- **Fork**: A branched conversation to explore alternatives
- **Export**: A summary of a fork's exploration
- **Merge**: Integrate fork learnings into main

## Configuration

Claude-Orka uses native Claude CLI sessions, so no additional configuration is needed. Session IDs are automatically detected from `~/.claude/history.jsonl`.

## Troubleshooting

```bash
# Check if everything is set up correctly
orka doctor

# Common issues:
# - tmux not installed → brew install tmux
# - Claude CLI not found → Install from claude.ai
# - Project not initialized → orka init
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © enruana

## Links

- [GitHub Repository](https://github.com/enruana/claude-orka)
- [Issue Tracker](https://github.com/enruana/claude-orka/issues)
- [npm Package](https://www.npmjs.com/package/@enruana/claude-orka)
- [Claude Code](https://claude.ai/code)

---

Made with ❤️ for the Claude Code community
