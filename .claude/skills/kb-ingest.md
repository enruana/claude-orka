# KB Ingest

Process a document (meeting notes, spec, conversation transcript, etc.) and extract structured knowledge into the KB.

## Instructions

1. Read the provided file or content
2. Load existing KB context to avoid duplicates:
```bash
orka kb context
```

3. Identify and extract:
   - **Decisions** — explicit choices made ("we decided to...", "we'll go with...")
   - **Questions** — open items ("we need to figure out...", "TBD:", "?")
   - **People** — participants with their roles or responsibilities
   - **Directions** — strategic choices or explorations
   - **Milestones** — deadlines or targets mentioned
   - **Action items** — tasks assigned (create as `context` type with tag `action-item`)

4. For each extracted entity, create it:
```bash
orka kb add decision "Use JWT for auth" --property source="meeting-2026-04-20" --tag security
orka kb add question "How to handle token refresh?" --link relates-to:<decision-id>
orka kb add person "Ana Garcia" --property role="Backend Lead"
```

5. Create a meeting entity to anchor everything:
```bash
orka kb add meeting "Sprint Planning 2026-04-20" --property date=2026-04-20 --property attendees="felipe,ana"
```

6. Link extracted entities to the meeting:
```bash
orka kb link <decision-id> decided-at <meeting-id>
orka kb link <question-id> raised-at <meeting-id>
```

7. Show the user a summary of what was extracted.

## Tips
- Be conservative — only extract clearly stated information
- Ask the user to confirm if something is ambiguous
- Prefer linking to existing entities over creating duplicates
- Use the `source` property to track where information came from
- Tag with `ingested` so these can be reviewed later
