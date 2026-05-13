# Knowledge Base

The Knowledge Base (KB) is Orka's per-project memory: a typed graph of decisions, tasks, spikes, bugs, meetings, people, repos, and more. It lives in `.claude-orka/.orka-kb/` inside each project and is designed to be both human-readable (you can edit JSON if needed) and AI-readable (Claude consumes it through skills and the `orka kb context` command).

This page is the **human-facing overview**. For the deep technical guide that Claude itself uses, see `.claude/skills/kb-guide.md`.

## What it tracks

The KB is organized in three tiers:

### Knowledge tier — what we know
- `decision` — ADR-style choices ("we use Postgres because…")
- `question` — open or answered questions
- `meeting` — meeting notes
- `milestone` — significant project moments
- `direction` — strategic guidance

### Work tier — what we're doing
- `goal` — high-level objectives
- `initiative` — bodies of work that span multiple projects
- `project` — concrete projects
- `task` — concrete actions
- `spike` — time-boxed investigations
- `bug` — defects

### Reference tier — supporting context
- `person` — people involved
- `repo` — code repositories
- `artifact` — files, docs, urls
- `context` — background information

Plus `activity` — provenance entries automatically generated when an action happens (e.g. "this entity was created by the kb-track skill in session X").

Entities have a **status** (lifecycle stage like `active`, `in-progress`, `done`, `archived`, …) and are linked via **edges** — typed relations like `decides`, `addresses`, `blocks`, `references`, `owns`, `mentions`. Edges can have qualifiers (`role`, `confidence`, `note`).

## Storage

```
.claude-orka/
  .orka-kb/
    events.jsonl   ← append-only event log (source of truth)
    entities/      ← materialized JSON, one file per entity id
    edges/         ← materialized JSON, one file per edge
    views/         ← generated views — context.md, timeline.md, INDEX.md per project
```

Everything in `entities/`, `edges/`, and `views/` is derived from `events.jsonl`. If anything gets out of sync, `orka kb sync` rebuilds them.

## How to use it

### From the CLI

```bash
# Initialize (also installs Claude Code skills into .claude/skills/)
orka kb init

# Add entities
orka kb add decision "Use PostgreSQL for primary storage" \
  -p rationale="ACID, mature, team familiarity" \
  -t database -t architecture

orka kb add task "Migrate users table to UUIDs" --status in-progress

# Link them
orka kb link task-001 implements decision-001

# Explore
orka kb list --type decision
orka kb list --status active
orka kb show decision-001
orka kb timeline --since 2026-04-01
orka kb history task-001

# Audit
orka kb lint
orka kb lint --fix   # auto-normalize statuses
orka kb classify entity-id   # heuristic suggestion to retype

# Migrations
orka kb upgrade --dry-run   # plan a v1→v2 migration
orka kb upgrade --apply     # apply (backup taken)

# Export
orka kb graph --format dot > kb.dot
orka kb context --project project-001 --breadth medium
orka kb project-doc project-001   # generate/update INDEX.md
```

Every flag for every subcommand is in [cli-reference.md](cli-reference.md).

### From the Web UI

Open `http://localhost:3456/projects/<encoded-path>/kb` or click "KB" in the project view. You'll see:

- **Graph view** — circular layout with concentric shells. Projects/initiatives form the nucleus; tasks/spikes/bugs orbit closer; people/repos/artifacts on the fringe. Click an entity to inspect.
- **Left guide panel** — entities grouped by type and then by status (Active / In Progress / Pending / Done). Click a project to filter the graph to that project.
- **Right detail panel** — metadata, edges (forward + backlinks), history, and action buttons (e.g. "Send to Claude").
- **Top timeline** — daily/weekly activity with color-coded segments per type.

### From Claude (in a session)

Once a project has a KB initialized (`orka kb init`), Claude Code automatically has access to the KB skills in `.claude/skills/`. Claude can:

- Load project context at session start (`kb-context`, `kb-project-context`)
- Track work as you do it (`kb-track`, `kb-ingest`)
- Classify entities (`kb-classify`)
- Maintain consistency (`kb-lint`)
- Update master project docs (`kb-project`)

You don't need to invoke skills explicitly — Claude triggers them based on the user prompt.

## API

Programmatic access via `/api/kb/*` (see CLAUDE.md for the full list of endpoints). The Web UI uses these; you can too:

```
GET    /api/kb/status?project=<base64>          — KB initialization status
GET    /api/kb/entities?project=…&type=…        — List entities
GET    /api/kb/entities/:id?project=…           — Get one
POST   /api/kb/entities?project=…               — Create
PATCH  /api/kb/entities/:id?project=…           — Update
POST   /api/kb/edges?project=…                  — Create edge
GET    /api/kb/timeline?project=…&since=…       — Event timeline
GET    /api/kb/graph?project=…                  — Full graph (entities + edges)
GET    /api/kb/context?project=…&breadth=…      — AI-optimized context
POST   /api/kb/project-doc/:id?project=…        — Regenerate project INDEX.md
POST   /api/kb/sync?project=…                   — Rebuild from event log
```

## Validation modes

Every write goes through the validator in `src/models/kb-validator.ts`:

- **`--strict`** — Reject on validation errors. Use for clean v2 KBs.
- **`--draft`** — Allow validation issues, log warnings. Default; good for incremental migration from older states.
- **off** — Used internally for migrations; not exposed in CLI.

If `orka kb lint` is happy, you're in good shape.

## Migrating from v1

v0.13.0 ships KB schema v2 with proper type tiers, validated statuses, and a relation vocabulary. If your KB was created on an older Orka version:

```bash
orka kb upgrade --dry-run   # see what would change
orka kb upgrade --apply     # apply; events.jsonl is backed up first
```

The migrator handles type renames, status normalization, relation vocabulary updates, and qualifier extraction. After the migration, run `orka kb lint --fix` and `orka kb sync`.

## Implementation references

- `src/models/kb-registry.ts` — Type catalog (label, prefix, valid statuses, default status)
- `src/models/kb-validator.ts` — Schema validation
- `src/core/KnowledgeBaseManager.ts` — CRUD + event log
- `src/core/kb-migrator.ts` — v1→v2 migration planner
- `src/core/kb-traversal.ts` — `weightedTraversal`, `BREADTH_PRESETS` used by `kb context`
- `src/cli/commands/kb.ts` — CLI surface (24 subcommands)
- `src/server/api/kb.ts` — HTTP API
- `src/web-ui/src/components/kb/` — Graph, timeline, panels
- `.claude/skills/kb-*.md` — Claude Code skills (auto-loaded)
- `src/assets/skills/kb-*.md` — Source of those skills (used by `orka kb skills-sync`)
