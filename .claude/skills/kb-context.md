# KB Context

Load the project's knowledge base context to understand decisions, open questions, active directions, and recent activity.

## Instructions

Run the following command and incorporate the output into your understanding of this project:

```bash
orka kb context
```

This provides:
- Active decisions and their relationships
- Open questions that need answers
- Current directions being explored
- Active milestones
- Key people and their roles
- Recent activity timeline

Use this context to:
- Avoid re-asking questions that were already answered
- Build on existing decisions rather than contradicting them
- Understand who is responsible for what
- Know what directions the project is heading

If you need details on a specific entity:
```bash
orka kb show <entity-id>
```

If you need the full graph of relationships:
```bash
orka kb list
```
