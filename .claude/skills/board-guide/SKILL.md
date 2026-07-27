---
name: board-guide
description: Master reference for Orka Board sessions — Jira-integrated Kanban boards with a master sync terminal and per-task Claude terminals. Load when working inside a board master or a task-terminal, before running orka board commands, or when unsure how the board flow fits together.
---

# Orka Board — Complete Guide

Orka Board sessions turn a Jira board into a local Kanban where each task in "In Progress" gets its own tmux + Claude session. The board is fully agentic — a **master terminal** pulls tickets from Jira via a configurable sync prompt, and **task terminals** own everything from worktree creation through PR + Jira write-back.

---

## Storage

Each Board session persists under the owning project:

```
<project>/.claude-orka/.boards/
  index.json                       # {boards: [{id, name, jiraUrl, createdAt}]}
  <boardId>/
    config.json                    # jiraUrl, jql, columns, syncPromptId, lastSyncedAt, schemaVersion
    tasks.json                     # BoardTask[]
    events.jsonl                   # append-only audit
    pending-drift.json             # [{taskKey, fromStatus, toStatus, detectedAt}]
    attachments/<taskKey>/         # comments/docs pulled from Jira
```

Never touch these files directly — use the `orka board` CLI so schema stays valid and the event log stays consistent.

---

## BoardTask schema (rigid)

```
BoardTask {
  key: string                      # PROJ-123 — the Jira issue key
  title: string
  description?: string
  status: string                   # one of BoardState.columns
  priority?: string
  assignee?: string
  reporter?: string
  labels?: string[]
  jiraUrl: string                  # canonical URL to the Jira issue
  kbEntityId?: string              # linked Orka KB entity (set on task start)
  terminalPaneId?: string          # tmux pane of the task-terminal (if alive)
  ttydPort?: number                # ttyd port of the task-terminal
  worktreePath?: string            # git worktree created by moxikit
  branchName?: string
  createdAt: string
  updatedAt: string
  raw?: object                     # full Jira issue dump for custom fields
}
```

Default `BoardState.columns`: `['todo', 'in-progress', 'review', 'done']`. Custom columns can be added per board.

---

## The two terminals

### Master terminal (one per board, always alive)
- tmux session: `orka-board-master-<boardId>`
- Runs a persistent `claude --session-id <uuid>` — full SessionView (Terminal, Code, Files, Knowledge tabs).
- **Read-only against Jira.** Never writes back.
- Responsibilities: pull tickets, pull comments, pull docs, detect drift, link everything to local tasks via `orka board update-task` / `attach-comment` / `attach-doc`.
- Triggered manually: user pulses "Sync" in the UI → server sends `sync` to the master pane → master executes the `board-sync` skill.

### Task terminal (one per task at status ≥ in-progress)
- tmux session: `orka-board-task-<taskKey>`
- Runs a persistent `claude --session-id <uuid>` — full SessionView.
- **Only writer to Jira for this task.** PRs, comments, status transitions all flow from here.
- Boot: server spawns tmux+ttyd+claude and sends the init template prompt. The init skill (`board-task-init`) explains the boot ritual.
- Shutdown: user drags card to Done or triggers close-task → close template prompt runs (`board-task-close`).

---

## CLI surface — `orka board`

Board lifecycle:
```
orka board create --project <path> --name <n> --jira-url <url> [--jql "..."]
orka board list [--project <path>]
orka board delete --board <id>
```

Task CRUD (schema-enforced):
```
orka board add-task --board <id> --key PROJ-123 --title "..." --status todo [--assignee ...] [--priority ...] [--labels a,b]
orka board update-task --board <id> --key PROJ-123 [--status ...] [--kb-entity <id>] [--worktree-path <p>] [--branch-name <b>] [--title ...]
orka board remove-task --board <id> --key PROJ-123
orka board list-tasks --board <id> [--status ...]
orka board show-task --board <id> --key PROJ-123
```

Task-terminal lifecycle:
```
orka board start-task --board <id> --key PROJ-123 [--template full|spike|<custom>]
orka board close-task --board <id> --key PROJ-123 [--template close-default|<custom>]
```

Sync + drift:
```
orka board sync --board <id>                            # asks the master to run its sync
orka board mark-drift --board <id> --key PROJ-123 --from <s> --to <s>
orka board ack-drift  --board <id> --key PROJ-123
```

Attachments (used by the master during sync):
```
orka board attach-comment --board <id> --key PROJ-123 --author "..." --body "..."
orka board attach-doc     --board <id> --key PROJ-123 --path <file>
```

Every mutation appends an event to `events.jsonl`, so history and drift detection stay honest.

---

## Knowledge Base link (bidirectional)

- Every task creates **at most one** KB entity per `jira_key` — never
  duplicate. Task-terminals must run the "look for an existing entity
  FIRST" step from `board-task-init` before adding, so reopens and
  cross-session spawns retake the same entity + its full context
  (overview.html + changelog + prior updates).
- The KB entity carries `properties.jira_key`, `properties.jira_url`,
  `properties.board_id`, and (when known) `properties.worktree_path`
  + `properties.branch_name` + `properties.path` + `properties.master_doc`.
- `BoardTask.kbEntityId` stores the KB entity id — that's the local link
  back. If it's set on the BoardTask, load that entity directly instead
  of grepping by `jira_key`.
- Use the KB as the durable memory: PRs opened, decisions made, blockers
  found — all logged as KB updates via `orka kb update <id> ...`.
- On close, KB entity flips to `status: done`, PR url captured as a
  property, and any decisions get their own `decision` entities linked
  via `resulted_in` edges.

See the `kb-guide` skill for KB shape details, `kb-project` for the
folder / tier convention, and `kb-track` for the capture flow.

---

## Sync (Jira → local) and drift

Sync is **manual, not polled**. When the user hits "Sync":
1. Server sends `sync` to the master's tmux pane.
2. Master runs the `board-sync` skill — auth + pull + diff + write via `orka board` commands.
3. Any Jira ticket whose remote status differs from local (and does not have an active task-terminal justifying the transition) is flagged as **drift** via `orka board mark-drift`.
4. UI shows drift badges on affected cards. User acks or opens a terminal from the badge.

Never auto-start a task-terminal from a drift event — always let the user decide.

---

## When to load related skills

- `board-sync` → the master is about to run the sync ritual (Jira pull, apply diff, mark drift).
- `board-task-init` → a new task-terminal just started and is running its boot ritual.
- `board-task-close` → a task-terminal is running its close ritual.
- `board-jira-api` → any of the above needs the Jira REST endpoint / auth cheatsheet.
- `kb-track` / `kb-project` → when creating or updating KB entities linked to tasks.
