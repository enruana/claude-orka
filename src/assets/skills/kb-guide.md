# Orka KB v2 — Complete Guide

Master reference for the Orka Knowledge Base v2. Read this to understand types, statuses, relations, validation, traversal, and the full CLI/skill surface.

> Schema version: **v2** (2026-05). Workspaces created on v1 still work; run `orka kb upgrade` to migrate to v2 fully.

---

## Architecture

Three-layer file-based system, no DB:

1. **Event log** (`.claude-orka/.orka-kb/events.jsonl`) — append-only source of truth
2. **Entity store** (`.claude-orka/.orka-kb/entities/`) — one JSON file per entity (current state, rebuildable from events)
3. **Views** (`.claude-orka/.orka-kb/views/`) — generated index, context, graph, timeline (auto-refreshed on every mutation)

---

## Three Tiers of Entities

### Work tier — *what you do*
| Type | Prefix | What | Default status |
|---|---|---|---|
| `goal` | `gol-` | Ongoing area of responsibility (PARA Area) — no deadline | `active` |
| `initiative` | `ini-` | Strategic objective spanning multiple projects (PRD, Epic) | `active` |
| `project` | `prj-` | Bounded outcome with target date (Linear-style) | `planning` |
| `task` | `tsk-` | Atomic work item, can have sub-tasks | `todo` |
| `spike` | `spk-` | Time-boxed exploration; outcome = answer/decision | `open` |
| `bug` | `bug-` | Defect | `open` |

**Rule of thumb (Linear)**: *"sub-issue when too big for one issue, too small for a project."*
- Single PR / single sitting → `task`
- Multi-PR, multi-week, has milestones → `project`
- Multi-project under a strategic umbrella → `initiative`
- Ongoing responsibility, no end date → `goal`

### Knowledge tier — *what you know*
| Type | Prefix | What | Default status |
|---|---|---|---|
| `decision` | `dec-` | ADR-style choice (MADR fields recommended) | `proposed` |
| `question` | `qst-` | Open inquiry | `open` |
| `meeting` | `mtg-` | Synchronous discussion | `scheduled` |
| `milestone` | `mil-` | Achieved state — immutable, dated | `active` |
| `direction` | `dir-` | Strategic intent / long-term horizon | `active` |

### Reference tier — *what you reference*
| Type | Prefix | What |
|---|---|---|
| `person` | `per-` | Stakeholder/contributor |
| `repo` | `rep-` | Codebase |
| `artifact` | `art-` | Document, spec, file reference |
| `context` | `ctx-` | Pre-prepared LLM briefing |

### Provenance tier
| Type | Prefix | What |
|---|---|---|
| `activity` | `act-` | PROV-O — represents a skill/agent run that produced entities |

---

## Statuses (closed enum per type)

State machines (terminal = no outgoing transitions):

- **decision**: `proposed → accepted | rejected → superseded` (immutable after accepted; supersession is the only "edit" path)
- **task**: `todo → in-progress → done | blocked | cancelled`
- **spike**: `open → in-progress → concluded | cancelled`
- **bug**: `open → investigating → fixed | wontfix | duplicate`
- **question**: `open → active → answered → resolved → closed`
- **project**: `planning → active → done | cancelled`
- **milestone**: `active → reached → archived`
- **goal/initiative/direction**: `active → archived`
- **person/repo**: `active → archived`
- **artifact**: `draft → active → archived`
- **meeting**: `scheduled → held → archived`
- **activity**: `active`

**Off-spec statuses are rejected in `--strict` mode.** Run `orka kb types` to see the registry.

---

## Relations (with type constraints)

### Hierarchy / decomposition
```
subtask-of    : task → task | spike | bug
scope-of      : task | spike → project       (Shape Up "scope")
child-of      : project → initiative
                initiative → goal
                bug → project
```

### Knowledge → work
```
addresses     : decision | project | task → question | direction
answers       : decision | artifact | meeting → question
implements    : project | task | initiative → direction | decision
```

### Knowledge ↔ meeting
```
decided-at    : decision → meeting
raised-at     : question → meeting
attended-by   : meeting → person
```

### Lifecycle
```
blocks        : work → work
depends-on    : work → work
supersedes    : decision | project | artifact → decision | project | artifact
```

### Provenance (PROV-O)
```
sourced-from  : * → meeting | artifact | context
generated-by  : * → activity
derived-from  : * → *
attributed-to : * → person
```

### Categorical
```
relates-to    : * → *      (deliberately vague)
assigned-to   : work → person
references    : * → *
owned-by      : work | repo | artifact → person
```

### Deprecated (will be migrated by `orka kb upgrade`)
```
part-of       : DEPRECATED — split into subtask-of / scope-of / child-of / sourced-from / owned-by
contributes-to: DEPRECATED — use attributed-to or assigned-to
```

Run `orka kb relations` to see the full list with descriptions.

---

## Edge Qualifiers (Wikidata pattern)

Every edge carries metadata in a `qualifiers` object:
```json
{
  "relation": "assigned-to",
  "target": "per-xxx",
  "qualifiers": {
    "at": "2026-05-05T10:00:00Z",
    "by": "skill:kb-track",
    "source": "evt-abc123",
    "confidence": 0.95,
    "role": "primary",
    "note": "owns delivery"
  }
}
```

CLI:
```bash
orka kb link <src> <relation> <tgt> --role reviewer --confidence 0.8 --note "..."
orka kb link <src> <relation> <tgt> --qualifier key=value
```

The traversal uses `confidence` to drop uncertain links; the UI displays `role`, `note`, etc. in the detail panel.

---

## CLI Commands (v2)

```bash
# Schema introspection
orka kb types                           # show all types, prefixes, valid statuses
orka kb relations                       # show relation vocabulary with constraints

# Mutation (with validation modes)
orka kb add <type> <title> [opts]       # --strict | --draft | --skill <name>
orka kb update <id> [opts]              # validates status transitions
orka kb link <src> <rel> <tgt> [opts]   # validates relation type constraints
orka kb show <id>                       # entity details + qualifiers
orka kb list [--type] [--status] [--tag]
orka kb history <id>
orka kb timeline [--since] [--limit]

# Health & migration
orka kb lint [--type <t>] [--json]      # audit: missing source, off-spec status, deprecated edges
orka kb classify <id>                   # heuristic: suggest correct tier
orka kb upgrade                         # migrate v1 → v2 (P9, coming)

# Queries
orka kb context [--project <id>] [--breadth narrow|medium|wide]
orka kb project-doc <id> [--breadth ...]
orka kb graph [--format dot|json]

# Maintenance
orka kb sync                            # rebuild entities + views from event log
orka kb migrate                         # bootstrap from git/docs (initial setup)
orka kb ingest <file>                   # register file as artifact
orka kb skills-sync [--dry-run] [--diff] # update .claude/skills/ from current Orka package version
orka kb reclassify <id> <type>          # change entity tier (e.g. project → bug)
```

### Validation modes
- `--strict` — errors throw; new clean v2 KBs should default to this
- `--draft` — errors logged as `entity.flagged` events; mutation proceeds; warning printed (default for backward-compat)

### Skills mode
When a skill creates entities, pass `--skill <name>`. This:
- Auto-creates an `activity` entity for the skill (idempotent)
- Auto-emits a `generated-by` edge satisfying the PROV-O provenance requirement
- Lets you query "all entities generated by /kb-track" cleanly

```bash
orka kb add decision "Use JWT" --skill kb-track --property description="..." --property outcome="..."
```

---

## Required vs Recommended Properties

The validator enforces required properties in `--strict`. Recommended are surfaced by `kb lint`.

### Required
- All work-tier types: `description`
- `decision`: `description`, `outcome` (the chosen option, MADR-style)
- `direction`: `description`
- `meeting`: `date`

### Recommended (`kb lint` flags missing ones)
- `goal`: `owner`, `rationale`
- `initiative`: `owner`, `target_release`
- `project`: `path`, `owner`, `target_release`, `repo_path`
- `task`: `owner`, `estimate`, `priority`
- `spike`: `question`, `time_box`, `owner`
- `bug`: `repro_steps`, `severity`, `reporter`
- `decision`: `drivers`, `options`, `consequences`, `decided_by`, `decided_at` (full MADR)
- `meeting`: `attendees`, `notes_path`
- `person`: `role`, `profile_path`
- `repo`: `stack`, `url`

---

## Skills Reference

| Skill | Purpose |
|---|---|
| `/kb-guide` | This file |
| `/kb-track` | Capture decisions, questions, directions from conversation (with --skill auto-provenance) |
| `/kb-ingest` | Extract entities from a document |
| `/kb-context` | Load full or project KB context (supports --breadth) |
| `/kb-project-context` | Deep-dive on a project + read source files |
| `/kb-status` | Quick pulse check |
| `/kb-project` | CRUD projects, tier classification |
| `/kb-lint` | Audit KB health |
| `/kb-classify` | Suggest tier for an entity |
| `/kb-migrate-sources` | Upgrade between Orka versions |

---

## Path Convention

**All paths in the KB and in generated documents MUST be relative to the project root.** Never use paths relative to the current file or absolute system paths.

- ✅ `01-journal/2026/04-april/meeting/notes.md`
- ✅ `02-people/felipe-mantilla/`
- ✅ `03-projects/active/feature-slug/`
- ❌ `../sibling/file.md`
- ❌ `/absolute/system/path`

This ensures links in INDEX.md and the Knowledge Graph file viewer resolve correctly.

---

## Project Master Document (INDEX.md)

Each project can have an auto-generated `INDEX.md` linking all related decisions, questions, milestones, people, meetings, artifacts, and sub-work-items.

```bash
orka kb project-doc <id> [--breadth narrow|medium|wide]
```

The traversal is **scored** (not uniform BFS): edges are weighted by relation type, decayed by hop distance, and filtered by confidence. Off-topic entities that share a meeting with the project no longer pollute the index.

**When to regenerate:** after any change related to the project. Skills (`/kb-track`, `/kb-ingest`) regenerate it automatically.

---

## Validation Modes & Provenance Rules

For LLM/skill actors (anything other than `cli`, `migration`, `system`):

1. Required properties enforced (description, outcome, etc.)
2. Status must be in the per-type allowed set
3. Status transitions must follow the state machine
4. Relations must match source/target type constraints
5. **At least one `sourced-from`, `generated-by`, or `derived-from` edge** must be present at creation

The `--skill <name>` flag handles the provenance edge automatically by creating/reusing an activity entity.

---

## Migration from v1

v1 KBs work in `--draft` mode (the default). To upgrade fully:

```bash
orka kb lint                    # see what needs migration
orka kb upgrade                 # apply migrations (P9 — coming soon)
```

Migration handles:
- `type: "reference"` → `artifact` with tag
- Statuses normalized (`completed` → `reached`, `answered` → `resolved`, etc.)
- Deprecated relations (`part-of`, `contributes-to`) split into typed relations based on source/target types
- Edge qualifiers backfilled from `since`/`eventRef`
- Provenance heuristics (timestamps + nearby meetings)

---

## Knowledge Graph UI

The Knowledge tab in the Orka web dashboard:

- **Timeline** (top) — events grouped by day
- **Guide panel** (left) — project selector + collapsible sections by tier and type
- **Graph canvas** (center) — force-directed, nodes colored by type, edges weighted
- **Detail panel** (right) — type-aware (MADR rendering for decisions, etc.), Quick Access, Sources, Backlinks, History
- **Health panel** (per project) — % with source, % with description, stale questions, ratio open/resolved

Selecting a project filters the graph by relevance score (using the same weighted traversal as `kb context --project`).
