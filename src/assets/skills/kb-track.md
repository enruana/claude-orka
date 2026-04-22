# KB Track

Track decisions, questions, directions, and other project knowledge from the current conversation.

## Instructions

1. First, load current KB context to understand what already exists:
```bash
orka kb context
```

2. Review the current conversation and identify new knowledge to track:
   - **Decisions** made (use type: `decision`)
   - **Questions** raised or answered (use type: `question`)
   - **Directions** chosen or explored (use type: `direction`)
   - **People** mentioned with roles (use type: `person`)
   - **Milestones** set (use type: `milestone`)

3. **Determine the source** of the information:
   - If from a file/document: note the file path
   - If from a conversation: note who said it and the date
   - If from a meeting: check if the meeting entity already exists, create it if not

4. For each piece of knowledge, create the entity WITH source traceability:

```bash
# Decision with source — always include source_path or source property
orka kb add decision "Title of decision" \
  --property confidence=high \
  --property source="conversation with X, 2026-04-20" \
  --property source_path="path/to/relevant/file.md" \
  --link sourced-from:<meeting-or-artifact-id> \
  --tag architecture

# Question with source
orka kb add question "Question text" \
  --property source="sprint planning discussion" \
  --link sourced-from:<meeting-id>

# Direction with source
orka kb add direction "Direction name" \
  --property rationale="why we chose this" \
  --property source_path="path/to/spec.md" \
  --link sourced-from:<artifact-id>
```

5. Link entities together with typed relations:
```bash
orka kb link <source-id> relates-to <target-id>
orka kb link <source-id> supersedes <target-id>
orka kb link <decision-id> decided-at <meeting-id>
orka kb link <question-id> raised-at <meeting-id>
```

6. Common relation types:
   - `sourced-from` — **ALWAYS USE**: where this info came from
   - `decided-at` / `raised-at` — anchored to a meeting
   - `relates-to`, `supersedes`, `blocks`, `depends-on`
   - `implements`, `assigned-to`, `part-of`, `contributes-to`

7. Update existing entities when their status changes:
```bash
orka kb update <id> --status resolved --property resolution="answer here"
orka kb update <id> --status superseded
```

8. After tracking, **regenerate the project INDEX.md** for any affected projects:
```bash
orka kb project-doc <project-id>
```

9. Confirm what was captured to the user.

## Source Traceability Rules

- EVERY new entity MUST have source info. Use at minimum ONE of:
  - `--property source_path="path/to/file.md"` (link to a file in the project)
  - `--property source="human-readable description"` (text reference)
  - `--link sourced-from:<entity-id>` (link to meeting/artifact/context entity)
- Prefer ALL THREE when possible — the file path enables direct navigation in the UI
- If tracking from a live conversation, use `--property source="conversation, YYYY-MM-DD"`

## Path Convention

**All paths MUST be from the project root.** Never use relative (`../`) or absolute system paths.
- Correct: `source_path="01-journal/2026/04-april/meeting/notes.md"`
- Wrong: `source_path="../meeting/notes.md"`

## Tips
- Keep titles concise but descriptive
- Use tags for cross-cutting concerns (e.g., `architecture`, `security`, `ux`)
- Link new entities to existing ones when relationships exist
- Mark questions as `resolved` when answered, add `--property resolution="..."`
- Mark decisions as `superseded` when replaced
