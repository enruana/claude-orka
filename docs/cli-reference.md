# Orka CLI Reference

Complete reference for every `orka` command. Generated from the source in `src/cli/commands/` for v0.13.0.

> Use `orka --help` or `orka <command> --help` for inline help.

## Global

```
orka [command] [options]
orka --version
orka --help
```

---

## `orka start`

Start the Orka web server and UI.

```
orka start [options]
```

| Option | Default | Description |
|---|---|---|
| `-p, --port <port>` | `3456` | Port to bind |
| `--no-open` | — | Do not open browser automatically |
| `--cert <path>` | — | Path to SSL cert file (enables HTTPS) |
| `--key <path>` | — | Path to SSL private key file (required with `--cert`) |
| `--http` | — | Force HTTP even if SSL certs are detected in `~/.orka/certs/` |

If `--cert`/`--key` are not provided and `--http` is not set, `orka start` auto-detects any `*.crt` + matching `*.key` pair in `~/.orka/certs/` and starts HTTPS.

---

## `orka prepare`

Install and configure system dependencies. Idempotent — safe to re-run.

```
orka prepare [options]
```

| Option | Description |
|---|---|
| `-y, --yes` | Skip confirmation prompts |

Installs (with platform-specific package managers): tmux, ttyd, ffmpeg, cmake, Whisper (build + base model), xclip (Linux only), Tailscale, Puppeteer + Chromium. Creates `~/.orka/certs/` and (if Tailscale is installed and logged in) prints the commands to generate an HTTPS cert.

---

## `orka init`

Create `.claude-orka/` structure in the current directory.

```
orka init
```

Creates `state.json`, copies the tmux theme, and registers the project in `~/.orka/config.json`.

---

## `orka doctor`

Check system dependencies and configuration.

```
orka doctor
```

Reports the status of: Node version, tmux, claude CLI, ttyd, project init, write permissions, `.claude` dir, ffmpeg, make, cmake, Whisper binary, Whisper model, Puppeteer, **Tailscale**, **SSL certs**.

Exit code: 1 if any critical check fails.

---

## `orka status`

Show project status and all sessions.

```
orka status [options]
```

| Option | Description |
|---|---|
| `-j, --json` | Output as JSON |

---

## `orka session …`

Manage Claude sessions.

### `orka session create [name]`

| Option | Description |
|---|---|
| `--no-terminal` | Do not open a terminal window |
| `-c, --continue` | Continue from an existing Claude session (interactive selector) |
| `--from <session-id>` | Continue from a specific Claude session ID |

### `orka session list`

| Option | Description |
|---|---|
| `-s, --status <status>` | Filter by status (`active`, `saved`) |
| `-j, --json` | Output as JSON |

### `orka session get <session-id>`

| Option | Description |
|---|---|
| `-j, --json` | Output as JSON |

### `orka session resume [session-id]`

Resume a saved session. If no `session-id` is provided, an interactive picker opens.

| Option | Description |
|---|---|
| `--no-terminal` | Do not open a terminal window |

### `orka session close <session-id>`

Close a session, preserving it for later resume.

### `orka session delete <session-id>`

Permanently delete a session.

---

## `orka fork …`

Manage conversation forks (a fork is an extra pane in a session's tmux session running `claude session resume` with the parent's id).

### `orka fork create <session-id> [name]`

| Option | Description |
|---|---|
| `-v, --vertical` | Split vertically instead of horizontally |

### `orka fork list <session-id>`

| Option | Description |
|---|---|
| `-s, --status <status>` | Filter by status (`active`, `saved`, `merged`) |
| `-j, --json` | Output as JSON |

### `orka fork resume <session-id> <fork-id>`

### `orka fork close <session-id> <fork-id>`

### `orka fork delete <session-id> <fork-id>`

---

## `orka merge …`

Merge a fork's work back into its parent.

### `orka merge export <session-id> <fork-id>`

Send a prompt to the fork's Claude asking it to write a summary export to `.claude-orka/exports/fork-{id}.md`.

### `orka merge do <session-id> <fork-id>`

Send the export file contents as a prompt to the parent. Requires an export to exist.

### `orka merge auto <session-id> <fork-id>`

Run export + do automatically.

| Option | Default | Description |
|---|---|---|
| `-w, --wait <ms>` | `15000` | Wait time for Claude to complete the export before merging |

---

## `orka telegram …`

Telegram bot utilities. Used to test and configure per-agent bots.

### `orka telegram test --token <token> --chat <id>`

Send a test message to verify the bot works.

### `orka telegram chat-id --token <token>`

Detect your chat ID from recent `/start` messages sent to the bot.

---

## `orka git-account`

Switch the SSH key used by ssh-agent for git pushes. Interactive picker over `~/.ssh/`.

```
orka git-account
```

Removes any keys currently in the agent and adds only the selected one.

---

## `orka aws-account`

Switch the active AWS profile.

```
orka aws-account [options]
```

| Option | Description |
|---|---|
| `--setup` | Install shell integration (sources a snippet from `~/.aws/orka-current-profile`) to auto-export `AWS_PROFILE` on new shells |

Without `--setup`, opens an interactive picker over profiles in `~/.aws/credentials`.

---

## `orka kb …`

Knowledge Base operations. See [docs/knowledge-base.md](knowledge-base.md) for a conceptual overview and `.claude/skills/kb-guide.md` for the deep technical guide.

### `orka kb init`

Initialize a KB in the current project. Installs Claude Code skills in `.claude/skills/`.

| Option | Description |
|---|---|
| `--skip-skills` | Do not install skills |

### `orka kb add <type> <title>`

Add an entity. Valid types: `decision`, `question`, `meeting`, `milestone`, `direction`, `goal`, `initiative`, `project`, `task`, `spike`, `bug`, `person`, `repo`, `artifact`, `context`, `activity`.

| Option | Description |
|---|---|
| `-s, --status <status>` | Entity status (default depends on type) |
| `-p, --property <kv...>` | Properties as `key=value` pairs |
| `-t, --tag <tags...>` | Tags |
| `-l, --link <links...>` | Links as `relation:target-id` |
| `--strict` | Reject on validation errors (clean v2 KBs) |
| `--draft` | Allow validation issues, log as warnings (default) |
| `--actor <actor>` | Actor for event log (default: `cli`) |
| `--skill <name>` | Mark entity as generated by a skill (auto-creates activity + edge) |
| `--session <id>` | Optional session id for the skill run |
| `--json` | Output as JSON |

### `orka kb update <id>`

| Option | Description |
|---|---|
| `-s, --status <status>` | New status |
| `--title <title>` | New title |
| `-p, --property <kv...>` | Properties to set |
| `-t, --tag <tags...>` | Tags to add |
| `--remove-tag <tags...>` | Tags to remove |
| `--strict` / `--draft` | Validation mode |
| `--actor <actor>` | Actor for event log |
| `--json` | Output as JSON |

### `orka kb link <source> <relation> <target>`

Create an edge.

| Option | Description |
|---|---|
| `--strict` / `--draft` | Validation mode |
| `--actor <actor>` | Actor for event log |
| `-q, --qualifier <kv...>` | Edge qualifiers (e.g. `role=reviewer confidence=0.8`) |
| `--note <text>` | Short freeform note |
| `--confidence <n>` | Confidence (0..1) |
| `--role <role>` | Role qualifier |

### `orka kb show <id>`

Display an entity with its edges.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

### `orka kb list`

| Option | Description |
|---|---|
| `--type <type>` | Filter by type |
| `--status <status>` | Filter by status |
| `--tag <tag>` | Filter by tag |
| `--json` | Output as JSON |

### `orka kb history <id>`

Show event history for an entity.

### `orka kb timeline`

| Option | Default | Description |
|---|---|---|
| `--since <date>` | — | Show events since `YYYY-MM-DD` |
| `--limit <n>` | `30` | Limit number of events |

### `orka kb types`

Show the type registry — valid types, their id prefixes, and statuses.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

### `orka kb relations`

Show the relation vocabulary with type constraints.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

### `orka kb classify <id>`

Suggest a tier reclassification for an entity (heuristic-based).

| Option | Description |
|---|---|
| `--json` | Output as JSON |

### `orka kb reclassify <id> <newType>`

Change an entity's type — also rewrites the id prefix and migrates all referencing edges.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

### `orka kb upgrade`

Migrate a v1 KB to v2 schema (types, statuses, relations, qualifiers).

| Option | Description |
|---|---|
| `--dry-run` | Compute the plan without applying |
| `--apply` | Apply the migration (backup is taken automatically) |
| `--json` | Output the plan as JSON |

### `orka kb lint`

Audit the KB for missing source, missing description, off-spec statuses, deprecated relations.

| Option | Description |
|---|---|
| `--type <type>` | Filter to a specific entity type |
| `--fix` | Apply automatic fixes where safe (status normalization) |
| `--json` | Output as JSON |

### `orka kb skills-sync`

Re-install / update Claude Code skills in `.claude/skills/` from the current Orka package version.

| Option | Description |
|---|---|
| `--dry-run` | Show what would change without writing |
| `--diff` | Show content-diff summary per skill |

### `orka kb graph`

Export the knowledge graph.

| Option | Default | Description |
|---|---|---|
| `--format <format>` | `dot` | `dot` or `json` |

### `orka kb context`

Output AI-optimized project context (curated subset of the KB for prompting).

| Option | Default | Description |
|---|---|---|
| `--project <id>` | — | Filter to a specific project entity |
| `--breadth <b>` | `medium` | `narrow` | `medium` | `wide` |

### `orka kb project-doc <id>`

Generate or update the master `INDEX.md` for a project.

| Option | Default | Description |
|---|---|---|
| `--breadth <b>` | `medium` | Traversal breadth |

### `orka kb sync`

Rebuild entities and views from the event log (`events.jsonl`).

### `orka kb migrate`

Bootstrap KB from existing project artifacts (git history, docs).

### `orka kb ingest <file>`

Parse a file and extract entities (basic structural parsing).
