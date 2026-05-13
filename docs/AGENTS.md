# Master Agents

Master Agents are autonomous Claude Code sessions that react to **hook events** emitted by Claude itself, decide what to do (using either deterministic fast-paths or LLM-based reasoning), and act on the terminal — all without a human in the loop. Agents can also be **remote-controlled via Telegram**.

This document reflects the actual implementation in `src/agent/` as of v0.13.0.

## When to use an agent

- **Long-running tasks** where Claude might hit a permission prompt or context limit and stall — the agent can approve, reject, or compact context automatically.
- **Off-keyboard work** — start an agent in a session, walk away. It'll notify you on Telegram when it actually needs you.
- **Multi-session orchestration** — different agents can monitor different projects independently.

## High-level architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Claude Code session  (tmux pane, running `claude`)              │
│  ─ emits hook events (PreToolUse, SessionEnd, ...)               │
└──────────────────────────────┬───────────────────────────────────┘
                               │  POST /api/hooks/:agentId
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  HookServer  (port 9999)  ─ Express app                          │
│  ─ normalizes payload → ProcessedHookEvent                       │
└──────────────────────────────┬───────────────────────────────────┘
                               │  onEvent → AgentManager
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  AgentManager  (1 per server process)                            │
│  ─ holds AgentStateManager + HookServer + HookConfigGenerator    │
│  ─ routes each event to the right AgentDaemon                    │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  AgentDaemon  (1 per active agent)                               │
│  ─ owns: EventStateMachine, TerminalReader, TerminalWatchdog,    │
│           TelegramBot, LLMDecisionMaker                          │
│  ─ on event: ctx → guard → route → capture → parse → fast-path → │
│              (LLM fallback if ambiguous) → execute               │
└──────────────────────────────────────────────────────────────────┘
```

## Modules

All paths are relative to `src/agent/`.

### `AgentManager.ts`
- Singleton orchestrator (extends `EventEmitter`)
- Initializes the `HookServer` on the port from `AgentStateManager.getHookServerPort()` (default 9999)
- Maintains a `Map<agentId, AgentDaemon>` for active agents
- Routes incoming hook events to the right daemon
- Owns the global agent log buffer (in-memory, capped per agent)
- Public ops used by the Web UI: `createAgent`, `updateAgent`, `deleteAgent`, `startAgent`, `stopAgent`, `connectProject`, `disconnectProject`, `getLogs`, `clearLogs`

### `AgentDaemon.ts`
- One per active agent
- Holds the `EventStateMachine` and the per-agent processing state (`isProcessing`, `lastEventType`, `pendingFollowUp`, …)
- On each event: builds the `EventContext` and runs the state machine
- Owns a `TerminalWatchdog` and a `TelegramBot` (optional, only if `telegramToken` configured)

### `EventStateMachine.ts`

Pure-data state machine. Each node receives an `EventContext` and a logger, mutates context, and returns the next node name.

**Nodes:**
- `guard` — Skip if event type is ignored, if already processing, in cooldown, etc.
- `route_event` — Decide which handler to enter based on event type
- `log_only` — Just log, no action
- `handle_session_restart` — Special case after `/clear` or `/compact`
- `capture_terminal` — Read the tmux pane content via `TerminalReader`
- `parse_terminal` — Detect state: `waiting`, `permission_prompt`, `context_limit`, `processing`, `idle`
- `fast_path` — Deterministic rules (e.g. "always approve safe-list of tools")
- `handle_context_limit` — Auto-compact when near limit
- `handle_permission` — Approve/reject/escalate
- `handle_waiting` — Send a follow-up prompt
- `handle_ambiguous` — Call `LLMDecisionMaker` for an LLM verdict
- `execute` — Apply the `Decision` (write to terminal, send Telegram notification)
- `end` — Mark processing done, update cooldowns

**Actions** (`ActionType`): `respond`, `approve`, `reject`, `wait`, `request_help`, `compact`, `clear`, `escape`.

### `LLMDecisionMaker.ts`
- Uses the Claude Agent SDK with structured output (JSON schema)
- Inputs: terminal content (captured by `TerminalReader`), event metadata, agent persona/instructions
- Output: a `Decision` (action + optional response text + reason + optional notification)
- Called by `handle_ambiguous` when fast-path rules don't apply

### `TerminalReader.ts`
- Reads the current pane content via `tmux capture-pane`
- Parses it into a `TerminalState`: `waiting | permission_prompt | processing | context_limit | idle`
- Detects "spinner present" / "permission selection focused" / "context bar percentage"
- Provides both raw text and the structured state

### `TerminalScreenshot.ts`
- Optional Puppeteer-based PNG screenshot of the rendered tmux pane
- Used as auxiliary input for the LLM when text capture is ambiguous
- Skipped silently if Puppeteer/Chromium isn't installed

### `TerminalWatchdog.ts`
- Polls every `intervalMs` (~30s default)
- If the pane looks idle/stalled for `quorum` consecutive checks, calls `LLMDecisionMaker` for a verdict
- Skips during active spinners to avoid false positives
- On verdict "stalled": injects a nudge prompt or sends a Telegram notification

### `HookServer.ts`
- Standalone Express server on port 9999 (configurable)
- Single route: `POST /api/hooks/:agentId`
- Normalizes Claude Code hook payloads (PreToolUse, PostToolUse, SessionStart, SessionEnd, UserPromptSubmit, etc.) into a unified `ProcessedHookEvent`
- Calls registered handlers (registered by `AgentManager.onEvent()`)

### `HookConfigGenerator.ts`
- Writes hook entries to `.claude/settings.json` inside a connected project
- Each entry is a `curl` POST to `http://127.0.0.1:9999/api/hooks/:agentId`
- Called when an agent is connected to a project; cleaned up on disconnect

### `TelegramBot.ts`
- One per agent (only if `telegramToken` set in agent config)
- Uses grammY with long polling
- **Free text** → triggers `QueryProvider` (LLM consultation with terminal context)
- **`/tell <text>`** → injects raw text into the terminal pane
- **`/approve` / `/reject`** → respond to a pending approval request
- Sends notifications on errors, stalls, permission prompts, milestones

### `AgentStateManager.ts`
- Persists agent configs to `~/.claude-orka/agents.json`
- Each agent has: `id`, `name`, `description`, `model`, `temperature`, `systemPrompt`, `telegramToken`, `telegramChatId`, `connection` (project + session), `status`, `watchdogConfig`, …
- Singleton, lazy-init

### `mcp/`
- MCP server exposing terminal tools (read, write, screenshot) to the agent's LLM
- Lets the LLM inspect the terminal richly instead of just receiving capture text

## Lifecycle

1. **Create agent** — Through the Web UI's Agent Canvas page (`/agents`). Stored via `AgentStateManager.createAgent()`.
2. **Connect to a project** — Choose a project + a Claude session. `AgentManager.connectProject()` writes hook entries to `.claude/settings.json`.
3. **Start daemon** — `AgentManager.startAgent()` spins up an `AgentDaemon`, which initializes the watchdog and (optionally) the Telegram bot.
4. **Events flow** — Every Claude action in that project hits the hook server → routed to the daemon → state machine → decision → execution.
5. **Stop / disconnect** — `stopAgent()` tears down the daemon; `disconnectProject()` removes hook entries from `.claude/settings.json`.

## Configuration

Each agent supports:

- **`model`** — Claude model used by `LLMDecisionMaker` (e.g. `claude-haiku-4-5`, `claude-sonnet-4-6`).
- **`temperature`** — LLM temperature.
- **`systemPrompt`** — Persona / behavior instructions.
- **`telegramToken` + `telegramChatId`** — Optional Telegram integration.
- **`watchdogConfig`** — `intervalMs`, `quorum`, `enabled`.
- **`fastPathRules`** — Optional list of tool patterns to auto-approve.

Configs are stored at `~/.claude-orka/agents.json`. Edit via the Web UI's Agent Canvas (right-click a node).

## Logs

- In-memory ring buffer per agent (`AgentLogEntry[]` in `AgentManager.agentLogs`)
- View live in the Web UI (Agent Logs modal)
- Levels: `info`, `warn`, `error`, `debug`, `action`
- Cleared on `clearLogs()`; not persisted across server restarts

## Safety

- **Cooldowns** — After each LLM-driven action, the daemon pauses for a short cooldown to avoid feedback loops.
- **Watchdog quorum** — A "stalled" verdict needs N consecutive checks to agree before action is taken.
- **Spinner skip** — Watchdog skips checks while the pane shows a spinner (Claude is working).
- **Fast-path first** — Deterministic decisions are preferred over LLM calls (cheaper + safer).
- **Per-project hooks** — Hook entries are scoped to one project; agents don't cross-fire.

## API surface

Routes at `/api/agents`:

```
GET    /api/agents               — List
POST   /api/agents               — Create
GET    /api/agents/:id           — Read
PUT    /api/agents/:id           — Update
DELETE /api/agents/:id           — Delete
POST   /api/agents/:id/start     — Start daemon
POST   /api/agents/:id/stop      — Stop daemon
POST   /api/agents/:id/connect   — Connect to project (writes hooks)
POST   /api/agents/:id/disconnect — Disconnect (removes hooks)
GET    /api/agents/:id/logs      — Recent logs
DELETE /api/agents/:id/logs      — Clear logs
```

## Implementation file index

| File | Role |
|---|---|
| `src/agent/AgentManager.ts` | Orchestrator |
| `src/agent/AgentDaemon.ts` | Per-agent runtime |
| `src/agent/AgentStateManager.ts` | Persistence |
| `src/agent/EventStateMachine.ts` | Decision pipeline |
| `src/agent/LLMDecisionMaker.ts` | Claude SDK integration |
| `src/agent/TerminalReader.ts` | tmux capture + parsing |
| `src/agent/TerminalScreenshot.ts` | Puppeteer screenshots |
| `src/agent/TerminalWatchdog.ts` | Stall detection |
| `src/agent/HookServer.ts` | Hook intake (Express) |
| `src/agent/HookConfigGenerator.ts` | Writes `.claude/settings.json` hooks |
| `src/agent/TelegramBot.ts` | Per-agent grammY bot |
| `src/agent/mcp/` | MCP server exposing terminal tools |
| `src/web-ui/src/pages/AgentCanvasPage.tsx` | Web UI canvas |
| `src/web-ui/src/components/agent/` | Canvas nodes, modals, edges |
| `src/server/api/agents.ts` | HTTP routes |
