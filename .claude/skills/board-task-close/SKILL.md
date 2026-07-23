---
name: board-task-close
description: Close ritual for a board task-terminal — push the branch, open the PR, comment on Jira, mark KB done, optionally clean the worktree, and move the Jira ticket to Done. Load when the user drags a card to Done, runs close-task, or invokes the close prompt.
---

# Board Task — Close Ritual

You are running inside a task-terminal that just received a close signal. Your job is to leave the ticket, the branch, the KB entity, and the workspace in a clean, correct state.

Prerequisite reading: `board-guide` (schema + CLI), `kb-guide`, `board-jira-api`.

Placeholders provided:
- `taskKey`, `taskTitle`, `jiraUrl`, `boardId`, `projectPath`
- `kbEntityId` — the KB entity created at init
- `worktreePath`, `branchName`
- `template` — which close template ran (`close-default`, `close-keep-worktree`, or a custom name)
- `nextStatus` — usually `done`, but could be `review` if the user is pushing for review only

---

## Step 1 — Verify the branch is ready

Inside the worktree:
```
git status
git log --oneline <baseBranch>..HEAD
```

If there are uncommitted changes:
- If small (< ~50 lines): commit them with a descriptive message.
- If large or unclear: stop and ask the user before committing.

If there are no new commits since the base branch, ask the user whether this is really a "close" (maybe it should be a "cancel" instead).

---

## Step 2 — Push and open the PR

```
git push -u origin <branchName>
```

If the repo uses GitHub (`gh` available):
```
gh pr create \
  --title "<taskKey>: <taskTitle>" \
  --body "Closes <taskKey>\n\nhttps://<jira>/browse/<taskKey>\n\n## Summary\n<summary>\n\n## Test plan\n- [ ] ..."
```

Capture the PR URL. If `gh` isn't available, print the compare URL and ask the user to open it manually — then paste the resulting PR URL back so you can log it.

---

## Step 3 — Comment on the Jira ticket

Post a summary comment:

```
POST /rest/api/3/issue/<taskKey>/comment
{
  "body": {
    "type": "doc",
    "version": 1,
    "content": [{
      "type": "paragraph",
      "content": [{ "type": "text", "text": "PR: <prUrl>\nBranch: <branchName>\n\n<one-paragraph summary>" }]
    }]
  }
}
```

Note the ADF (Atlassian Document Format) shape — plain strings aren't accepted by Jira Cloud.

---

## Step 4 — Update the KB entity

Mark done and record what came out of it:

```
orka kb update <kbEntityId> \
  --skill board-task-close \
  --status done \
  --property pr_url=<prUrl> \
  --property closed_at=<isoNow>
```

If the work produced a decision worth capturing, add a `decision` entity too and link it:
```
orka kb add decision "<short title>" --skill board-task-close --status decided --property source_task=<kbEntityId>
orka kb link <decisionId> resulted_from <kbEntityId>
```

Same for any spike outputs, bugs discovered, or follow-up tasks — capture them as their own KB entities linked back to this one.

---

## Step 5 — Transition Jira

```
GET  /rest/api/3/issue/<taskKey>/transitions
POST /rest/api/3/issue/<taskKey>/transitions   { "transition": { "id": "<idOfNextStatus>" } }
```

`nextStatus` is usually `Done`, but the close template may target `In Review` instead — use whatever placeholder was passed.

---

## Step 6 — Update the local BoardTask

```
orka board update-task \
  --board <boardId> \
  --key <taskKey> \
  --status <nextStatus> \
  --property pr_url=<prUrl>
```

---

## Step 7 — Clean the worktree (if the template removes it)

Default `close-default` keeps the worktree until the PR is merged (in case CI fails and you need to push a fix). `close-remove-worktree` removes it immediately.

If removing:
```
moxikit worktree remove <worktreePath>
```
Or as fallback:
```
git worktree remove <worktreePath>
git branch -d <branchName>       # only if merged; use -D to force
```

---

## Step 8 — Signal server to close the terminal

Once everything above succeeded, ask the user whether to keep the terminal alive (useful for follow-up review comments) or close it. If close:

```
orka board close-task --board <boardId> --key <taskKey> --terminal shutdown
```

The server will stop tmux + free the ttyd port.

---

## Failure modes

- **Push rejected** → likely branch out of date. `git pull --rebase` (only if the branch is yours), then push again. If conflicts, stop and hand back to the user.
- **PR already exists** → grab its URL via `gh pr view --json url` and reuse.
- **Jira transition rejected** → the workflow doesn't allow this direct transition. Print available transitions and ask the user.
- **Worktree has uncommitted changes on the close-remove path** → refuse to remove. Ask the user to commit, stash, or discard first.
- **KB entity not found** — `kbEntityId` was lost. Look it up: `orka kb list task --property jira_key=<key>`. If genuinely missing, create a `done`-status entity to keep the record straight.
