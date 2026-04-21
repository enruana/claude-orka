# KB Status

Quick project knowledge base status — open questions, recent decisions, active directions.

## Instructions

Run these commands and present a concise project status to the user:

```bash
orka kb list --status active --type decision
orka kb list --status active --type question
orka kb list --status active --type direction
orka kb list --status active --type milestone
```

Present the results as a structured summary:

1. **Key Decisions** — what has been decided and is currently active
2. **Open Questions** — what needs to be answered
3. **Active Directions** — what the team is exploring or building
4. **Milestones** — upcoming targets

If the user wants more detail on any item:
```bash
orka kb show <entity-id>
orka kb history <entity-id>
```

Keep the output concise and actionable — this is meant to be a quick pulse check.
