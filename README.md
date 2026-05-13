# Claude-Orka

> SDK, CLI, and Web UI for orchestrating Claude Code sessions with tmux — conversation branching, project knowledge base, autonomous agents, and remote access.

**Current version:** 0.13.0 · **License:** MIT · **Node:** >=18

## What is Claude-Orka

Claude-Orka turns a single machine into a remote-accessible workspace for running multiple Claude Code sessions concurrently. Each session lives in a dedicated tmux pane, can be forked to explore alternatives, and can be opened from any browser on your tailnet via a built-in web UI.

It also includes:

- **Knowledge Base (KB)** — track decisions, tasks, spikes, bugs, milestones, and their relationships as a graph that Claude can query for context.
- **Master Agents** — autonomous Claude sessions that react to hook events, can be remote-controlled via Telegram, and self-recover from stalls.
- **Web UI** — dashboard with embedded terminals, KB graph, code editor (Monaco), file finder, and per-session git panel.
- **Chrome extension** — record audio (tab/mic), transcribe via local Whisper, generate AI reports.
- **HTTPS via Tailscale** — auto-detect certs from `~/.orka/certs/`, fall back to HTTP if absent.

## Quick start

```bash
# Install
npm install -g @enruana/claude-orka

# Install system dependencies (tmux, ttyd, ffmpeg, whisper, xclip, tailscale)
orka prepare

# Verify everything is ready
orka doctor

# Start the web server (default port 3456)
orka start
```

Then open `http://localhost:3456` (or `https://<host>.<tailnet>.ts.net:3456` if SSL certs were generated — see [docs/https-tailscale.md](docs/https-tailscale.md)).

## Common commands

| Command | What it does |
|---|---|
| `orka start` | Start web server + UI (auto-HTTPS if certs exist) |
| `orka prepare` | Install all system dependencies |
| `orka doctor` | Check system state and configuration |
| `orka init` | Create `.claude-orka/` in current project |
| `orka status` | Show sessions and forks in current project |
| `orka session create [name]` | Create a new Claude session |
| `orka session list` | List all sessions |
| `orka session resume [id]` | Resume a saved session (interactive if no id) |
| `orka fork create <session-id> [name]` | Branch a session into a new fork |
| `orka merge auto <session-id> <fork-id>` | Export fork + merge into parent |
| `orka kb add <type> <title>` | Add a KB entity (decision, task, spike, bug, ...) |
| `orka kb show <id>` | Display an entity with its edges |
| `orka kb context` | Output AI-optimized project context |
| `orka git-account` | Switch SSH key used for git pushes |
| `orka aws-account` | Switch active AWS profile |
| `orka telegram test --token ... --chat ...` | Send a Telegram test message |

Full CLI reference: [docs/cli-reference.md](docs/cli-reference.md)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  CLI  (orka …)              Web UI  (browser)            │
└──────────┬─────────────────────────────┬─────────────────┘
           │                             │
           ▼                             ▼
        ClaudeOrka  (src/core)  ◀───  Express server (src/server)
           │                             │
           ▼                             ▼
       SessionManager  ──▶ tmux + ttyd + Claude Code processes
       KnowledgeBaseManager ──▶ .claude-orka/.orka-kb/
       GlobalStateManager    ──▶ ~/.orka/config.json
       AgentManager  ──▶ Hook server + AgentDaemons + Telegram bots
```

- **CLI** — single binary (`orka`) built with esbuild; commands in `src/cli/commands/`.
- **SDK** — `ClaudeOrka` class in `src/core/`; usable programmatically.
- **Server** — Express on port 3456; HTTPS optional via `--cert`/`--key` or auto-detect.
- **Web UI** — React + Vite + React Router; built into `dist/web-ui/`, served by Express.
- **Agents** — daemons in `src/agent/` that subscribe to Claude Code hooks and use an LLM to decide next actions.
- **Chrome extension** — standalone `chrome-extension/` directory; talks to the local server.

Full architectural reference: [CLAUDE.md](CLAUDE.md)

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — Architecture reference (read first if you are an AI agent working on this repo).
- **[docs/cli-reference.md](docs/cli-reference.md)** — Every command, every flag.
- **[docs/https-tailscale.md](docs/https-tailscale.md)** — HTTPS setup via Tailscale (required for clipboard from remote).
- **[docs/knowledge-base.md](docs/knowledge-base.md)** — KB system overview for humans.
- **[docs/AGENTS.md](docs/AGENTS.md)** — Master agents: design and implementation.
- **[MANAGEMENT.md](MANAGEMENT.md)** — Build, version bump, and npm publish workflow.
- **[.claude/skills/](.claude/skills/)** — Claude Code skills for working with the KB (auto-loaded inside any Orka project).

## Requirements

- Node.js 18 or newer
- tmux (terminal multiplexer)
- ttyd (web terminal server)
- Claude CLI (`claude`) — install from https://claude.ai/download
- ffmpeg (voice input)
- cmake (build Whisper)
- xclip (Linux clipboard for tmux)
- Tailscale (optional, for HTTPS / remote access)

All of these are installed by `orka prepare` on Linux and macOS.

## Repository structure

```
src/
  cli/              — CLI commands and entry point
  core/             — SDK: ClaudeOrka, SessionManager, KnowledgeBaseManager, ...
  server/           — Express app + API routers + WebSocket proxies
  agent/            — Master agent system (daemons, hooks, LLM decisions, Telegram)
  web-ui/           — React frontend (Vite)
  utils/            — Shared helpers (tmux, logger, certs, paths, claude-history)
  models/           — TypeScript types and KB validator/registry
  assets/skills/    — KB skills shipped with the package
chrome-extension/   — Chrome MV3 extension (recorder, writer, settings)
docs/               — Human-facing documentation
.claude/skills/     — Skills installed into this repo for Claude Code
.tmux.orka.conf     — Custom tmux theme applied to every session
```

## Contributing

This is currently a personal/internal project. Issues and PRs welcome at https://github.com/enruana/claude-orka/issues.
