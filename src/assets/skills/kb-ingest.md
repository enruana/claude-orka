# KB Ingest

Process a document (meeting notes, spec, conversation transcript, etc.) and extract structured knowledge into the KB.

## Instructions

1. Read the provided file or content
2. Load existing KB context to avoid duplicates:
```bash
orka kb context
```

3. **FIRST: Create a source entity** for the document being ingested. This is the anchor that all extracted entities will reference back to:
```bash
# For a meeting transcript:
orka kb add meeting "Sprint Planning 2026-04-20" \
  --property date=2026-04-20 \
  --property attendees="felipe,ana" \
  --property notes_path="path/to/notes.md" \
  --tag sprint

# For a spec/document:
orka kb add artifact "PRD - Feature Name" \
  --property path="path/to/document.md" \
  --tag prd
```

4. Extract entities from the document:
   - **Decisions** — explicit choices made ("we decided to...", "we'll go with...")
   - **Questions** — open items ("we need to figure out...", "TBD:", "?")
   - **People** — participants with their roles
   - **Directions** — strategic choices or explorations
   - **Milestones** — deadlines or targets mentioned

5. **CRITICAL: Every entity MUST have source traceability.** Use BOTH:
   - `--property source_path="path/to/file.md"` — direct file reference
   - `--link sourced-from:<source-entity-id>` — link to the meeting/artifact entity

```bash
# Every decision links back to its source meeting AND has the file path
orka kb add decision "Use JWT for auth" \
  --property source_path="01-journal/2026/04-april/meeting-notes.md" \
  --property source="Sprint Planning 2026-04-20" \
  --link sourced-from:<meeting-id> \
  --tag security

# Every question links back too
orka kb add question "How to handle token refresh?" \
  --property source_path="01-journal/2026/04-april/meeting-notes.md" \
  --link sourced-from:<meeting-id> \
  --link relates-to:<decision-id>

# People get profile paths when known
orka kb add person "Ana Garcia" \
  --property role="Backend Lead" \
  --property profile_path="02-people/ana-garcia/" \
  --link sourced-from:<meeting-id>
```

6. Common relation types:
   - `sourced-from` — where this information came from (ALWAYS use this)
   - `decided-at` — decision made at a meeting
   - `raised-at` — question raised at a meeting
   - `relates-to` — generic connection
   - `supersedes` — replaces a previous entity
   - `blocks` / `depends-on` — dependency chain
   - `assigned-to` — work ownership
   - `part-of` — hierarchy

7. **Regenerate INDEX.md** for any affected projects:
```bash
orka kb project-doc <project-id>
```

8. Show the user a summary of what was extracted with source links.

## Source Traceability Rules

- EVERY entity created from a document MUST have `source_path` property pointing to the file
- EVERY entity MUST have a `sourced-from` edge to the meeting/artifact it came from
- If the source is a conversation (not a file), use `--property source="conversation with X, 2026-04-20"`

## Path Convention

**All paths MUST be relative to the project root.** Never use relative paths (`../`) or absolute system paths.

- Correct: `source_path="01-journal/2026/04-april/meeting/notes.md"`
- Correct: `path="03-projects/active/feature-slug/"`
- Correct: `profile_path="02-people/felipe-mantilla/"`
- Wrong: `source_path="../meeting/notes.md"`
- Wrong: `source_path="/home/user/project/notes.md"`

This ensures links in the Knowledge Graph UI and in generated INDEX.md files resolve correctly.
