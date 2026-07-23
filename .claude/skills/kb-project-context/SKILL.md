---
name: kb-project-context
description: Deep-load a specific project's, initiative's or goal's full context — sub-items, decisions, questions, milestones, people — plus its source files. Use before working on a particular project or answering scoped questions.
---

# KB Project Context (v2)

Load the full context of a specific project (or initiative/goal) — its status, sub-work-items, decisions, questions, milestones, people — and read its source files for deep understanding.

For full v2 model see `/kb-guide`.

## Instructions

1. List available projects/initiatives if needed:
```bash
orka kb list --type project
orka kb list --type initiative
orka kb list --type goal
```

2. Load the project context — pick breadth based on need:

```bash
orka kb context --project <id>                    # medium default
orka kb context --project <id> --breadth narrow   # focused: only directly-linked entities
orka kb context --project <id> --breadth wide     # 3-hop, broad sweep
```

The output sections:
- **Project header** — status, description, owner, target release, repo path
- **Active Work Items** — tasks, spikes, bugs, sub-initiatives in flight (v2 tier types)
- **Decisions** — what's been decided
- **Questions** — what's still open
- **Milestones** — deadlines and targets
- **Directions** — strategic context
- **People** — who's involved
- **Repositories** — codebases related to this project
- **Source Files** — files that contain detailed context

3. **Read the source files** listed in "Source Files". These are the actual meeting notes, PRDs, specs, and docs:

```bash
cat path/to/meeting-notes.md
cat path/to/prd.md
```

Priority order:
- **Meeting notes** (`notes_path`) — what was actually said
- **PRDs/specs** (`path` on artifacts) — formal requirements
- **Profile paths** (`profile_path`) — who's who
- **Sub-task descriptions** — what's being done

4. **Summarize back to the user**:
   - What the project is about
   - Current status + next steps
   - Key decisions made
   - Open questions blocking progress
   - Anything blocked or stale

5. **If the project has a `repo_path`**, you can also explore the codebase using regular file tools.

6. **After discussion**, capture any new decisions/questions/work items via `/kb-track`.

## Examples

```
/kb-project-context
> Load context for ENG-204193

/kb-project-context
> What's the status of PRD #1 AI Routing? Read the latest meeting notes.

/kb-project-context
> Catch me up on prj-xxx
```

## Tips

- If the user mentions a project by name, use `orka kb list --type project` to find the id.
- The traversal is scored — if you need broader context, ask the user before re-running with `--breadth wide`.
- After deep context, you have rich understanding — use it to suggest next steps, identify blockers, or help with implementation. Don't just dump info; synthesize.
