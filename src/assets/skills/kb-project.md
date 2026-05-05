# KB Project (v2)

Manage entities in the work tier — `goal`, `initiative`, `project`, `task`, `spike`, `bug`. Pick the right tier; "project" in v2 is bounded outcome only, not a catch-all.

For the full v2 model, see `/kb-guide`. For tier suggestions, use `/kb-classify`.

## Decide the tier

| Tier | When to use | Examples |
|---|---|---|
| `goal` | Ongoing area of responsibility, no end | "Improve onboarding for AI engineers" |
| `initiative` | Strategic objective spanning multiple projects | "PRD #1 AI Routing", "June Release" |
| `project` | Bounded outcome with target | "ENG-204193 — Register MCP gateway targets" |
| `task` | Atomic work, single sitting/PR | "Setup GHA for chat-rag service" |
| `spike` | Time-boxed exploration | "Investigate token rotation strategies" |
| `bug` | Defect | "ENG-204264 trigger.type=api not implemented" |

If unsure, run `/kb-classify` after creation to get a heuristic suggestion.

## Create entities

```bash
# Goal — no deadline
orka kb add goal "Onboarding excellence for AI engineers" \
  --strict \
  --status active \
  --property description="Continuous improvement of AI hire onboarding process" \
  --property owner="alex-rogers" \
  --property rationale="Reduce time-to-first-PR for new AI engineers"

# Initiative — strategic, multi-project
orka kb add initiative "PRD #1 - AI Routing" \
  --strict \
  --status active \
  --property description="Multi-agent routing for Rise AI — replaces monolithic agent" \
  --property owner="felipe-mantilla" \
  --property target_release="2026-06"

# Project — bounded outcome
orka kb add project "ENG-204193 - Register 3 MCP gateway targets" \
  --strict \
  --status active \
  --property description="Register rise-contacts, rise-campaigns, rise-campaign-resources MCP targets" \
  --property path="03-projects/active/eng-204193-mcp-gateway-targets/" \
  --property repo_path="/home/felipe-mantilla/Desktop/MoxiWorks/06-repos/rise-ai" \
  --property owner="felipe-mantilla" \
  --property target_release="2026-06" \
  --tag feature \
  --link child-of:<initiative-id>

# Task — atomic
orka kb add task "Add rise-contacts target to Pulumi stack" \
  --strict \
  --status todo \
  --property description="Extend dev-gateway/index.ts with new AgentcoreGatewayTarget" \
  --property owner="felipe-mantilla" \
  --property estimate="2h" \
  --link scope-of:<project-id>

# Spike — time-boxed exploration
orka kb add spike "Investigate AgentCore Gateway tools/list pagination" \
  --strict \
  --status concluded \
  --property description="Find empirical cap on tools per page" \
  --property time_box="1 day" \
  --property question="Does AgentCore paginate tools/list? What's the cap?" \
  --link scope-of:<project-id>

# Bug
orka kb add bug "ENG-204264 trigger.type=api not implemented" \
  --strict \
  --status investigating \
  --property description="3-layer contract mismatch in api.activepipe Trigger model" \
  --property severity="medium" \
  --property reporter="ashley" \
  --property repro_steps="Send chat message → MCP creates campaign → 500 error" \
  --link child-of:<project-id>
```

## Hierarchy

Use the right relation for the parent link:

```
child-of   : project → initiative,  initiative → goal,  bug → project
scope-of   : task → project,  spike → project
subtask-of : task → task | spike | bug
```

```bash
# Tasks belong to a project via scope-of
orka kb link tsk-xxx scope-of prj-yyy

# Sub-tasks of another task
orka kb link tsk-xxx subtask-of tsk-parent

# Project under an initiative
orka kb link prj-xxx child-of ini-yyy

# Bug nested under a project
orka kb link bug-xxx child-of prj-yyy
```

## Status transitions

The validator enforces state machines. Use `orka kb update` and check the allowed transitions in `/kb-guide`.

```bash
orka kb update prj-xxx --status active --strict        # planning → active
orka kb update tsk-xxx --status in-progress --strict   # todo → in-progress
orka kb update tsk-xxx --status done --strict          # in-progress → done
orka kb update spk-xxx --status concluded --strict     # in-progress → concluded
orka kb update bug-xxx --status fixed --strict         # investigating → fixed
orka kb update prj-xxx --status done --strict
```

For decisions that have changed, **don't update — supersede**:
```bash
orka kb add decision "<new title>" --strict ... --link supersedes:dec-old
orka kb update dec-old --status superseded --strict
```

## Archive vs cancel

- `archived` — kept for history, dimmed in UI
- `cancelled` — won't be done, no longer relevant

```bash
orka kb update prj-xxx --status archived --property archived_reason="shipped"
orka kb update tsk-xxx --status cancelled --property cancelled_reason="duplicate"
```

## Generate INDEX.md

After any structural change:

```bash
orka kb project-doc <project-id>            # default medium breadth
orka kb project-doc <project-id> --breadth narrow  # only directly-linked
orka kb project-doc <project-id> --breadth wide    # 3-hop sweep
```

The INDEX.md auto-generates with sections for: sub-work-items (tasks/spikes/bugs), decisions, questions, milestones, people, meetings, repos, artifacts, directions.

## Tips

- Run `/kb-classify <id>` if you're unsure about the tier.
- For strategic work, prefer `initiative` → `project` → `task` chains over flat `project` lists.
- Keep `goal` count small (single digits) — it's the highest-level abstraction.
- Use tags for cross-cutting concerns (`feature`, `infra`, `security`).
