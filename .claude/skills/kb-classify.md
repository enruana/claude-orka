# KB Classify

Suggest the correct tier for an entity. Useful when the v1 KB has lots of `project` entities that are actually `task`s, `bug`s, `spike`s, or `initiative`s.

## Instructions

1. Run the classifier:

```bash
orka kb classify <entity-id>
```

The output shows:
- Current type
- Suggested type (or "current looks correct")
- Confidence: `low | medium | high`
- Reasoning — each scoring rule that fired, with explanation

2. The classifier looks at:
   - **Title patterns**: "ENG-1234" → ticket-like; "Spike", "Investigate" → spike; "PRD", "Epic" → initiative
   - **Properties**: `target_release`/`deadline` → bounded outcome; `time_box` → spike; `severity`/`repro_steps` → bug; `estimate`/`story_points` → task
   - **Topology**: many incoming edges → likely a container (project/initiative)

3. Help the user decide:
   - High confidence → suggest applying the change.
   - Medium → discuss with the user; the heuristic might be missing context.
   - Low → respect the current type unless the user has a clear reason to change.

4. **Reclassification is destructive** (changes the id prefix and forces edge migration). Don't apply it manually — recommend `orka kb upgrade` (P9) which handles it safely.

5. For a batch sweep:
```bash
# Classify all 'project' entities to find mis-classified ones
orka kb list --type project --json | jq -r '.[].id' | while read id; do
  echo "--- $id ---"
  orka kb classify "$id"
done
```

## Tips

- Classify early in the migration process — knowing which `project` entities are actually `task`s helps plan the migration.
- The reasoning is transparent — each rule fires for a concrete reason. If a suggestion looks wrong, the reasoning will tell you why.
- If the entity has no metadata yet (just title + description), the classifier returns "insufficient signal" and respects the current type. Add properties first.
