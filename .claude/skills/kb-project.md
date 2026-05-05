# KB Project

Manage projects (features, epics, tasks, workstreams) in the Knowledge Base. Projects are the top-level containers that group decisions, questions, milestones, and artifacts together.

## Register a new project

```bash
orka kb add project "Feature Name" \
  --property path="03-projects/active/feature-slug/" \
  --property repo_path="/absolute/path/to/repo" \
  --property description="Short description of what this project is about" \
  --property owner="person-name" \
  --property target_release="2026-06" \
  --tag feature
```

## Project statuses

| Status | Meaning | Color in UI |
|--------|---------|-------------|
| `active` | Being worked on now | Green |
| `in-progress` | Development underway | Blue |
| `blocked` | Waiting on a blocker | Red |
| `pending` | Queued, not started yet | Yellow |
| `review` | In review/QA | Purple |
| `draft` | Planning phase | Gray |
| `resolved` | Done/shipped | Dark gray |
| `archived` | Closed, historical | Dimmed |

Set status when creating:
```bash
orka kb add project "Feature Name" --status in-progress ...
```

Update status as it progresses:
```bash
orka kb update prj-xxx --status blocked --property blocked_by="waiting for AWS access"
orka kb update prj-xxx --status review --property reviewer="Aerika"
orka kb update prj-xxx --status resolved --property shipped_date="2026-06-15"
orka kb update prj-xxx --status archived --property archived_reason="shipped in June release"
```

Key properties:
- `path` — folder path in the workspace (enables navigation from Knowledge Graph UI)
- `repo_path` — (optional, highly recommended) absolute path to the project's git repository. Enables "Open Code" in the UI and links the project to its codebase. Example: `/home/user/repos/my-project`
- `description` — what this project aims to achieve
- `owner` — who is responsible
- `target_release` — when it's expected to ship
- `status_detail` — current status notes ("in design", "in review", "blocked by X")

## Link everything to the project

After creating the project, link all related entities to it:

```bash
# Link PRDs, specs, artifacts
orka kb link art-xxx part-of prj-xxx

# Link decisions made for this project
orka kb link dec-xxx part-of prj-xxx

# Link open questions
orka kb link qst-xxx part-of prj-xxx

# Link milestones
orka kb link mil-xxx part-of prj-xxx

# Link people working on it
orka kb link per-xxx assigned-to prj-xxx

# Link repos involved
orka kb link rep-xxx part-of prj-xxx

# Link directions this project implements
orka kb link prj-xxx implements dir-xxx
```

## Archive a project

When a project is done, shipped, or cancelled:

```bash
orka kb update prj-xxx --status archived \
  --property archived_reason="shipped in June release" \
  --property archived_date="2026-06-15"
```

Do NOT delete — archived projects remain in the KB for historical reference. They appear dimmed in the Knowledge Graph UI.

## Migrate existing artifacts to projects

Some entities currently stored as `artifact` are actually projects (features, epics). To migrate:

1. Check existing artifacts:
```bash
orka kb list --type artifact
```

2. For each artifact that is actually a project/feature:
```bash
# Create the project entity
orka kb add project "Feature Name" \
  --property path="03-projects/active/slug/" \
  --tag feature

# Link related entities to it
orka kb link dec-xxx part-of prj-xxx
orka kb link qst-xxx part-of prj-xxx

# Optionally archive the old artifact
orka kb update art-xxx --status archived --property migrated_to="prj-xxx"
```

## View projects

```bash
# List active projects
orka kb list --type project --status active

# List archived projects
orka kb list --type project --status archived

# Show project with all relationships
orka kb show prj-xxx
```

In the Knowledge Graph UI, use the project selector bar to filter the graph by project — only related entities are highlighted.
