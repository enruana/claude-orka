# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude-Orka is an SDK, CLI, and Web UI for orchestrating Claude Code sessions with tmux. It enables conversation forking (branching), merging, and session management for Claude Code workflows, plus an autonomous agent system with hooks, LLM-based decisions, and Telegram integration.

**Core concept**: Use tmux panes to run multiple Claude Code sessions simultaneously - a main conversation and "forks" that branch off to explore alternatives. Forks can be exported (summarized) and merged back into their parent conversation.

## Build & Development Commands

```bash
# Install dependencies
npm install

# Build all components (SDK + CLI + Web UI + assets)
npm run build

# Build individual components
npm run build:sdk          # TypeScript SDK compilation
npm run build:cli          # Bundle CLI with esbuild
npm run build:web-ui       # Build React Web UI with Vite
npm run build:assets       # Copy static assets (terminal-mobile.html)

# Development
npm run dev                # Watch mode for SDK
npm run orka               # Run CLI from source with tsx

# Testing & Validation
npm run type-check         # TypeScript type checking (no output)
npm link                   # Link globally for testing CLI
orka doctor                # Verify system dependencies (Node, tmux, Claude CLI, ttyd)
orka prepare               # Install missing dependencies automatically
```

## Project Architecture

### Core Components

**ClaudeOrka SDK** (`src/core/ClaudeOrka.ts`)
- Public API facade for all operations
- Delegates to SessionManager for actual work
- Entry point for programmatic usage

**SessionManager** (`src/core/SessionManager.ts`)
- Orchestrates tmux sessions and Claude Code processes
- Handles session lifecycle (create, resume, close, delete)
- Manages fork creation and merging
- Detects Claude session IDs from `~/.claude/history.jsonl`

**StateManager** (`src/core/StateManager.ts`)
- Persists state to `.claude-orka/state.json`
- Manages ProjectState with all sessions and forks
- Handles state reads/writes with file locking

**GlobalStateManager** (`src/core/GlobalStateManager.ts`)
- Manages global Orka state in `~/.orka/config.json`
- Tracks registered projects, server port, ttyd base port
- Singleton pattern with lazy initialization

**TmuxCommands** (`src/utils/tmux.ts`)
- Low-level tmux wrapper using execa
- Creates sessions, panes, sends keys
- Applies custom Claude-Orka theme (`.tmux.orka.conf`)

**Claude History Integration** (`src/utils/claude-history.ts`)
- Reads `~/.claude/history.jsonl` to detect session IDs
- Polls for new session IDs when creating forks
- Links Claude sessions to tmux panes

### Server (`src/server/`)

**Express HTTP Server** (`src/server/index.ts`)
- Serves Web UI static files with SPA fallback
- WebSocket proxy for ttyd (web terminal)
- HTTP proxy for ttyd mobile access
- Custom terminal route with xterm.js + virtual keyboard

**API Routers** (`src/server/api/`):
- `projects.ts` - CRUD for registered projects
- `sessions.ts` - Session create/list/get/resume/delete
- `agents.ts` - Agent CRUD, start/stop, logs
- `files.ts` - File tree, image serving, safe path traversal
- `git.ts` - Git status, history, commit, push
- `browse.ts` - Directory browsing (security-constrained)
- `transcribe.ts` - Audio transcription for voice input

### Agent System (`src/agent/`)

**AgentManager** (`src/agent/AgentManager.ts`)
- Orchestrates all agent daemons and the hook server
- CRUD operations for agents, start/stop lifecycle
- Routes hook events to appropriate daemons

**AgentDaemon** (`src/agent/AgentDaemon.ts`)
- Individual agent process monitoring a Claude Code session
- Delegates event processing to EventStateMachine
- Integrates TerminalWatchdog for stall detection
- Owns per-agent TelegramBot instance

**EventStateMachine** (`src/agent/EventStateMachine.ts`)
- Processes Claude Code hook events through a state machine
- Flow: guard → route_event → capture_terminal → parse_terminal → fast_path
- Fast-path for deterministic decisions, LLM fallback for ambiguous states
- Actions: respond, approve, reject, wait, request_help, compact, clear, escape

**HookServer** (`src/agent/HookServer.ts`)
- HTTP server on port 9999 receiving Claude Code hook events
- Route: `POST /api/hooks/:agentId`
- Normalizes hook payloads, extracts type-specific data

**HookConfigGenerator** (`src/agent/HookConfigGenerator.ts`)
- Generates Claude Code hook config for projects
- Creates hook entries using curl POST to hook server

**LLMDecisionMaker** (`src/agent/LLMDecisionMaker.ts`)
- Uses Claude Code Agent SDK for intelligent decisions
- Called by EventStateMachine for ambiguous terminal states
- Structured output with JSON schema (action, response, reason)

**TerminalWatchdog** (`src/agent/TerminalWatchdog.ts`)
- Timer-driven polling (~30s) to detect stalled sessions
- LLM evaluates if Claude is stalled or needs intervention
- Safety: requires N consecutive verdicts, skips during spinners

**TelegramBot** (`src/agent/TelegramBot.ts`)
- Per-agent Telegram bot (grammY library, long polling)
- Free text → LLM consultation, `/tell` → direct terminal injection
- Sends notifications on milestones, errors, approval requests

**TerminalReader** (`src/agent/TerminalReader.ts`)
- Reads terminal content via tmux with metadata
- Parses terminal state: waiting, permission prompts, processing, context limits

**TerminalScreenshot** (`src/agent/TerminalScreenshot.ts`)
- Captures terminal screenshots using headless Puppeteer

**AgentStateManager** (`src/agent/AgentStateManager.ts`)
- Persistent agent configuration in `~/.claude-orka/agents.json`

### Web UI (`src/web-ui/`)

**Tech stack**: React + TypeScript + Vite + React Router

**Routes** (defined in `src/web-ui/src/App.tsx`):
- `/` - Home page
- `/dashboard` - Project dashboard (main landing)
- `/agents` - Agent canvas page
- `/projects/:path/sessions/:sessionId` - Session view
- `/projects/:path/code` - Code editor
- `/projects/:path/files` - File browser
- `/projects/:path/files/view` - File viewer

**Key components** (`src/web-ui/src/components/`):
- `ProjectDashboard` - Project listing with session management
- `SessionView` - Session details with embedded terminal
- `code-editor/` - Monaco editor, file explorer, Git panel, diff viewer, commit history
- `finder/` - Finder-style file browser (list/grid views, breadcrumbs, toolbar)
- `agent/` - Agent canvas, agent nodes, project nodes, config modal, logs modal
- `VoiceInputPopover` - Voice recording and transcription UI

### State Management

**State file location**: `.claude-orka/state.json`

**State structure**:
- `ProjectState` contains array of `Session` objects
- Each `Session` has a `main` branch (MainBranch) and `forks[]` array
- Each `Fork` tracks: parentId, claudeSessionId, tmuxPaneId, status, contextPath

**Critical state fields**:
- `tmuxSessionId`: Session name like "orka-abc123"
- `claudeSessionId`: UUID from Claude's history.jsonl
- `tmuxPaneId`: Pane identifier like "%1", "%2"
- `status`: "active" | "saved" (sessions), "active" | "saved" | "closed" | "merged" (forks)
- `contextPath`: Path to fork export file (`.claude-orka/exports/fork-{id}.md`)

### Session Lifecycle

**Creating a session**:
1. Generate session ID (nanoid)
2. Create tmux session with name "orka-{sessionId}"
3. Apply custom theme from `.tmux.orka.conf`
4. Launch Claude Code in pane
5. Detect new Claude session ID from history.jsonl
6. Save state with session + main branch
7. Start ttyd for web terminal access

**Creating a fork**:
1. Split tmux pane (horizontal or vertical)
2. Capture existing session IDs from history.jsonl
3. Send Ctrl+C to new pane, then run `claude session resume {parentClaudeSessionId}`
4. Poll history.jsonl to detect new session ID (fork's Claude session)
5. Add fork to parent's forks array in state
6. Fork inherits context from parent via Claude's resume

**Merging a fork**:
1. Export: Send prompt to fork asking Claude to generate summary at `.claude-orka/exports/fork-{id}.md`
2. Wait for export file to be created (async operation, Claude does it)
3. Merge: Send prompt to parent conversation including the export file contents
4. Close fork pane and mark status as "merged"

**Session recovery** (after system restart):
1. Check if tmux session exists
2. If missing: Create new tmux session, resume main Claude session, recreate fork panes
3. If exists: Reconnect to existing panes

### CLI Architecture

**Entry point**: `src/cli/index.ts`

**Command structure**: Uses `commander` library
- Commands in `src/cli/commands/` (start.ts, session.ts, fork.ts, merge.ts, telegram.ts, etc.)
- Each command imports ClaudeOrka SDK and calls appropriate methods
- Output utilities in `src/cli/utils/output.ts` (chalk, cli-table3, ora)

**Key CLI commands**:
- `orka start`: Start web server (default port 3456)
- `orka prepare`: Install system dependencies (tmux, Claude CLI, ttyd, ffmpeg, whisper, puppeteer)
- `orka doctor`: Check system dependencies and configuration
- `orka init`: Create `.claude-orka/` directory structure
- `orka status`: Show project status
- `orka session create/list/get/resume/close/delete`: Session management
- `orka fork create/list/resume/close/delete`: Fork management
- `orka merge export/do/auto`: Fork export and merge workflow
- `orka telegram test/chat-id`: Telegram bot utilities

### Important Implementation Details

**Claude session detection**:
- Claude writes new entries to `~/.claude/history.jsonl` when sessions start
- We poll this file to detect new session IDs after forking
- Timeout: 10 seconds (configurable in detectNewSessionId)

**Custom tmux theme**:
- Stored in `.tmux.orka.conf` at package root
- Applied automatically to all new sessions
- Orange branding (#208), top status bar, pane borders with titles

**Export mechanism**:
- Async: We send prompt to Claude, it generates file in background
- No direct control over timing - rely on file system polling
- Default wait time: 15 seconds (configurable with --wait flag)

**Fork limitation**:
- Claude Code limitation: Only one fork per parent branch can be active
- Must merge or close existing fork before creating new one from same parent
- UI enforces this with disabled "New Fork" button

**System ports**:
- 3456: Web server (configurable with `orka start --port`)
- 9999: Hook server (receives Claude Code hook events)
- 4444+: ttyd instances (web terminal, auto-assigned)

## Development Patterns

### Adding a new CLI command

1. Create command file in `src/cli/commands/mycommand.ts`
2. Import ClaudeOrka SDK and output utilities
3. Implement command logic using SDK methods
4. Register command in `src/cli/index.ts`
5. Build: `npm run build:cli`
6. Test: `npm run orka -- mycommand`

### Adding a new SDK method

1. Add method to `src/core/ClaudeOrka.ts` (public API)
2. Implement in `src/core/SessionManager.ts` if needed
3. Update types in `src/models/` if needed
4. Build: `npm run build:sdk`
5. Update type declarations are auto-generated

### Adding a new API route

1. Create router file in `src/server/api/myroute.ts`
2. Define Express routes with proper error handling
3. Register router in `src/server/index.ts`
4. Build: `npm run build:sdk && npm run build:cli`

### Adding a new Web UI page

1. Create page component in `src/web-ui/src/pages/` or `src/web-ui/src/components/`
2. Add route in `src/web-ui/src/App.tsx`
3. Build: `npm run build:web-ui`
4. Dev: Vite dev server at port 5174 proxies API to port 3456

### Working with state

- Always use StateManager methods (load, save)
- Update `lastUpdated` timestamp when modifying state
- Use `session.lastActivity` for session-specific updates
- State mutations should be atomic (read → modify → save)

### Working with tmux

- Use TmuxCommands wrapper, not raw execa
- All tmux commands include error handling
- Session names follow pattern: "orka-{sessionId}"
- Pane IDs are dynamic ("%1", "%2", etc.) - don't hardcode

### Error handling

- TmuxError for tmux-specific failures
- Logger available throughout codebase
- CLI commands should catch errors and display user-friendly messages
- Use ora spinners for long-running operations

## Important Files

- `.claude-orka/state.json` - Project state (sessions, forks, metadata)
- `.claude-orka/exports/fork-{id}.md` - Fork export summaries
- `~/.claude/history.jsonl` - Claude's session history (read-only)
- `~/.orka/config.json` - Global config (projects, ports)
- `~/.claude-orka/agents.json` - Agent configurations
- `.tmux.orka.conf` - Custom tmux theme configuration
- `dist/cli.js` - Bundled CLI entry point
- `dist/web-ui/` - Built Web UI (served by Express)

## Testing Approach

Manual testing workflow:
1. Build: `npm run build`
2. Link: `npm link`
3. Test CLI: `orka session create "Test"`
4. Test fork: `orka fork create {sessionId} "Test Fork"`
5. Test merge: `orka merge auto {sessionId} {forkId}`
6. Clean up: `orka session delete {sessionId}`

For Web UI:
1. Start server: `orka start`
2. Or use Vite dev server: `cd src/web-ui && npx vite` (proxies API to port 3456)
3. Manually test UI interactions at http://localhost:5174

## Publishing Workflow

See MANAGEMENT.md for complete publishing guide. Quick version:

```bash
# 1. Make changes and test
npm run build
npm run type-check

# 2. Version bump
npm version patch  # or minor/major

# 3. Push to GitHub
git push origin main --tags

# 4. Publish to npm
npm publish

# 5. Verify
npm install -g @enruana/claude-orka
orka --version
```

## Common Issues

**Session recovery fails**: Check if Claude session still exists in `~/.claude/history.jsonl`. If missing, create new session.

**Fork creation timeout**: `detectNewSessionId` times out after 10 seconds. Increase timeout if needed in slow environments.

**Merge fails - no export**: Export must complete before merge. Use `orka merge auto` which handles timing automatically.

**Web UI won't start**:
1. Check if port 3456 is in use: `lsof -i :3456`
2. Try a different port: `orka start --port 8080`
3. Verify build output exists: `ls dist/web-ui/index.html`

**Agent not receiving hooks**:
1. Check hook server is running: `lsof -i :9999`
2. Verify agent is started in Agent Canvas
3. Check agent logs in the Web UI

**Type errors after changes**: Run `npm run type-check` to see all errors. Fix before building.

## Code Style

- TypeScript with strict mode enabled
- ES modules (type: "module" in package.json)
- async/await for all async operations
- No unused imports or variables (enforced by tsconfig)
- Use logger for debugging, not console.log
- Descriptive error messages for user-facing errors
