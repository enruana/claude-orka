# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude-Orka is an SDK, CLI, and Electron UI for orchestrating Claude Code sessions with tmux. It enables conversation forking (branching), merging, and session management for Claude Code workflows.

**Core concept**: Use tmux panes to run multiple Claude Code sessions simultaneously - a main conversation and "forks" that branch off to explore alternatives. Forks can be exported (summarized) and merged back into their parent conversation.

## Build & Development Commands

```bash
# Install dependencies
npm install

# Build all components (SDK + CLI + Electron)
npm run build

# Build individual components
npm run build:sdk          # TypeScript SDK compilation
npm run build:cli          # Bundle CLI with esbuild
npm run build:ui           # Build React UI with Vite
npm run build:electron-main # Bundle Electron main process

# Development
npm run dev                # Watch mode for SDK
npm run orka               # Run CLI from source with tsx

# Testing & Validation
npm run type-check         # TypeScript type checking (no output)
npm link                   # Link globally for testing CLI
orka doctor                # Verify system dependencies (Node, tmux, Claude CLI, Electron)
orka prepare               # Install missing dependencies automatically

# Electron development
npm run electron:dev       # Build and launch Electron in dev mode
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

**TmuxCommands** (`src/utils/tmux.ts`)
- Low-level tmux wrapper using execa
- Creates sessions, panes, sends keys
- Applies custom Claude-Orka theme (`.tmux.orka.conf`)

**Claude History Integration** (`src/utils/claude-history.ts`)
- Reads `~/.claude/history.jsonl` to detect session IDs
- Polls for new session IDs when creating forks
- Links Claude sessions to tmux panes

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
7. Open terminal window and launch Electron UI

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
- Commands in `src/cli/commands/` (session.ts, fork.ts, merge.ts, etc.)
- Each command imports ClaudeOrka SDK and calls appropriate methods
- Output utilities in `src/cli/utils/output.ts` (chalk, cli-table3, ora)

**Key CLI commands**:
- `orka prepare`: Install system dependencies (tmux, Claude CLI)
- `orka doctor`: Check system dependencies and configuration
- `orka init`: Create `.claude-orka/` directory structure
- `orka session create/resume/close/delete`: Session management
- `orka fork create/resume/close/delete`: Fork management
- `orka merge export/do/auto`: Fork export and merge workflow

### Electron UI Architecture

**Main process** (`electron/main/main.ts`)
- Creates frameless window (600x800)
- Watches `.claude-orka/state.json` with chokidar
- Provides IPC handlers for actions (createFork, exportFork, merge, close, etc.)
- Opens terminal windows and launches child processes

**Renderer** (`electron/renderer/src/`)
- React + TypeScript + Vite
- Uses ReactFlow for visual session tree
- Components: SessionTree, ActionPanel, ForkInfoModal
- Real-time state updates via file watching
- Custom node types for main branch and forks (active/closed/merged)

**IPC Communication**:
- Renderer requests actions via `window.electron.{action}()`
- Main process executes via ClaudeOrka SDK
- State changes trigger file watch → window reload

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
- `.tmux.orka.conf` - Custom tmux theme configuration
- `dist/electron/main/main.js` - Electron main process (bundled)
- `dist/electron/preload/preload.js` - Electron preload script (bundled)
- `dist/electron/renderer/` - React UI (built with Vite)

## Testing Approach

Manual testing workflow:
1. Build: `npm run build`
2. Link: `npm link`
3. Test CLI: `orka session create "Test"`
4. Test fork: `orka fork create {sessionId} "Test Fork"`
5. Test merge: `orka merge auto {sessionId} {forkId}`
6. Clean up: `orka session delete {sessionId}`

For Electron UI:
1. Build: `npm run build:electron`
2. Run: `npm run electron:dev`
3. Manually test UI interactions

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

**UI won't launch**:
1. Check if Electron is installed: `orka doctor`
2. If not installed: `orka prepare` or `npm install -g electron`
3. Check if Electron process is running: `ps aux | grep electron`
4. Verify `dist/electron/main/main.js` exists after build

**Electron not found after global install**: Make sure Electron is in PATH. Run `which electron` to verify. If not found, check npm global bin path: `npm config get prefix`

**Type errors after changes**: Run `npm run type-check` to see all errors. Fix before building.

## Code Style

- TypeScript with strict mode enabled
- ES modules (type: "module" in package.json)
- async/await for all async operations
- No unused imports or variables (enforced by tsconfig)
- Use logger for debugging, not console.log
- Descriptive error messages for user-facing errors
