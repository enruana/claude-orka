---
name: board-standup
description: Generate an English standup report for a board — reads events since the last standup + current column snapshot, writes a fixed-location HTML file (`standup.html`) that always overwrites in place. Load when the user (or the server) types "standup" into the master terminal.
---

# Board Standup — English status report

You are running inside a **Board master terminal**. The user just
triggered a standup. Your job is to produce a concise English report
covering **what changed since the last standup** and **where things
stand right now**, then save it as an always-overwritten HTML file so
they always have the latest at the same URL.

Prerequisite reading: `board-guide` (for the CLI + storage layout).

---

## Step 1 — Figure out the cutoff

Read the board config to get `lastStandupAt`:

```
orka board show --board <boardId> --json | jq -r '.lastStandupAt // ""'
```

- If empty (first ever standup): use `24h` as the fallback window.
- Else: use the ISO timestamp as-is.

Store this as `<cutoff>`.

---

## Step 2 — Pull the events since cutoff

```
orka board events --board <boardId> --since <cutoff> --json
```

You'll get an array of `{ts, event, taskKey?, payload?}`. Common events
you'll care about:

- `task.added` — new work landed on the board
- `task.updated` with `payload.status` — status transitions (this is the
  meat of the standup)
- `task.terminal.attached` / `detached` — a task started/stopped work
- `sync.completed` — Jira pulled changes
- `drift.marked` / `drift.acknowledged` — misalignment with Jira

Group by `taskKey` so you can build a per-task narrative later.

---

## Step 3 — Pull the current snapshot

```
orka board list-tasks --board <boardId> --json
```

This gives you every task's current column. Bucket by status
(`todo` / `in-progress` / `review` / `done` / custom columns) — the
report needs "where are we right now" separately from "what moved".

For any task that's currently in `in-progress` or `review`, also pull
its KB entity if `kbEntityId` is set to reference the deep-dive doc:

```
orka board show-task --board <boardId> --key <taskKey> --json
```

Grab `kbEntityId` + `worktreePath` + `branchName` for links.

---

## Step 4 — Compose the report

The audience is you-plus-team at standup. Prioritize signal, cut
noise. Written in **English**, one report per board.

Sections in this order:

1. **Since last standup** — the "what happened" narrative. Sub-buckets:
   - **Shipped** (tasks moved to `done`): key + title + PR link if the
     KB entity has one + one-sentence outcome.
   - **In flight** (moved into `in-progress` OR still there and had
     activity — terminal attached/detached, comments landed): key +
     title + short status line.
   - **New** (moved into `todo` / `backlog` — freshly synced from Jira):
     bullet with key + title.
   - **Blocked / needs attention** (drift markers, unresolved
     questions from KB, review tasks awaiting merge): key + reason.

2. **Current board** — snapshot buckets:
   - Count + list per column. Keep it scannable (compact table or `<ul>`
     per column).
   - Highlight cards that have been in the same column > 3 days
     (`updatedAt` older than 72h) — that's the "stale" signal.

3. **Highlights & risks** (optional; skip if empty):
   - Big decisions captured in KB during the window (query
     `orka kb timeline --since <cutoff>` if you want extras).
     Filter to `event: entity.created` with `type: 'decision'`.
   - Drifts that haven't been acknowledged.
   - Tasks with high WIP (multiple in-progress at once by same
     assignee).

4. **Coming up next** — 3-5 items from `todo` most likely to move next
   (highest priority, unblocked, or newest).

Keep it **skimmable**: developer reads this in 30 seconds and knows the
state. Avoid corporate-speak. Prefer concrete verbs.

---

## Step 5 — Write the HTML

**Fixed path** (always overwritten):

```
<projectPath>/.claude-orka/.boards/<boardId>/standup.html
```

Use the `Write` tool for full-file replacement — don't patch.

### Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Standup — <boardName> — <ISO date>_</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 820px; margin: 32px auto; padding: 0 20px; color: #24292f; line-height: 1.55; }
    h1 { margin: 0 0 4px; font-size: 24px; }
    .subtitle { color: #6e7781; font-size: 13px; margin-bottom: 32px; }
    h2 { border-bottom: 1px solid #d0d7de; padding-bottom: 6px; font-size: 18px; margin-top: 32px; }
    h3 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.4px; color: #57606a; margin-top: 20px; margin-bottom: 8px; }
    .empty { color: #6e7781; font-style: italic; font-size: 13px; }
    .task { padding: 8px 0; border-top: 1px solid #eaeef2; }
    .task:first-child { border-top: none; }
    .task-key { display: inline-block; min-width: 90px; font-family: monospace; color: #0969da; font-weight: 600; }
    .task-title { color: #24292f; }
    .task-line { font-size: 13px; color: #57606a; margin-top: 2px; margin-left: 90px; }
    .col-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
    .col-card { border: 1px solid #d0d7de; border-radius: 8px; padding: 12px; }
    .col-card h3 { margin-top: 0; }
    .col-count { color: #0969da; font-weight: 700; }
    .stale { color: #bf8700; }
    .meta { color: #6e7781; font-size: 11px; margin-top: 40px; padding-top: 12px; border-top: 1px dashed #d0d7de; text-align: center; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #f6f8fa; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Standup — <boardName></h1>
  <p class="subtitle">
    Generated <ISO now> · Window: <cutoff> → now
    · Board <a href="<jiraUrl>"><boardName></a>
  </p>

  <section>
    <h2>Since last standup</h2>

    <h3>Shipped</h3>
    <!-- One .task per, or class="empty" fallback if none -->

    <h3>In flight</h3>
    <!-- ditto -->

    <h3>New on the board</h3>
    <!-- ditto -->

    <h3>Blocked / needs attention</h3>
    <!-- ditto -->
  </section>

  <section>
    <h2>Current board</h2>
    <div class="col-list">
      <div class="col-card">
        <h3>To do <span class="col-count">(N)</span></h3>
        <!-- <div class="task">…</div> per, up to 5, then "…and N more" -->
      </div>
      <div class="col-card">
        <h3>In progress <span class="col-count">(N)</span></h3>
      </div>
      <div class="col-card">
        <h3>Review <span class="col-count">(N)</span></h3>
      </div>
      <div class="col-card">
        <h3>Done <span class="col-count">(N)</span></h3>
        <!-- Show only tasks moved to done during the window here. Not the historical Done pile. -->
      </div>
    </div>
  </section>

  <section>
    <h2>Highlights &amp; risks</h2>
    <!-- omit section entirely if nothing meaningful -->
  </section>

  <section>
    <h2>Coming up next</h2>
    <!-- 3-5 items from top of To do -->
  </section>

  <p class="meta">Auto-generated by Orka board standup · last update always overwrites this file.</p>
</body>
</html>
```

For task-key links (when a PR is known):
```html
<span class="task">
  <span class="task-key">PROJ-123</span>
  <span class="task-title">Add rate limiting to the invoice API</span>
  <div class="task-line">
    → shipped in <a href="{{prUrl}}">PR #45</a>. Feature-flagged behind
    <code>invoice_ratelimit</code>.
  </div>
</span>
```

---

## Step 6 — Bump `lastStandupAt`

```
orka board standup-mark --board <boardId>
```

This updates the config so the next run only picks up events after
this moment.

---

## Step 7 — Report back to the user

Print a compact confirmation in the master terminal:

```
✓ Standup generated for <boardName>
  Path: .claude-orka/.boards/<boardId>/standup.html
  Window: <cutoff> → <now> (<N> events, <M> tasks)
  Shipped: <n> · In flight: <n> · New: <n> · Blocked: <n>
```

The user's UI links directly to the HTML preview so they don't need to
navigate.

---

## Failure modes

- **No events since last standup** → produce a short report anyway
  ("Nothing moved since <lastStandupAt>. Current board unchanged.") +
  still bump `lastStandupAt` so the window resets.
- **First-ever standup with 24h fallback and nothing happened** →
  same as above, but note "First standup — nothing tracked in the
  last 24 hours."
- **Board has drift or Jira sync failed recently** → surface it in
  "Highlights & risks" prominently.
- **KB entity referenced but not found** → log to console, skip the
  KB link, don't fail the report.
