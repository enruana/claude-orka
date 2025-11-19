# Claude-Orka 🎭

> SDK and CLI for orchestrating Claude Code sessions with tmux - Branch management for AI conversations

[![npm version](https://img.shields.io/npm/v/claude-orka.svg)](https://www.npmjs.com/package/claude-orka)
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
npm install -g claude-orka
```

## Prerequisites

- Node.js >= 18.0.0
- [tmux](https://github.com/tmux/tmux) - Terminal multiplexer
- [Claude CLI](https://claude.ai/download) - Claude Code CLI

**Verify installation:**

```bash
orka doctor
```

## Quick Start

```bash
# Initialize in your project
orka init

# Create a new session
orka session create "Implement Feature X"

# Create a fork to explore an alternative
orka fork create <session-id> "Try Alternative Approach"

# When done, merge the fork back to main
orka merge auto <session-id> <fork-id>

# Check project status
orka status
```

## Features

### 🎯 Session Management

- Create and manage multiple Claude Code sessions
- Save sessions for later (preserves Claude context)
- Resume sessions with full conversation history
- List and filter sessions by status

### 🌿 Fork & Merge Workflow

- Create conversation forks to explore alternatives
- Each fork maintains its own Claude session
- Generate summaries of fork explorations
- Merge learnings back to main conversation

### 💾 State Persistence

- All state stored in `.claude-orka/state.json`
- Automatic context preservation via Claude's native sessions
- Export summaries for fork integrations

### 🎨 Beautiful CLI

- Colored output with chalk
- Interactive tables with cli-table3
- Progress spinners with ora
- JSON output for scripting

## Commands

### Project

```bash
orka init              # Initialize Claude-Orka in current project
orka doctor            # Check system dependencies
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
import { ClaudeOrka } from 'claude-orka'

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

MIT © [Your Name]

## Links

- [GitHub Repository](https://github.com/yourusername/claude-orka)
- [Issue Tracker](https://github.com/yourusername/claude-orka/issues)
- [Claude Code](https://claude.ai/code)

---

Made with ❤️ for the Claude Code community
