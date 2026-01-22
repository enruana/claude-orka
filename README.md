# Claude-Orka

> SDK, CLI and Web UI for orchestrating Claude Code sessions with tmux - Branch management for AI conversations

[![npm version](https://img.shields.io/npm/v/@enruana/claude-orka.svg)](https://www.npmjs.com/package/@enruana/claude-orka)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What is Claude-Orka?

Claude-Orka is a powerful SDK, CLI, and Web UI tool that enables you to:

- **Orchestrate multiple Claude Code sessions** using tmux
- **Create conversation forks** to explore different approaches in parallel
- **Merge forks back to main** with context preservation
- **Save and resume sessions** with full conversation history
- **Web-based interface** accessible from any device (desktop, tablet, phone)
- **Integrated code editor** with Monaco (VS Code editor) and Git support
- **Mobile-friendly terminal** with virtual keyboard
- **Automatic recovery** from system restarts and crashes

Perfect for complex development workflows where you need to explore multiple solutions in parallel!

## Installation

```bash
npm install -g @enruana/claude-orka
```

## Prerequisites

- **Node.js** >= 18.0.0
- **tmux** - Terminal multiplexer
- **Claude CLI** - Claude Code CLI

### Quick Setup

```bash
# Install all dependencies automatically
orka prepare

# Verify installation
orka doctor
```

### Manual Setup

**macOS:**
```bash
brew install tmux
```

**Ubuntu/Debian:**
```bash
sudo apt-get install tmux
```

**Claude CLI:**
Download from [claude.ai/download](https://claude.ai/download)

## Quick Start

```bash
# 1. Install dependencies
orka prepare

# 2. Start the web server
orka server
# → Opens Web UI at http://localhost:3456

# 3. Register a project in the Web UI or via CLI
orka project add /path/to/your/project

# 4. Create sessions and forks from the Web UI
# → Full terminal access from browser
# → Code editor with syntax highlighting
# → Git integration (stage, commit, view diffs)
```

---

## Features

### Web Interface

- **Project Dashboard** - Manage multiple projects from one place
- **Session Management** - Create, resume, close sessions visually
- **Thread/Fork Tree** - Visual hierarchy of conversation branches
- **Embedded Terminal** - Full terminal access via ttyd (works on mobile too)
- **Code Editor** - Monaco editor with syntax highlighting for 30+ languages
- **Git Panel** - Stage, unstage, commit, view diffs, AI-generated commit messages
- **Mobile Support** - Responsive design, virtual keyboard for terminal
- **Real-time Updates** - Auto-refresh when state changes

### Session Management

- Create and manage multiple Claude Code sessions
- Save sessions for later (preserves Claude context)
- Resume sessions with full conversation history
- **Automatic recovery** - Resume sessions even after system restarts
- List and filter sessions by status

### Fork & Merge Workflow

- Create conversation forks to explore alternatives
- Each fork maintains its own Claude session
- Generate summaries of fork explorations
- Merge learnings back to main conversation
- Track parent-child relationships in fork hierarchy

### State Persistence

- All state stored in `.claude-orka/state.json`
- Automatic context preservation via Claude's native sessions
- Export summaries for fork integrations

### Custom tmux Theme

- **Automatic branding** - Claude-Orka sessions get a custom orange theme
- **Enhanced status bar** - Shows session name, project path, and current time
- **Visual hierarchy** - Distinct colors for active/inactive panes

---

## CLI Reference

### Server Command

#### `orka server`

Start the web server for the UI.

```bash
orka server [options]
```

**Options:**
- `-p, --port <port>` - Port number (default: 3456)
- `--no-open` - Don't open browser automatically

**Example:**
```bash
# Start on default port
orka server

# Start on custom port
orka server --port 8080
```

---

### Setup Commands

#### `orka prepare`

Install and configure system dependencies automatically.

```bash
orka prepare [options]
```

**Options:**
- `-y, --yes` - Skip confirmation prompts

---

#### `orka doctor`

Check system dependencies and configuration.

```bash
orka doctor
```

---

#### `orka init`

Initialize Claude-Orka in the current project.

```bash
orka init
```

---

### Project Commands

#### `orka project add`

Register a project with Claude-Orka.

```bash
orka project add <path>
```

#### `orka project list`

List all registered projects.

```bash
orka project list
```

#### `orka project remove`

Remove a project from Claude-Orka.

```bash
orka project remove <path>
```

---

### Session Commands

#### `orka session create`

Create a new Claude Code session.

```bash
orka session create [name] [options]
```

**Options:**
- `--project <path>` - Project path
- `--no-terminal` - Don't open terminal window

---

#### `orka session list`

List all sessions in a project.

```bash
orka session list [options]
```

**Options:**
- `--project <path>` - Project path
- `--status <status>` - Filter by status (active, saved)
- `--json` - Output in JSON format

---

#### `orka session resume`

Resume a saved session.

```bash
orka session resume <session-id> [options]
```

---

#### `orka session close`

Close and save a session.

```bash
orka session close <session-id>
```

---

#### `orka session delete`

Permanently delete a session.

```bash
orka session delete <session-id>
```

---

### Fork Commands

#### `orka fork create`

Create a fork from main or another fork.

```bash
orka fork create <session-id> [name] [options]
```

**Options:**
- `--parent <parent-id>` - Parent fork ID (default: "main")
- `--vertical` - Split pane vertically

---

#### `orka fork list`

List all forks in a session.

```bash
orka fork list <session-id>
```

---

#### `orka fork close`

Close a fork without merging.

```bash
orka fork close <session-id> <fork-id>
```

---

### Merge Commands

#### `orka merge auto`

Export and merge a fork (recommended).

```bash
orka merge auto <session-id> <fork-id> [options]
```

**Options:**
- `--wait <ms>` - Wait time for export (default: 15000ms)

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
| `createFork(sessionId, name, parentId)` | Create fork |
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
```

### Key Concepts

**Session:** A Claude Code conversation with main branch + forks, running in tmux.

**Fork:** A branched conversation that can be merged back to its parent.

**Export:** Summary of a fork's exploration, generated by Claude.

**Merge:** Integrates fork learnings into parent conversation.

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
orka server --port 8080
```

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

**Areas for contribution:**
- Windows support
- UI enhancements
- Documentation improvements
- Bug fixes

---

## License

MIT © enruana

---

## Links

- [GitHub Repository](https://github.com/enruana/claude-orka)
- [Issue Tracker](https://github.com/enruana/claude-orka/issues)
- [npm Package](https://www.npmjs.com/package/@enruana/claude-orka)
- [Claude Code](https://claude.ai/code)
