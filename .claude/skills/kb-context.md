# KB Context (v2)

Load the project's knowledge base context — decisions, open questions, active work items, milestones, recent activity. For full v2 model, see `/kb-guide`.

## Instructions

1. Run with appropriate breadth:

```bash
orka kb context                                      # whole KB, narrow default
orka kb context --project <prj-id>                   # scoped to a project (medium breadth default)
orka kb context --project <prj-id> --breadth narrow  # only directly-linked entities
orka kb context --project <prj-id> --breadth wide    # 3 hops, weak relations included
```

The output includes:
- Active work items (tasks, spikes, bugs, sub-initiatives)
- Active decisions
- Open questions
- Milestones
- Directions
- People
- Repos
- Source files to read for deeper detail

2. **Use the context to**:
   - Avoid re-asking resolved questions
   - Build on existing decisions rather than contradicting them
   - Know who is responsible for what
   - Understand current direction

3. For deeper detail on a specific entity:
```bash
orka kb show <entity-id>
orka kb history <entity-id>     # full event history including flagged issues
```

4. To see the full graph (rare; use the Web UI for visual):
```bash
orka kb list                    # everything
orka kb list --type decision    # one type
orka kb graph --format dot      # Graphviz output
```

## Breadth presets

- **narrow** (1 hop, score ≥ 0.5): only directly-linked entities — the project's tasks, decisions, and meetings
- **medium** (2 hops, score ≥ 0.2, default): includes sibling decisions, related people, indirectly-linked artifacts
- **wide** (3 hops, score ≥ 0.1): broad sweep including weak/categorical edges

If `medium` returns too much noise, try `narrow`. If you're missing context, try `wide`.

## Tips

- This skill is read-only — it doesn't mutate the KB.
- Combine with `/kb-project-context` to also read source files for deep dive.
- If `--project` errors with "not found", check `orka kb list --type project` for the right id.
