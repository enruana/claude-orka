# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude-Orka is an SDK, CLI, and Web UI for orchestrating Claude Code sessions with tmux. It enables conversation forking (branching), merging, session management for Claude Code workflows, plus:

- A **Knowledge Base (KB)** for tracking project decisions, tasks, spikes, bugs, etc. as a typed graph
- An **autonomous agent system** that reacts to Claude Code hook events and can be remote-controlled via Telegram
- A **Web UI** with embedded terminals, KB graph, Monaco code editor, and a finder-style file browser
- A **Chrome extension** for audio recording, transcription, and AI-powered writing
- **HTTPS** support via Tailscale-issued certs (required for cross-device clipboard support)

**Core concept**: every session lives in its own tmux session prefixed `orka-<uuid>`, with one ttyd web terminal proxied through the Express server. Forks are extra panes inside the same tmux session running `claude session resume` with the parent's session id.

## Build & Development Commands

```bash
# Install
npm install

# Build everything (SDK + CLI bundle + Web UI + static assets + skills)
npm run build

# Individual builds
npm run build:sdk          # TypeScript compile to dist/
npm run build:cli          # esbuild bundle dist/cli.js
npm run build:web-ui       # Vite build dist/web-ui/
npm run build:assets       # Copy terminal-mobile.html, chrome-extension/, skills/

# Dev
npm run dev                # Watch mode for SDK
npm run orka -- <args>     # Run CLI from source via tsx
npm run type-check         # tsc --noEmit

# Link for local testing
npm link
orka doctor
```

## Project Architecture

### CLI entry point — `src/cli/`

`src/cli/index.ts` registers every command and dispatches. All commands live in `src/cli/commands/`:

| Command | File | Purpose |
|---|---|---|
| `orka start` | `start.ts` | Start web server (HTTPS auto-detect via `findCertPair`) |
| `orka prepare` | `prepare.ts` | Install tmux, ttyd, ffmpeg, cmake, whisper, xclip, tailscale, Puppeteer |
| `orka init` | `init.ts` | Create `.claude-orka/` in current project |
| `orka doctor` | `doctor.ts` | Check system deps + Tailscale + SSL certs state |
| `orka status` | `status.ts` | Show sessions/forks for current project |
| `orka session …` | `session.ts` | create, list, get, resume, close, delete |
| `orka fork …` | `fork.ts` | create, list, resume, close, delete |
| `orka merge …` | `merge.ts` | export, do, auto |
| `orka telegram …` | `telegram.ts` | test, chat-id |
| `orka git-account` | `git-account.ts` | Interactive SSH key selector in ssh-agent |
| `orka aws-account` | `aws-account.ts` | AWS profile switcher + optional shell integration |
| `orka kb …` | `kb.ts` | Knowledge Base (init, add, update, link, show, list, lint, upgrade, classify, …) |

Full CLI reference with flags and examples: [docs/cli-reference.md](docs/cli-reference.md).

### SDK / Core — `src/core/`

Public API surface (exported from `src/core/index.ts`):

- **`ClaudeOrka`** (`ClaudeOrka.ts`) — Facade. Constructs a `SessionManager` and exposes all session/fork operations.
- **`SessionManager`** (`SessionManager.ts`) — Orchestrates tmux sessions and Claude Code processes. Handles fork creation/merging, claude-history polling, ttyd lifecycle, and the **system terminal** (`startSystemTerminal` / `stopSystemTerminal` for the dashboard's standalone shell).
- **`StateManager`** (`StateManager.ts`) — Persists per-project state to `.claude-orka/state.json` with file locking. Manages tmux theme copy with mtime check to avoid race conditions.

Also in `src/core/` (not exported from index but used internally):

- **`GlobalStateManager`** — Singleton for `~/.orka/config.json`. Tracks `projects[]`, `serverPort`, `ttydBasePort`, `systemTerminal` ttyd info.
- **`KnowledgeBaseManager`** — KB CRUD. Reads/writes `.claude-orka/.orka-kb/`. Supports validation modes (strict / draft / off) and the entity registry in `src/models/kb-registry.ts`.
- **`KBMigrator`** — Plans and applies v1→v2 KB schema migrations (types, statuses, relations, qualifiers).
- **`kb-traversal.ts`** — `weightedTraversal`, `relatedEntityIds`, `BREADTH_PRESETS` (narrow/medium/wide) for KB context generation.

### Server — `src/server/`

`src/server/index.ts` creates the Express app, mounts API routers, sets up:

- **WebSocket upgrade proxy** for `/ttyd/:port/ws` — routes each session's xterm WS to its ttyd backend
- **HTTP proxy** for `/ttyd/:port/*` — same purpose for non-WS requests
- **Custom mobile terminal page** at `/terminal/:port` — serves `terminal-mobile.html` (xterm.js + virtual keyboard + OSC 52 handler)
- **HTTPS** when both `certPath` and `keyPath` are passed in `ServerOptions`
- **SPA fallback** that serves `dist/web-ui/index.html` for any non-API GET

API routers in `src/server/api/`:

| Router | Path | Highlights |
|---|---|---|
| `projects.ts` | `/api/projects` | CRUD, system-terminal (POST/DELETE), tasks, comments, version check, reinitialize |
| `sessions.ts` | `/api/sessions` | CRUD, resume, detach, close, forks (create/close/export/merge), select-branch, restart, capture, send-text |
| `agents.ts` | `/api/agents` | CRUD, start/stop, connect/disconnect, logs |
| `files.ts` | `/api/files` | list, tree, content (read/write), create, delete, image, raw, download, search, move, upload |
| `git.ts` | `/api/git` | status, diff, stage/unstage/discard, commit, log, show, generate-commit-message, branches |
| `kb.ts` | `/api/kb` | status, entities CRUD, edges, timeline, graph, context, project-doc, sync |
| `ai.ts` | `/api/ai` | query, translate, markdown-format, name, report (powered by Claude CLI) |
| `transcribe.ts` | `/api/transcribe` | Upload audio, get transcription (Whisper-based), job polling |
| `browse.ts` | `/api/browse` | Filesystem directory browsing (sandboxed) |

### Web UI — `src/web-ui/`

React + TypeScript + Vite + React Router. Routes defined in `src/web-ui/src/App.tsx`:

| Path | Component | Purpose |
|---|---|---|
| `/` | `HomePage` | Landing page |
| `/dashboard` | `ProjectDashboard` | All projects, sessions, group filters, system terminal |
| `/agents` | `AgentCanvasPage` | Master agents visualization + config |
| `/projects/:encodedPath` | redirect → `/dashboard` | Legacy URL |
| `/projects/:encodedPath/sessions/:sessionId` | `SessionPage` | Session view (terminal iframe + side panels) |
| `/projects/:encodedPath/code` | `CodeEditorPage` | Monaco editor with file tree + git panel |
| `/projects/:encodedPath/files` | `FilesPage` | Finder-style file browser |
| `/projects/:encodedPath/files/view` | `FileViewerPage` | Single-file viewer (markdown render, image preview) |
| `/projects/:encodedPath/kb` | `KBPage` | Knowledge Base graph + timeline + detail panel |

Key component directories (`src/web-ui/src/components/`):

- `kb/` — KB graph + side panels (KBGraph, KBGuidePanel, KBDetailPanel, KBTimeline, KBEntityNode, KBZoneLabel, KBPage)
- `agent/` — Agent canvas (AgentCanvas, AgentNode, ProjectNode, AgentConfigModal, AgentLogsModal, ConnectionEdge)
- `code-editor/` — Monaco view (CodeEditorView, EditorPane, FileExplorer/FileTree, GitPanel, SearchPanel, CommitHistory, DiffViewer, ContextMenu, MarkdownViewer)
- `finder/` — Finder-style file browser (FinderExplorer, FinderListView/GridView, FinderToolbar, FinderBreadcrumb, FinderStatusBar)
- Top level: `SessionView`, `SessionPage`, `ProjectDashboard`, `ProjectDock`, `TaskWidget`, `CommentWidget`, `AddCommentDialog`, `VoiceInputPopover`, `QuickAIDialog`, `FolderBrowser`

### Agent system — `src/agent/`

Documented in detail in [docs/AGENTS.md](docs/AGENTS.md). Key modules:

- **`AgentManager`** — Orchestrates all daemons + the hook HTTP server on port 9999
- **`AgentDaemon`** — One per active agent; owns a `TerminalReader`, `TerminalWatchdog`, `TelegramBot`, and an `EventStateMachine`
- **`EventStateMachine`** — Processes hook events via guard → route → capture-terminal → parse → fast-path → LLM fallback
- **`LLMDecisionMaker`** — Uses Claude Agent SDK with structured output to decide actions (respond / approve / reject / wait / request_help / compact / clear / escape)
- **`TerminalWatchdog`** — Timer-driven (~30s) staleness detector with LLM verdict and safety quorum
- **`TerminalReader`** — Reads tmux pane content + parses terminal state (waiting, permission prompt, processing, context limit)
- **`TerminalScreenshot`** — Headless Puppeteer screenshot of tmux pane (for richer LLM input)
- **`HookServer`** — `POST /api/hooks/:agentId` endpoint receiving Claude Code hook payloads
- **`HookConfigGenerator`** — Writes `.claude/settings.json` hook entries (curl POSTs) for projects with an active agent
- **`TelegramBot`** — Per-agent grammY bot; long polling; `/tell` injects text into the terminal; free text triggers LLM consultation
- **`AgentStateManager`** — Persists agent configs in `~/.claude-orka/agents.json`
- **`mcp/`** — MCP server exposing terminal tools to Claude (read/write/screenshot)

### Knowledge Base — `src/models/` + `src/core/Knowledge*`

The KB stores typed entities (`decision`, `task`, `spike`, `bug`, `project`, `meeting`, `milestone`, `direction`, `goal`, `initiative`, `question`, `person`, `repo`, `artifact`, `context`, `activity`) with edges (relations). Stored in `.claude-orka/.orka-kb/`:

```
.orka-kb/
  events.jsonl      — event log (append-only source of truth)
  entities/         — materialized entity JSON files
  edges/            — materialized edge JSON files
  views/            — generated context.md, timeline.md, INDEX.md per project
```

- Schema, validation, and registry in `src/models/kb-registry.ts` + `src/models/kb-validator.ts`
- CRUD in `src/core/KnowledgeBaseManager.ts`
- Migration from v1 in `src/core/kb-migrator.ts`
- Traversal/context selection in `src/core/kb-traversal.ts`
- CLI exposed via `orka kb <subcommand>`
- HTTP API at `/api/kb/*`
- Web UI at `/projects/:path/kb`
- Skills for Claude in `.claude/skills/kb-*.md` (auto-installed by `orka kb init`)

Human-facing overview: [docs/knowledge-base.md](docs/knowledge-base.md).

### HTTPS / Tailscale — `src/utils/certs.ts`

- `CERTS_DIR` = `~/.orka/certs/`
- `findCertPair()` — scans for any `*.crt` + matching `*.key` and returns the pair
- `getTailscaleHostname()` — parses `tailscale dns status` → returns `host.<tailnet>.ts.net`
- `ensureCertsDir()` — `mkdir -p`

`orka start` calls `findCertPair()` when no explicit `--cert`/`--key` are passed and `--http` is not set; auto-enables HTTPS if a pair is found. `orka prepare` installs Tailscale and prints the exact commands to generate the cert (it cannot run `sudo tailscale cert` non-interactively). `orka doctor` reports cert + Tailscale state.

Setup walkthrough: [docs/https-tailscale.md](docs/https-tailscale.md).

### Clipboard / OSC 52 — `src/server/terminal-mobile.html`

The mobile terminal page registers a custom OSC 52 handler on `term.parser` (not the official addon-clipboard). On selection in tmux (with `set-clipboard on` + `terminal-overrides` for `Ms`), tmux emits OSC 52 to xterm.js. The handler:

1. Tries `navigator.clipboard.writeText()` immediately (may fail without user gesture)
2. Stashes the text as pending
3. On next `click`/`keydown`/`touchend`, flushes via `document.execCommand('copy')` inside a hidden textarea (works in iframes within secure context)

The page also has a "Copy from Terminal" quick action that opens a modal with the last ~3000 chars of the buffer in a textarea so users can select/copy with the native OS menu.

For this to work end-to-end the server must be HTTPS (Clipboard API requires secure context except on localhost).

### State files

| Path | Contents |
|---|---|
| `.claude-orka/state.json` | Per-project: sessions + forks + tasks + comments + version |
| `.claude-orka/exports/fork-{id}.md` | Fork export summaries (input to merge) |
| `.claude-orka/.orka-kb/` | KB events, entities, edges, views |
| `.claude-orka/.tmux.orka.conf` | Project-local copy of tmux theme |
| `~/.orka/config.json` | Global: registered projects, ports, system terminal info |
| `~/.orka/certs/*.crt` + `*.key` | HTTPS certificates (Tailscale-issued) |
| `~/.claude-orka/agents.json` | Agent configurations (one entry per master agent) |
| `~/.claude/history.jsonl` | Claude CLI's session history (read-only; we poll it) |
| `.tmux.orka.conf` | Tmux theme source (in package root) |

### System ports

| Port | Purpose |
|---|---|
| 3456 | Web server (configurable with `--port`) |
| 9999 | Hook server (for Claude Code hooks → agents) |
| 4444+ | ttyd instances (auto-assigned starting at `ttydBasePort` in global config) |

## Development Patterns

### Adding a new CLI command

1. Create `src/cli/commands/mycommand.ts` exporting a `mycommandCommand(program)` function
2. Import the SDK + output utilities from `src/cli/utils/`
3. Register in `src/cli/index.ts`
4. `npm run build:cli` then `orka mycommand`

### Adding a new SDK method

1. Method on `src/core/ClaudeOrka.ts` (public surface)
2. Implementation in `src/core/SessionManager.ts` (or the appropriate manager)
3. `npm run build:sdk` regenerates types

### Adding a new API route

1. Create or edit `src/server/api/<router>.ts`
2. Register in `src/server/index.ts`
3. Add a client method in `src/web-ui/src/api/client.ts`
4. Build both: `npm run build:sdk && npm run build:cli && npm run build:web-ui`

### Adding a new Web UI page

1. Create the component
2. Add a `<Route>` in `src/web-ui/src/App.tsx`
3. `npm run build:web-ui`
4. Vite dev server: `cd src/web-ui && npx vite` (proxies `/api` to port 3456)

### Working with state

- Always go through `StateManager` / `GlobalStateManager` — never edit JSON files directly
- Atomic read-modify-save
- Update `lastUpdated` on each mutation

### Working with tmux

- Use `TmuxCommands` in `src/utils/tmux.ts` (wraps `execa`)
- Session names: `orka-{sessionId}` (one tmux session per Claude session)
- Pane IDs are dynamic — never hardcode them
- The system terminal lives in `orka-system-terminal` (separate from per-project sessions)

### Error handling

- `TmuxError` for tmux failures
- Use the project logger (`src/utils/logger.ts`)
- CLI commands wrap actions in try/catch and emit user-friendly messages via `Output` utilities

## Common Issues

- **Session creation hangs** — `detectNewSessionId` polls `~/.claude/history.jsonl` for ~10s. Slow disks can need more.
- **Clipboard doesn't work from a remote browser** — Browser requires secure context. Run `orka start` with HTTPS certs (see [docs/https-tailscale.md](docs/https-tailscale.md)).
- **Fork creation fails** — Only one active fork per parent is allowed by Claude. Close or merge the existing one first.
- **Tmux theme not applied** — Re-run `orka init` in the project, or use the "Sync" button in the dashboard (calls `reinitialize` which re-copies the theme).
- **Mobile selection doesn't copy** — Use the **Copy from Terminal** quick action button instead of native xterm selection.
- **Agent not receiving hooks** — Check `lsof -i :9999` and verify the agent is started in the Web UI's Agent Canvas.

## Publishing Workflow

See [MANAGEMENT.md](MANAGEMENT.md). Quick version:

```bash
npm run build && npm run type-check
npm version patch         # or minor/major
git push origin main --tags
npm publish
```

## Code Style

- TypeScript with `strict` mode enabled
- ES modules (`"type": "module"` in `package.json`)
- async/await for all async ops
- No unused imports or variables (enforced by `tsconfig`)
- Use the project logger, not `console.log`
- User-facing error messages should be actionable
