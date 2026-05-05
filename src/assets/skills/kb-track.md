# KB Track (v2)

Capture decisions, questions, directions, milestones, work items (tasks/spikes/bugs), and people from the current conversation. **Always pass `--skill kb-track`** so the entities you create get auto-provenance (a `generated-by` edge to the kb-track activity).

For the full v2 model (types, statuses, relations), see `/kb-guide`.

## Instructions

1. **Load context first** to avoid duplicates and respect existing decisions:
```bash
orka kb context
```

2. Identify what's new in the conversation:
   - **Decisions** made — `decision` type, MADR fields recommended
   - **Questions** raised or answered — `question` type
   - **Work items** committed to — pick the right tier (`task`, `spike`, `bug`, `project`, `initiative`, `goal`)
   - **Directions / milestones** — `direction` or `milestone`
   - **People** mentioned with roles — `person`

3. **Pick the right tier** for work items (this is the v2 distinction that matters):
   - Single PR / single sitting → `task`
   - Multi-PR, multi-week, has milestones → `project`
   - Multi-project under strategic umbrella → `initiative`
   - Ongoing responsibility, no end date → `goal`
   - Time-boxed exploration → `spike`
   - Defect → `bug`

4. **Create the source meeting/artifact entity first** if the conversation has a clear anchor (a meeting with a date, a doc being discussed). Then link everything to it via `sourced-from`.

5. Create entities — **always with `--skill kb-track --strict`**:

```bash
# A new decision (MADR-style)
orka kb add decision "Use JWT for auth" \
  --skill kb-track \
  --strict \
  --status proposed \
  --property description="Pick auth strategy for the API" \
  --property "drivers=stateless, mobile clients, scalability" \
  --property "options=JWT|server sessions|magic links" \
  --property outcome="JWT — best fit for our scale + mobile" \
  --property "consequences=No central revocation; need short-lived tokens + refresh" \
  --property decided_by="felipe" \
  --property source_path="01-journal/2026/05-may/2026-05-05_security-meeting/notes.md" \
  --link sourced-from:<meeting-id>

# A question raised in a meeting
orka kb add question "How do we handle token refresh?" \
  --skill kb-track \
  --strict \
  --link raised-at:<meeting-id> \
  --link addresses:<decision-id>   # if it relates to a decision-in-flight

# A task scoped under a project
orka kb add task "Wire up JWT middleware in api.activepipe" \
  --skill kb-track \
  --strict \
  --status todo \
  --property description="Add Devise::JWT and configure key rotation" \
  --property owner="felipe" \
  --property estimate="2 days" \
  --link scope-of:<project-id>

# A spike
orka kb add spike "Investigate JWT key rotation strategies" \
  --skill kb-track \
  --strict \
  --property description="Compare Auth0 vs custom rotation" \
  --property time_box="1 week" \
  --property question="What's the ops cost of self-hosted rotation?" \
  --link scope-of:<project-id>

# A bug
orka kb add bug "Token refresh fails silently after 24h" \
  --skill kb-track \
  --strict \
  --property description="Refresh endpoint returns 200 with empty body when token expired" \
  --property severity="medium" \
  --property repro_steps="Login → wait 24h → call /refresh" \
  --link child-of:<project-id>
```

6. **Use the right relation** (see `/kb-guide` or `orka kb relations`):
   - Hierarchy: `subtask-of`, `scope-of`, `child-of`
   - Knowledge ↔ work: `addresses`, `answers`, `implements`
   - Meeting links: `decided-at`, `raised-at`, `attended-by`
   - Lifecycle: `blocks`, `depends-on`, `supersedes`
   - Provenance: `sourced-from`, `derived-from`, `attributed-to`
   - Categorical: `assigned-to`, `relates-to`

7. **Add edge qualifiers** when you know the role/confidence:
```bash
orka kb link tsk-xxx assigned-to per-yyy --role primary --confidence 1.0
orka kb link dec-xxx supersedes dec-old --note "after team review"
```

8. **Update existing entities** when their status changes (validator enforces transitions):
```bash
orka kb update qst-xxx --status resolved --property resolution="answer here" --strict
orka kb update tsk-xxx --status done --strict
orka kb update dec-xxx --status accepted --strict   # decisions immutable after this
```

9. **After the conversation**, regenerate the project INDEX.md:
```bash
orka kb project-doc <project-id>
```

10. **Run lint** to catch anything you missed:
```bash
orka kb lint --type decision     # or --type task, etc.
```

## Validation rules to keep in mind

- Off-spec types/statuses/relations are **rejected** in strict — pay attention to the error hint, it suggests the closest valid value.
- Decisions become **immutable after `accepted`** — to revise, create a new decision with `--link supersedes:<old-id>`.
- Required properties: every work-tier entity needs `description`. Decisions also need `outcome`. Meetings need `date`.

## Path convention

**All paths from project root**, never relative or absolute:
- ✅ `01-journal/2026/05-may/security-meeting/notes.md`
- ❌ `../meeting/notes.md`

## Tips

- Keep titles concise but descriptive
- For decisions, fill in `drivers`, `options`, and `consequences` even if briefly — that's what makes the KB searchable later
- When something is genuinely uncertain (LLM-extracted), add `--confidence 0.7` to its edges
- Mark questions `resolved` only when they have a real `resolution` property
- Don't be afraid to use `--draft` for in-progress captures and tighten to `--strict` later
