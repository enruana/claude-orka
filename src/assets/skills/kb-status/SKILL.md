---
name: kb-status
description: Quick pulse of the KB — open questions, recent decisions, active work, upcoming milestones, overall health. Use when the user asks "what's happening", "status", or before standups.
---

# KB Status (v2)

Quick KB pulse check — open questions, recent decisions, active work items, upcoming milestones, and overall health. For full v2 model, see `/kb-guide`.

## Instructions

1. Run a quick set of queries:

```bash
# Active work items by tier
orka kb list --type task --status todo
orka kb list --type task --status in-progress
orka kb list --type spike --status open
orka kb list --type bug --status open
orka kb list --type bug --status investigating

# Knowledge tier
orka kb list --type decision --status accepted
orka kb list --type question --status open
orka kb list --type milestone --status active

# KB health
orka kb lint
```

2. Summarize for the user:
   - **Active work** — what's in flight per tier (tasks/spikes/bugs)
   - **Recent decisions** — what's been decided lately
   - **Open questions** — what needs answers
   - **Upcoming milestones** — deadlines on the horizon
   - **KB health** — top 3 lint issues to address

3. If the user asks for detail:
```bash
orka kb show <id>           # full entity
orka kb history <id>        # event timeline
orka kb timeline --limit 30 # recent events across the whole KB
```

## Tips

- Keep output concise — this is a pulse check, not a deep dive. For depth use `/kb-context` or `/kb-project-context`.
- Surface **stale** entities: questions open > 7 days, tasks `in-progress` for too long. The user can decide if they need attention.
- If lint shows 100+ issues, mention `orka kb upgrade` (P9 migration) instead of trying to fix one by one.
