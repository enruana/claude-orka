---
name: board-task-close
description: Post-merge cleanup ritual for a board task-terminal — the ticket work is DONE (PR already merged / feature already in prod). Cleans the worktree via moxikit, closes out the KB entity with links to what shipped, leaves a short summary comment on the Jira ticket, and moves it to Done if it isn't already. Load when the user hits Wrap up in the task modal.
---

# Board Task — Wrap Up (post-merge cleanup)

You are running inside a task-terminal after the ticket's work is
**already done** — the PR has been merged, the feature is in prod (or
whatever the definition of shipped is for this repo). Your job is
**cleanup + record keeping**, not shipping. If the PR is NOT merged yet,
stop and warn the user before doing anything else — see Failure modes.

Prerequisite reading: `board-guide` (schema + CLI), `kb-guide`, `board-jira-api`.

Placeholders provided:
- `taskKey`, `taskTitle`, `jiraUrl`, `boardId`, `projectPath`
- `kbEntityId` — the KB entity created at init
- `worktreePath`, `branchName`
- `template` — which close template ran (`close-default` = remove worktree by default, `close-keep-worktree` = keep it)
- `nextStatus` — usually `done`

---

## Step 1 — Sanity check: confirm the work has actually shipped

Before touching anything, verify the PR is merged. Skip only if the user
explicitly told you the ticket has no PR (spike / research / doc-only).

```
# Inside <worktreePath>
gh pr view --json state,mergedAt,url 2>/dev/null || echo "no PR"
```

If `state` is `MERGED`: capture `url` and `mergedAt`, continue.

If `state` is `OPEN` or `DRAFT`: **stop**. Print a warning to the user:
"El PR aún está abierto en <url>. Wrap up asume que el ticket ya está
cerrado — si quieres cerrar el PR primero mergéalo o corre este ritual
después." Do not proceed with worktree removal or Jira transition until
the user confirms.

If `state` is `CLOSED` without merge: ask the user — abandoned or WIP?
Don't assume.

If there's no `gh` or no PR at all (spike / doc / repo without PRs):
skip this check. In that case there's no `prUrl` to capture — record
`n/a` in the log.

---

## Step 2 — Collect final artifacts

Gather everything we'll reference in the KB and the Jira comment. All
of these are lookups, no mutations yet:

- **PR URL** (from Step 1, if any)
- **Merged commits into the base branch since init** — quick view:
  ```
  git log --oneline <baseBranch>..<mergedRef> -- <affected paths>
  ```
- **Files that landed**: `git diff --stat <baseBranch>..<mergedRef>` for a compact "what changed" list. Trim to the top ~10 lines for the KB body.
- **Follow-ups worth capturing as separate entities**: any TODOs, deferred work, or discoveries during the PR that deserve their own `task` / `bug` / `spike` / `decision` entities. Take note — you'll create them in Step 4.

---

## Step 3 — Update the KB entity (final state)

Mark the entity done and stamp the outcome so future searches find
"what was decided / what shipped / where the code lives":

```
orka kb update <kbEntityId> \
  --skill board-task-close \
  --status done \
  --property pr_url=<prUrl>            # omit if no PR
  --property merged_at=<mergedAt>       # omit if no PR
  --property closed_at=<isoNow>
```

If the work is worth annotating further (files changed, key decisions
inside the PR), do it via a properties bump or, better, capture a
short **summary property** in Spanish so the entity's card is
self-contained:

```
orka kb update <kbEntityId> \
  --property outcome_summary="<1-3 frases en español: qué se hizo, cómo, y cualquier consecuencia importante>"
```

If you also want a version bump on the entity's `overview.html`
changelog (the doc gets a "closed" entry), prepend an `<li>` with
`data-version="v<next>"`, the ISO date, and a "**CLOSED · <taskKey>**"
one-liner referencing the PR URL. Update the `.meta` line's "Versión
actual".

---

## Step 4 — Capture spin-off entities (only what deserves it)

If the PR discussion or the merged code surfaced anything reusable
across future tasks, register it as its own KB entity linked back to
this one. Don't create noise — only real, reusable knowledge:

- **decision** if a non-obvious tradeoff was locked in
- **bug** if a defect was found (fix included or deferred)
- **spike** if an investigation happened and produced a conclusion
- **task** if there's genuine follow-up work worth tracking

Example:

```
orka kb add decision "<short title>" \
  --skill board-task-close \
  --status decided \
  --property description="<qué decisión y por qué>" \
  --property source_pr=<prUrl>
orka kb link <newId> resulted_from <kbEntityId>
```

Skip this step entirely if nothing warrants capture — most tasks won't.

---

## Step 5 — Short comment on the Jira ticket

Post a brief summary in Spanish so anyone looking at the ticket in Jira
knows what happened locally. Keep it 2-4 sentences — Jira isn't the KB.

```
POST /rest/api/3/issue/<taskKey>/comment
{
  "body": {
    "type": "doc",
    "version": 1,
    "content": [{
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "<Spanish summary: qué se entregó y dónde. Ej: 'Feature liberada en PR #123, mergeado 2026-07-24. Ver KB spk-... para detalle técnico.'>" }
      ]
    }]
  }
}
```

If a comment from Orka on this ticket already exists (grep by "Orka" or
"KB entity <id>"), edit it or append a follow-up — don't spam multiple
"wrap up" comments.

Skip this step ONLY if there's no PR and no material outcome — a
pure-noise comment on Jira is worse than no comment.

---

## Step 6 — Transition Jira to Done (if it isn't already)

```
GET  /rest/api/3/issue/<taskKey>?fields=status
```

If `fields.status.name` is already Done: skip the transition. Just log
"Jira ya estaba en Done, no hice transición".

Otherwise transition:

```
GET  /rest/api/3/issue/<taskKey>/transitions
POST /rest/api/3/issue/<taskKey>/transitions   { "transition": { "id": "<idOfDone>" } }
```

If the target status is something other than Done (e.g. Deployed,
Released), the caller's `nextStatus` placeholder will say so — use it.

---

## Step 7 — Update the local BoardTask

Sync local state with the outcome so the Kanban shows the card in Done
and links to the PR:

```
orka board update-task \
  --board <boardId> \
  --key <taskKey> \
  --status <nextStatus>
  # If you have a PR, also:
  --property pr_url=<prUrl>
```

---

## Step 8 — Remove the worktree

Now that everything is recorded, clean up the local worktree. This is
the whole point of running Wrap Up post-merge — a merged branch's
worktree is just clutter.

```
moxikit worktree remove <worktreePath>
```

If moxikit isn't available:

```
git worktree remove <worktreePath>
git branch -d <branchName>       # -D to force if the branch isn't fully merged locally
```

If the worktree has **uncommitted changes** (shouldn't happen after
Step 1 confirmed the PR was merged, but might if the user pushed a fix
locally): stop and ask. Don't blindly `-f`.

If the template is `close-keep-worktree` (rare, but possible), skip
this step and just note it in the log.

---

## Step 9 — Signal server to close the terminal

Cleanup done. Tell the server it can tear down the tmux + ttyd for this
task:

```
orka board close-task --board <boardId> --key <taskKey> --terminal shutdown
```

Then print a compact one-paragraph recap in Spanish:

```
✓ <taskKey> cerrado.
  KB actualizado: <kbEntityId> → done (+ N entidades spin-off si aplica).
  Comentario en Jira publicado. Ticket movido a Done.
  Worktree removido: <worktreePath>.
```

---

## Failure modes

- **PR still open** (Step 1) → warn the user, don't proceed. Wrap up
  is post-merge only.
- **No PR and no commits** → this task didn't produce anything. Ask the
  user: cancel (delete KB entity) vs. close as spike (keep as
  research artifact).
- **Jira transition rejected** — workflow doesn't allow direct → Done.
  Print available transitions, ask user which to pick.
- **Worktree has uncommitted changes post-merge** — likely a hotfix in
  progress. Stop, ask the user to commit / stash / discard, then re-run
  Step 8.
- **KB entity for `jira_key` missing** — the init flow didn't run or
  the entity was deleted. Look up: `orka kb list --property jira_key=<key>`.
  If genuinely missing, create a minimal `done` entity so the paper trail
  isn't broken.
- **Duplicate Jira comment** — if a prior wrap-up comment exists,
  edit or append rather than posting a fresh copy.
