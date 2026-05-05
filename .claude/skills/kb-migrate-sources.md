# KB Upgrade & Migrate

Upgrade an existing Knowledge Base to support the latest Orka features. Run this after any Orka version upgrade.

For the complete system reference (entity types, statuses, relationships, CLI commands, skills), see `/kb-guide`.

---

## Step 1: Diagnose

```bash
orka kb list --type project
orka kb list --type artifact
orka kb list --type decision
orka kb list --type question
orka kb list --type meeting
orka kb list --type person
```

---

## Step 2: Source traceability (v0.10.5+)

Every entity should have `source_path` property and/or `sourced-from` edge.

```bash
# List meetings to get IDs and notes_path
orka kb list --type meeting

# For each entity missing source, match to its meeting and link
orka kb link <entity-id> sourced-from <meeting-id>
orka kb update <entity-id> --property source_path="<meeting-notes-path>"

# For entities with no source at all
orka kb update <id> --property source="unknown — needs review" --tag needs-source

# For people, set profile paths
orka kb update per-xxx --property profile_path="02-people/person-slug/"
```

---

## Step 3: Create project entities (v0.11.0+)

Convert artifacts that are features/epics/workstreams to `project` type.

**Rule:** Has folder in `03-projects/` or is a PRD/epic? → `project`. Is reference doc? → stays `artifact`.

```bash
orka kb add project "Feature Name" \
  --status <active|in-progress|pending|blocked|review|draft> \
  --property path="03-projects/active/slug/" \
  --property repo_path="/absolute/path/to/repo" \
  --property description="What this achieves" \
  --property owner="person-name" \
  --tag feature
```

---

## Step 4: Link everything to projects (v0.11.0+)

```bash
orka kb link art-xxx part-of prj-xxx       # PRDs, specs
orka kb link dec-xxx part-of prj-xxx       # Decisions
orka kb link qst-xxx part-of prj-xxx       # Questions
orka kb link mil-xxx part-of prj-xxx       # Milestones
orka kb link per-xxx assigned-to prj-xxx   # People
orka kb link rep-xxx part-of prj-xxx       # Repos
orka kb link prj-xxx implements dir-xxx    # Directions
```

---

## Step 5: Cleanup (v0.11.0+)

```bash
# Archive migrated artifacts
orka kb update art-xxx --status archived --property migrated_to="prj-xxx"

# Archive completed projects
orka kb update prj-xxx --status archived --property archived_reason="shipped"
```

---

## Step 6: Verify

```bash
orka kb list --type project               # Projects exist with correct status
orka kb show <any-decision-id>            # Has source_path + sourced-from
orka kb show <any-project-id>             # Has part-of edges
```

In Knowledge Graph UI:
- [ ] Project selector shows projects with status dots
- [ ] Clicking project filters graph + guide panel
- [ ] Detail panel shows Sources + Quick Access links
- [ ] "Load project context" button works on project entities
