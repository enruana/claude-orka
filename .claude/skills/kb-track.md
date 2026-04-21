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

3. For each piece of knowledge, run the appropriate command:

```bash
# Add a decision
orka kb add decision "Title of decision" --property confidence=high --tag architecture

# Add a question
orka kb add question "Question text" --status active

# Add a direction
orka kb add direction "Direction name" --property rationale="why we chose this"

# Link entities together
orka kb link <source-id> relates-to <target-id>
orka kb link <source-id> supersedes <target-id>
orka kb link <source-id> raises <target-id>
orka kb link <source-id> decided-at <meeting-id>
```

4. Common relation types: `relates-to`, `supersedes`, `blocks`, `depends-on`, `raises`, `implements`, `decided-at`, `assigned-to`, `part-of`, `contributes-to`

5. Update existing entities when their status changes:
```bash
orka kb update <id> --status superseded
orka kb update <id> --status resolved
orka kb update <id> --property confidence=low
```

6. After tracking, confirm what was captured to the user.

## Tips
- Keep titles concise but descriptive
- Use tags for cross-cutting concerns (e.g., `architecture`, `security`, `ux`)
- Link new entities to existing ones when relationships exist
- Mark questions as `resolved` when answered
- Mark decisions as `superseded` when replaced by newer ones
