# Orka KB — Complete Guide

This is the master reference for the Orka Knowledge Base system. Read this to understand how the KB works, what commands and skills are available, what changed in each version, and how to migrate between versions.

---

## What is Orka KB?

Orka KB is a project knowledge tracking system built into the Orka CLI. It captures the full lifecycle of a project — meetings, decisions, questions, people, directions, milestones, repositories, and artifacts — as a structured graph of entities connected by typed relationships.

**Architecture (3 layers):**
1. **Event Log** (`.claude-orka/.orka-kb/events.jsonl`) — append-only source of truth
2. **Entity Store** (`.claude-orka/.orka-kb/entities/`) — one JSON file per entity (current state)
3. **Views** (`.claude-orka/.orka-kb/views/`) — generated index, context, graph, timeline

Everything is file-based. No database, no server required for the KB itself.

---

## Entity Types

| Type | Prefix | What it is | Example |
|------|--------|-----------|---------|
| `project` | `prj-` | Feature, epic, workstream, task | "Top 5 Contacts Card" |
| `decision` | `dec-` | Choice made | "Use PostgreSQL for DB" |
| `question` | `qst-` | Open item needing answer | "How to handle auth?" |
| `meeting` | `mtg-` | Meeting with notes | "Sprint Planning 2026-04-20" |
| `milestone` | `mil-` | Deadline or target | "June release cycle" |
| `direction` | `dir-` | Strategic direction or initiative | "Team Brain — AI/RISE" |
| `person` | `per-` | Team member or stakeholder | "Felipe Mantilla" |
| `repo` | `rep-` | Code repository | "rise", "api.activepipe.com" |
| `artifact` | `art-` | Document, spec, reference material | "Real Estate Fundamentals doc" |
| `context` | `ctx-` | Context note, learning, summary | Conversation summary |

## Entity Statuses

| Status | Meaning | Used for |
|--------|---------|----------|
| `active` | Currently relevant / being worked on | All types |
| `in-progress` | Development underway | Projects |
| `blocked` | Waiting on a dependency | Projects, questions |
| `pending` | Queued, not started yet | Projects |
| `review` | In review or QA | Projects |
| `draft` | Planning/design phase | Projects, artifacts |
| `resolved` | Done, answered, shipped | Projects, questions, milestones |
| `superseded` | Replaced by a newer entity | Decisions |
| `archived` | Closed, for historical reference | All types |

## Relationships

| Relation | Meaning | Common usage |
|----------|---------|-------------|
| `part-of` | Belongs to a project | `dec-xxx part-of prj-xxx` |
| `assigned-to` | Person works on something | `per-xxx assigned-to prj-xxx` |
| `implements` | Project implements direction | `prj-xxx implements dir-xxx` |
| `sourced-from` | Info came from this source | `dec-xxx sourced-from mtg-xxx` |
| `decided-at` | Decision made at meeting | `dec-xxx decided-at mtg-xxx` |
| `raised-at` | Question raised at meeting | `qst-xxx raised-at mtg-xxx` |
| `relates-to` | Generic connection | `per-xxx relates-to per-yyy` |
| `supersedes` | Replaces previous entity | `dec-new supersedes dec-old` |
| `blocks` | Blocks another entity | `qst-xxx blocks mil-xxx` |
| `depends-on` | Depends on another entity | `prj-xxx depends-on prj-yyy` |

---

## CLI Commands

```bash
orka kb init                              # Initialize KB + install skills
orka kb add <type> <title> [--opts]       # Add entity
orka kb update <id> [--status] [--property] # Update entity
orka kb link <source> <relation> <target> # Create relationship
orka kb show <id>                         # Show entity details
orka kb list [--type] [--status] [--tag]  # List entities
orka kb context                           # Full KB context (AI-optimized)
orka kb context --project <id>            # Project-specific context with source files
orka kb project-doc <id>                  # Generate/update project INDEX.md
orka kb history <id>                      # Entity event history
orka kb timeline [--since] [--limit]      # Chronological events
orka kb graph [--format dot|json]         # Export graph
orka kb sync                              # Rebuild entities + views from event log
orka kb migrate                           # Bootstrap KB from git history + docs
orka kb ingest <file>                     # Register a file as artifact
```

### Common `add` options
```bash
--status <status>          # Entity status (default: active)
--property <key=value>     # Repeatable — set properties
--tag <tag>                # Repeatable — add tags
--link <relation:target>   # Repeatable — create edges on creation
--json                     # Output as JSON
```

---

## Skills Reference

| Skill | Purpose | When to use |
|-------|---------|-------------|
| `/kb-guide` | This skill — complete system reference | When you need to understand how Orka KB works |
| `/kb-track` | Capture decisions, questions, directions from conversation | After meetings, discussions, or decisions |
| `/kb-context` | Load full KB context | Start of session to get up to speed |
| `/kb-project-context` | Load project-specific context + read source files | When diving deep into a specific project |
| `/kb-ingest` | Extract entities from a document | After writing meeting notes or receiving a spec |
| `/kb-status` | Quick pulse check | Quick standup or status check |
| `/kb-project` | Register, archive, update projects | When starting/closing features or epics |
| `/kb-migrate-sources` | Upgrade KB structure between versions | After Orka version upgrade |

---

## Source Traceability Rules

**Every entity MUST have source info.** Use at minimum ONE of:
- `--property source_path="path/to/file.md"` — link to a file in the project
- `--property source="human-readable description"` — text reference
- `--link sourced-from:<entity-id>` — link to meeting/artifact entity

Prefer ALL THREE when possible. The `source_path` enables direct navigation from the Knowledge Graph UI.

---

## Project Management

Projects (`prj-` prefix) are the top-level containers. Everything links to them:

```bash
# Create a project
orka kb add project "Feature Name" \
  --status in-progress \
  --property path="03-projects/active/slug/" \
  --property repo_path="/absolute/path/to/repo" \
  --property description="What this achieves" \
  --property owner="person-name" \
  --property target_release="2026-06" \
  --tag feature

# Link related entities
orka kb link dec-xxx part-of prj-xxx
orka kb link qst-xxx part-of prj-xxx
orka kb link per-xxx assigned-to prj-xxx

# Update status as it progresses
orka kb update prj-xxx --status blocked --property blocked_by="waiting for X"
orka kb update prj-xxx --status resolved --property shipped_date="2026-06-15"
orka kb update prj-xxx --status archived --property archived_reason="shipped"
```

Key properties: `path`, `repo_path` (optional, highly recommended), `description`, `owner`, `target_release`, `status_detail`, `master_doc` (auto-generated).

### Project Master Document (INDEX.md)

Each project can have an auto-generated `INDEX.md` file that serves as the living index — linking all decisions, questions, milestones, people, meetings, and artifacts related to the project.

```bash
# Generate or update the project index
orka kb project-doc <project-id>
```

This creates `INDEX.md` inside the project's `path` folder (e.g., `03-projects/active/feature-slug/INDEX.md`) and sets the `master_doc` property on the project entity. The Knowledge Graph UI shows this as the top Quick Access link.

**When to regenerate:** After any KB change related to the project — new decisions, resolved questions, status updates. The skills `/kb-track` and `/kb-ingest` should regenerate the doc after making changes.

---

## Knowledge Graph UI

The Knowledge tab in the Orka web dashboard has:

- **Timeline bar** (top) — days grouped by week, click to see events for that day
- **Guide panel** (left) — project selector + collapsible sections (questions, decisions, milestones, etc.)
- **Graph canvas** (center) — force-directed graph with circular nodes colored by type
- **Detail panel** (right) — entity details, Quick Access links, Sources, Relationships, History
- **Actions** — "Load project context" (projects only) and "Discuss in terminal" buttons

Selecting a project in the guide panel:
- Filters the guide panel to show only project-related entities
- Dims unrelated nodes in the graph
- Opens the project detail panel

---

## Version Changelog

### v0.12.0
- Project master document: `orka kb project-doc <id>` generates `INDEX.md` inside the project folder
- `INDEX.md` is a living index linking all decisions, questions, milestones, people, meetings, artifacts
- `master_doc` property auto-set on project entities — appears as top Quick Access link in UI
- "Generate project index" / "Update project index" button in detail panel
- Skills should regenerate INDEX.md after making project-related changes

### v0.11.4
- `orka kb context --project <id>` — project-specific context with source files list
- New skill `/kb-project-context`
- Context output now includes entity properties and all navigable file paths

### v0.11.2
- `repo_path` property for projects (optional, recommended)
- Project selector moved to left guide panel
- Selecting a project opens detail panel automatically

### v0.11.0
- New entity type `project` (prefix `prj-`)
- New statuses: `in-progress`, `blocked`, `pending`, `review`
- Knowledge Graph UI project selector with colored status dots
- Project filtering in graph + guide panel

### v0.10.5
- Source traceability: `source_path`, `sourced-from` edges
- Detail panel "Sources" section + "Quick Access" links
- Skills enforce source tracking

### v0.10.0
- Initial KB system: event log, entity store, views
- Entity types: decision, question, meeting, milestone, direction, person, repo, artifact, context
- Skills: `/kb-track`, `/kb-context`, `/kb-ingest`, `/kb-status`
- CLI commands: `orka kb init/add/update/link/show/list/context/history/timeline/graph/sync/migrate/ingest`

---

## Migration Between Versions

When upgrading Orka, run `/kb-migrate-sources` to update the KB structure. That skill has step-by-step instructions for each version's changes. Key migrations:

1. **v0.10.5**: Add `source_path` and `sourced-from` edges to existing entities
2. **v0.11.0**: Convert feature/epic artifacts to `project` type, link everything with `part-of`
3. **v0.11.2**: Add `repo_path` to projects that have associated repositories
4. **v0.11.4**: No migration needed — new commands/skills only
