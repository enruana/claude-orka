# Claude-Orka

> SDK, CLI, and Web UI for orchestrating Claude Code sessions with tmux

[![npm version](https://img.shields.io/npm/v/@enruana/claude-orka.svg)](https://www.npmjs.com/package/@enruana/claude-orka)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What is Claude-Orka?

Claude-Orka is a powerful SDK, CLI, and Web UI that enables you to:

- **Orchestrate multiple Claude Code sessions** using tmux
- **Create conversation forks** to explore different approaches in parallel
- **Merge forks back to main** with context preservation
- **Web-based dashboard** accessible from any device (desktop, tablet, phone)
- **Autonomous agent system** with Claude Code hooks, LLM-based decisions, and Telegram notifications
- **Integrated code editor** with Monaco (VS Code engine) and Git support
- **Voice input** for hands-free interaction with agents
- **Mobile-friendly terminal** with virtual keyboard

## Installation

```bash
npm install -g @enruana/claude-orka
```

## Prerequisites

### Required

- **Node.js** >= 18.0.0
- **tmux** - Terminal multiplexer
- **Claude CLI** - Claude Code CLI ([download](https://claude.ai/download))

### Optional

- **ttyd** - Web-based terminal (for embedded terminal in the UI)
- **ffmpeg** - Audio processing (for voice input)
- **whisper** - Speech-to-text (for voice input)
- **puppeteer** - Headless browser (for terminal screenshots in agents)

## Quick Start

```bash
# 1. Install system dependencies automatically
orka prepare

# 2. Verify everything is set up
orka doctor

# 3. Initialize Claude-Orka in your project
cd /path/to/your/project
orka init

# 4. Start the web server
orka start
# → Opens Web UI at http://localhost:3456
```

---

## Features

### Web Interface

- **Project Dashboard** - Manage multiple projects from one place
- **Session View** - Create, resume, close sessions with embedded terminal
- **Fork Tree** - Visual hierarchy of conversation branches
- **Code Editor** - Monaco editor with syntax highlighting for 30+ languages
- **Git Panel** - Stage, unstage, commit, view diffs, AI-generated commit messages
- **File Browser** - Finder-style file explorer with list and grid views
- **Agent Canvas** - Visual canvas for configuring autonomous agents
- **Voice Input** - Record and transcribe voice commands for agents
- **Mobile Support** - Responsive design with virtual keyboard for terminal

### Agent System

- **Claude Code Hooks** - React to 14 hook event types (Stop, SessionStart, PreCompact, Permission, etc.)
- **LLM-based decisions** - Autonomous agent uses Claude to decide actions on ambiguous terminal states
- **Terminal monitoring** - Watchdog polls terminal every ~30s to detect stalled sessions
- **Telegram bot** - Bidirectional communication: receive notifications, send commands via `/tell`, free-text queries
- **Event state machine** - Deterministic fast-path for known events, LLM fallback for ambiguous ones
- **Terminal screenshots** - Headless browser captures for visual context in LLM decisions

---

## CLI Reference

### `orka start`

Start the Orka web server and UI.

```bash
orka start [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <port>` | Port to run the server on | `3456` |
| `--no-open` | Don't open browser automatically | |

---

### `orka prepare`

Install and configure system dependencies automatically.

```bash
orka prepare [options]
```

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompts |

---

### `orka init`

Initialize Claude-Orka in the current project directory.

```bash
orka init
```

---

### `orka doctor`

Check system dependencies and configuration.

```bash
orka doctor
```

---

### `orka status`

Show project status and all sessions.

```bash
orka status [options]
```

| Option | Description |
|--------|-------------|
| `-j, --json` | Output as JSON |

---

### `orka session`

Manage Claude Code sessions.

#### `orka session create [name]`

```bash
orka session create [name] [options]
```

| Option | Description |
|--------|-------------|
| `--no-terminal` | Don't open terminal window |
| `-c, --continue` | Continue from an existing Claude session (interactive selector) |
| `--from <session-id>` | Continue from a specific Claude session ID |

#### `orka session list`

```bash
orka session list [options]
```

| Option | Description |
|--------|-------------|
| `-s, --status <status>` | Filter by status (`active`, `saved`) |
| `-j, --json` | Output as JSON |

#### `orka session get <session-id>`

```bash
orka session get <session-id> [options]
```

| Option | Description |
|--------|-------------|
| `-j, --json` | Output as JSON |

#### `orka session resume [session-id]`

Resume a saved session. Shows interactive selector if no ID provided.

```bash
orka session resume [session-id] [options]
```

| Option | Description |
|--------|-------------|
| `--no-terminal` | Don't open terminal window |

#### `orka session close <session-id>`

Close and save a session for later.

```bash
orka session close <session-id>
```

#### `orka session delete <session-id>`

Permanently delete a session.

```bash
orka session delete <session-id>
```

---

### `orka fork`

Manage conversation forks.

#### `orka fork create <session-id> [name]`

```bash
orka fork create <session-id> [name] [options]
```

| Option | Description |
|--------|-------------|
| `-v, --vertical` | Split pane vertically instead of horizontally |

#### `orka fork list <session-id>`

```bash
orka fork list <session-id> [options]
```

| Option | Description |
|--------|-------------|
| `-s, --status <status>` | Filter by status (`active`, `saved`, `merged`) |
| `-j, --json` | Output as JSON |

#### `orka fork resume <session-id> <fork-id>`

```bash
orka fork resume <session-id> <fork-id>
```

#### `orka fork close <session-id> <fork-id>`

```bash
orka fork close <session-id> <fork-id>
```

#### `orka fork delete <session-id> <fork-id>`

```bash
orka fork delete <session-id> <fork-id>
```

---

### `orka merge`

Export and merge fork operations.

#### `orka merge export <session-id> <fork-id>`

Generate an export summary for a fork.

```bash
orka merge export <session-id> <fork-id>
```

#### `orka merge do <session-id> <fork-id>`

Merge a fork to main (requires export first).

```bash
orka merge do <session-id> <fork-id>
```

#### `orka merge auto <session-id> <fork-id>`

Generate export and merge automatically (recommended).

```bash
orka merge auto <session-id> <fork-id> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-w, --wait <ms>` | Wait time for Claude to complete export | `15000` |

---

### `orka telegram`

Telegram bot utilities.

#### `orka telegram test`

Send a test message to verify bot configuration.

```bash
orka telegram test -t <token> -c <chat-id>
```

| Option | Description |
|--------|-------------|
| `-t, --token <token>` | Bot token (required) |
| `-c, --chat-id <chatId>` | Chat ID (required) |

#### `orka telegram chat-id`

Detect your chat ID from recent messages sent to the bot.

```bash
orka telegram chat-id -t <token>
```

| Option | Description |
|--------|-------------|
| `-t, --token <token>` | Bot token (required) |

---

## SDK API Reference

### Installation

```typescript
import { ClaudeOrka } from '@enruana/claude-orka'
```

### Basic Usage

```typescript
const orka = new ClaudeOrka('/path/to/project')
await orka.initialize()

// Create session
const session = await orka.createSession('Feature Implementation')

// Create fork
const fork = await orka.createFork(session.id, 'Alternative Approach')

// Work on fork... then merge
await orka.generateExportAndMerge(session.id, fork.id)
```

### Main Methods

| Method | Description |
|--------|-------------|
| `initialize()` | Initialize ClaudeOrka |
| `createSession(name)` | Create new session |
| `resumeSession(id)` | Resume saved session |
| `closeSession(id)` | Close session |
| `deleteSession(id)` | Delete session |
| `createFork(sessionId, name)` | Create fork |
| `closeFork(sessionId, forkId)` | Close fork |
| `generateExportAndMerge(sessionId, forkId)` | Export and merge fork |

---

## Architecture

### Directory Structure

```
.claude-orka/
├── state.json              # Project state (sessions, forks)
└── exports/                # Fork export summaries
    └── fork-{id}.md        # Export for each fork

~/.orka/
└── config.json             # Global config (projects, ports)

~/.claude-orka/
└── agents.json             # Agent configurations
```

### Key Concepts

**Session** - A Claude Code conversation with main branch + forks, running in tmux.

**Fork** - A branched conversation that can be merged back to its parent.

**Export** - Summary of a fork's exploration, generated by Claude.

**Merge** - Integrates fork learnings into parent conversation.

**Agent** - Autonomous daemon that monitors a Claude Code session via hooks and terminal polling, making LLM-based decisions and communicating via Telegram.

### System Ports

| Port | Service |
|------|---------|
| 3456 | Web server (configurable with `--port`) |
| 9999 | Hook server (receives Claude Code hook events) |
| 4444+ | ttyd instances (web terminal) |

---

## Troubleshooting

### tmux not found

```bash
# macOS
brew install tmux

# Ubuntu
sudo apt-get install tmux

# Or use
orka prepare
```

### Claude CLI not found

Download from [claude.ai/download](https://claude.ai/download)

### Session recovery fails

```bash
# Check system status
orka doctor

# Force resume
orka session resume <session-id>
```

### Web UI won't start

```bash
# Check if port is in use
lsof -i :3456

# Try different port
orka start --port 8080
```

### Agent not receiving hooks

```bash
# Check hook server is running
lsof -i :9999

# Verify agent is started in the Agent Canvas
# Check agent logs in the Web UI
```

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

## License

MIT © enruana

---

## Links

- [GitHub Repository](https://github.com/enruana/claude-orka)
- [Issue Tracker](https://github.com/enruana/claude-orka/issues)
- [npm Package](https://www.npmjs.com/package/@enruana/claude-orka)
- [Claude Code](https://claude.ai/code)
