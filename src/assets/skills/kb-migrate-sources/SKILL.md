---
name: kb-migrate-sources
description: Upgrade a v1 KB to v2 schema (new tiers, relations, qualifiers). Use when the user runs orka kb upgrade or asks about migrating an older KB.
---

# KB Upgrade & Migrate (v2)

Upgrade an existing v1 KB to support v2 features. The bulk of migration is automated by `orka kb upgrade`. This skill helps the user run it, review the result, and clean up edge cases.

For full v2 model see `/kb-guide`.

## Step 0: Update skills (after upgrading the Orka package)

When the Orka package version changes, refresh the skills in your workspace:

```bash
orka kb skills-sync --dry-run    # preview what will change
orka kb skills-sync              # apply
```

This copies the latest skill files from the package into `.claude/skills/`. Safe to run any time — it only adds/updates skills present in the package.

## Step 1: Diagnose

Run `kb lint` first to see the migration debt:

```bash
orka kb lint
```

Look at the summary by rule:
- `unknown_type` — entities with v1-only types (e.g. `reference`)
- `invalid_status` — off-spec statuses (`completed`, `answered`, `proposed` for non-decisions)
- `missing_required` — entities missing required v2 fields (`description`, `outcome`)
- `missing_source` — entities without source/provenance edges
- `deprecated_relation` — uses of `part-of` or `contributes-to`
- `missing_recommended` — soft warnings, fix over time

Take note of the totals — that's what migration will address.

## Step 2: Run automated migration (P9 — coming soon)

```bash
orka kb upgrade
```

This will:
1. Bump schema version (event `kb.schema.bumped {from: 1, to: 2}`)
2. Reclassify rogue types: `reference` → `artifact` with tag
3. Normalize statuses:
   - `completed` (meeting/milestone) → `held`/`reached`
   - `answered` (question) stays as `answered`
   - `proposed` (decision) stays valid
4. Disambiguate deprecated relations using source/target types:
   - `part-of` (task → project) → `scope-of`
   - `part-of` (task → task) → `subtask-of`
   - `part-of` (bug → project) → `child-of`
   - `part-of` (decision → project) → `addresses` or `implements`
   - `part-of` (artifact → repo) → `references`
   - `contributes-to` (person → repo) → `relates-to` with `role: contributor` qualifier
5. Backfill edge qualifiers from `since`/`eventRef`
6. Heuristic provenance backfill: link entities without source to nearest meeting in time

Each step records a `kb.migration` event for auditability. If anything goes wrong, replay the event log up to before the migration marker.

## Step 3: Reclassify work items (semi-manual)

Many v1 KBs have entities classified as `project` that are actually `task`, `spike`, `bug`, or `initiative`. Use `/kb-classify` to find them:

```bash
orka kb list --type project --json | jq -r '.[].id' | while read id; do
  orka kb classify "$id"
done
```

For each high-confidence suggestion, ask the user before applying. Reclassification is destructive (id prefix changes); `orka kb upgrade --reclassify` (P9) handles it safely with edge migration.

## Step 4: Fill in MADR fields for decisions

Many v1 decisions only have a title and rationale. v2 wants `outcome`, `drivers`, `options`, `consequences`. For each accepted decision:

```bash
orka kb update <dec-id> \
  --strict \
  --property outcome="<the chosen option in one sentence>" \
  --property "drivers=<concern1>, <concern2>" \
  --property "options=<a>|<b>|<c>" \
  --property "consequences=<positive + negative>"
```

If the user has the source meeting notes, extracting these from the notes is the cleanest path.

## Step 5: Verify

```bash
orka kb lint                        # should be near-zero issues
orka kb list --type project         # only true projects
orka kb list --type task            # tasks promoted from misclassified projects
orka kb show <some-decision-id>     # MADR fields populated
orka kb show <some-edge-id>         # qualifiers present
```

In the Knowledge Graph UI:
- [ ] All entities have a tier badge
- [ ] Detail panel shows MADR fields for decisions
- [ ] Backlinks panel populated
- [ ] Provenance badge on LLM-generated entities
- [ ] Health panel green (>90% with source, >80% with description)

## Tips

- Migration is large; don't try to hand-fix issue by issue — run `orka kb upgrade` and review.
- Keep the original `events.jsonl.bak` until you're confident the migration is correct.
- After migration, switch the workspace default to `--strict` so new entries stay clean.
- Re-train the team's habits via `/kb-track` and `/kb-ingest` skills — they enforce v2 vocabulary by default.
