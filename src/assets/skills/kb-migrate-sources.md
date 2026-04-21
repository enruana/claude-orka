# KB Upgrade & Migrate

Upgrade an existing Knowledge Base to support the latest Orka features. Run this skill after any Orka version upgrade to ensure the KB structure is current.

---

## Changelog

### v0.11.0 — Project entities + project statuses
- New entity type `project` (prefix `prj-`) for features, epics, workstreams
- Projects replace `artifact` for things being actively worked on
- New statuses: `active`, `in-progress`, `blocked`, `pending`, `review`, `draft`, `resolved`, `archived`
- Knowledge Graph UI shows project selector bar with colored status dots
- Selecting a project filters graph + guide panel to show only related entities

### v0.10.5 — Source traceability
- All entities should have `source_path` property (file reference) and/or `sourced-from` edge
- Skills enforce source tracking on new entities
- Detail panel shows "Sources" section and "Quick Access" links to files

### v0.10.0 — Knowledge Base system
- Initial KB system with event log, entity store, views
- Entity types: `decision`, `question`, `meeting`, `milestone`, `direction`, `person`, `repo`, `artifact`, `context`
- Skills: `/kb-track`, `/kb-context`, `/kb-ingest`, `/kb-status`

---

## How to run a full migration

### Step 1: Diagnose current state

```bash
orka kb list --type project
orka kb list --type artifact
orka kb list --type decision
orka kb list --type question
orka kb list --type meeting
orka kb list --type person
```

Review each section below and apply what's missing.

---

### Step 2: Source traceability (v0.10.5)

**Goal:** Every entity should trace back to where the information came from.

**Check:** For each decision, question, milestone, direction — does it have:
- A `source_path` property? (file path to the source document)
- A `sourced-from` edge? (link to the meeting or artifact entity)

**Fix missing sources:**

1. List meetings to get their IDs and `notes_path`:
```bash
orka kb list --type meeting
```

2. For each entity with a `source` text property (e.g. `"source": "Sprint planning 2026-04-20"`) but no `sourced-from` edge, match it to the meeting and link:
```bash
orka kb link <entity-id> sourced-from <meeting-id>
orka kb update <entity-id> --property source_path="<meeting-notes-path>"
```

3. For entities without any source info:
- Check `history` timestamps to guess origin
- Check tags for hints (`onboarding`, `sprint`, etc.)
- If unclear: `orka kb update <id> --property source="unknown — needs review"` and add tag `needs-source`

4. For people — check if profile folder exists in `02-people/<slug>/`:
```bash
orka kb update per-xxx --property profile_path="02-people/person-slug/"
```

---

### Step 3: Create project entities (v0.11.0)

**Goal:** Features, epics, and workstreams should be `project` type, not `artifact`.

**Check:** `orka kb list --type artifact` — identify which are projects vs reference docs.

**Rule of thumb:**
- Has a folder in `03-projects/`? → **project**
- Is a PRD, epic, or feature being built? → **project**
- Is a reference doc, spec, or knowledge article? → stays as **artifact**

**Create project for each feature/epic:**
```bash
orka kb add project "Feature Name" \
  --status <active|in-progress|pending|blocked|review|draft> \
  --property path="03-projects/active/feature-slug/" \
  --property description="What this achieves" \
  --property owner="person-name" \
  --property target_release="2026-06" \
  --tag feature
```

**Available project statuses:**

| Status | When to use |
|--------|-------------|
| `active` | Being worked on now |
| `in-progress` | Development underway |
| `blocked` | Waiting on a dependency or blocker |
| `pending` | Queued, not started yet |
| `review` | In review, QA, or approval |
| `draft` | Planning/design phase |
| `resolved` | Done, shipped |
| `archived` | Closed, for historical reference |

---

### Step 4: Link everything to projects (v0.11.0)

**Goal:** Every related entity should link to its project via edges.

For each project, find and link its related entities:

```bash
# PRDs and specs → part-of
orka kb link art-xxx part-of prj-xxx

# Decisions → part-of
orka kb link dec-xxx part-of prj-xxx

# Questions → part-of
orka kb link qst-xxx part-of prj-xxx

# Milestones → part-of
orka kb link mil-xxx part-of prj-xxx

# People → assigned-to
orka kb link per-xxx assigned-to prj-xxx

# Repos → part-of
orka kb link rep-xxx part-of prj-xxx

# Direction it implements → implements
orka kb link prj-xxx implements dir-xxx
```

---

### Step 5: Archive migrated artifacts (v0.11.0)

If an artifact was converted to a project entity, archive the old one:
```bash
orka kb update art-xxx --status archived --property migrated_to="prj-xxx"
```

---

### Step 6: Archive completed projects (v0.11.0)

Projects that are done or cancelled:
```bash
orka kb update prj-xxx --status archived \
  --property archived_reason="shipped in June release" \
  --property archived_date="2026-06-15"
```

---

## Verification checklist

After migration, verify:

```bash
# Projects exist
orka kb list --type project
# Expected: each feature/epic is a project entity with correct status

# Source traceability
orka kb show <any-decision-id>
# Expected: has source_path property + sourced-from edge

# Project relationships
orka kb show <any-project-id>
# Expected: has part-of edges from decisions, questions, milestones
```

In the Knowledge Graph UI:
- [ ] Project selector bar shows projects with colored status dots
- [ ] Clicking a project highlights only its related entities
- [ ] Guide panel filters to show only that project's items
- [ ] Detail panel shows "Sources" section with clickable file links
- [ ] Detail panel shows "Quick Access" for paths and URLs

---

## Entity types reference

| Type | Prefix | What it is | Example |
|------|--------|-----------|---------|
| `project` | `prj-` | Feature, epic, workstream | "Top 5 Contacts Card" |
| `decision` | `dec-` | Choice made | "Use PostgreSQL" |
| `question` | `qst-` | Open item | "How to handle auth?" |
| `meeting` | `mtg-` | Meeting with notes | "Sprint Planning 2026-04-20" |
| `milestone` | `mil-` | Deadline or target | "June release cycle" |
| `direction` | `dir-` | Strategic direction | "Team Brain — AI/RISE" |
| `person` | `per-` | Team member | "Felipe Mantilla" |
| `repo` | `rep-` | Code repository | "rise" |
| `artifact` | `art-` | Document, spec, reference | "Real Estate Fundamentals" |
| `context` | `ctx-` | Context note, learning | Conversation summary |

## Relationships reference

| Relation | Meaning | Common usage |
|----------|---------|-------------|
| `part-of` | Belongs to a project | `dec-xxx part-of prj-xxx` |
| `assigned-to` | Person works on project | `per-xxx assigned-to prj-xxx` |
| `implements` | Project implements direction | `prj-xxx implements dir-xxx` |
| `sourced-from` | Info came from this source | `dec-xxx sourced-from mtg-xxx` |
| `decided-at` | Decision made at meeting | `dec-xxx decided-at mtg-xxx` |
| `raised-at` | Question raised at meeting | `qst-xxx raised-at mtg-xxx` |
| `relates-to` | Generic connection | `per-xxx relates-to per-yyy` |
| `supersedes` | Replaces previous entity | `dec-new supersedes dec-old` |
| `blocks` | Blocks another entity | `qst-xxx blocks mil-xxx` |
| `depends-on` | Depends on another entity | `prj-xxx depends-on prj-yyy` |
