# KB Lint

Audit the Knowledge Base for health issues — missing source/description, off-spec statuses, deprecated relations, missing recommended properties.

## Instructions

1. Run the lint command:

```bash
orka kb lint                  # all entities, all rules
orka kb lint --type decision  # scope to one type
orka kb lint --json           # machine-readable, full detail
```

2. The output shows:
   - **Summary by rule** — count of each issue category
   - **Top offenders** — entities with the most issues, with their first 3 issues each

3. Interpret the rules:
   - `unknown_type` — entity has a type not in the v2 registry (e.g. legacy `reference`). Migration via `orka kb upgrade` will reclassify.
   - `invalid_status` — status not allowed for this type (e.g. decision with `active` instead of `proposed/accepted/rejected/superseded`).
   - `missing_required` — required property absent (description, outcome for decisions, date for meetings).
   - `missing_recommended` — soft warning, suggested property not set.
   - `missing_source` — no source_path, source property, or sourced-from/generated-by edge.
   - `deprecated_relation` — uses `part-of` or `contributes-to`; migrate to typed relation.

4. Help the user prioritize:
   - **Critical**: `unknown_type`, `missing_required`, `missing_source` — these block clean strict-mode operation.
   - **Should fix**: `invalid_status`, `deprecated_relation` — these will be auto-handled by `orka kb upgrade` (P9), but the user can also fix manually.
   - **Nice to have**: `missing_recommended` — improve over time.

5. **Suggest specific fixes** for the top offenders. For each entity:
   - Read it: `orka kb show <id>`
   - Propose the fix in v2 vocabulary (e.g. "this decision has status `active` — it should be `accepted` since the conversation in the source meeting concluded").
   - Apply with the user's confirmation:
     ```bash
     orka kb update <id> --status accepted --strict
     orka kb update <id> --property description="..." --property outcome="..." --strict
     ```

6. For deprecated relations, suggest the typed replacement:
   - `part-of` between `task → project` → `scope-of`
   - `part-of` between `task → task` → `subtask-of`
   - `part-of` between `bug → project` → `child-of`
   - `part-of` between `decision → project` → `addresses` or `implements`
   - `part-of` between `artifact → repo` → `references` or `owned-by`
   - `contributes-to` between `person → repo` → `relates-to` (with role qualifier)

7. **Bulk fixes** for systematic issues:
   - If many decisions have `status:active`, ask the user whether to bulk-update to `accepted` (or whatever default makes sense).
   - For migration-scale fixes, recommend `orka kb upgrade` instead.

## Tips

- Run lint **before** big check-ins — keeps the KB clean over time.
- `--type <type>` is your friend when reviewing one tier at a time.
- The lint events (`entity.flagged`) accumulate in the timeline. You can check `orka kb timeline --limit 100` to see recent flags.
- Keep MoxiWorks-style large-debt KBs in `--draft` mode while migrating; switch to `--strict` per-skill once the relevant tier is clean.
