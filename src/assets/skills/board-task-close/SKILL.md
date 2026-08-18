---
name: board-task-close
description: Wrap-up ritual for a board task-terminal. Two flavors — Jira-origin tasks: the ticket work is DONE (PR merged / feature in prod); enumerates every artifact produced (PR, code files, docs, spin-off KB entities, infra changes, feature flags, tests, repro commands), enriches overview.html with a "Wrap-up" section + a "Reproduction & validation" section, closes the KB entity, comments + transitions Jira, cleans worktree + terminal. Local-origin tasks (research / doc / design / spike; keys start with LOCAL-): skips PR gate + Jira steps and focuses on wrapping the deliverable — the overview.html + KB entity IS the artifact. Load when the user hits Wrap up in the task modal.
---

# Board Task — Wrap Up (post-merge cleanup)

You are running inside a task-terminal after the ticket's work is
**already done** — the PR has been merged, the feature is in prod (or
whatever the definition of shipped is for this repo). Your job is
**cleanup + record keeping**, not shipping. If the PR is NOT merged yet,
stop and warn the user before doing anything else — see Failure modes.

Prerequisite reading: `board-guide` (schema + CLI), `kb-guide`, `board-jira-api`.

**Output language: English throughout** — every user-visible artifact
this skill produces (the overview.html wrap-up section, the KB entity
properties, the Jira comment, the terminal recap). Use natural,
moderate vocabulary — the kind a technical friend would use over Slack.
Prefer common verbs (`fix`, `add`, `update`, `check`, `ship`) over
academic ones. Keep sentences short. Avoid idioms. Being direct is
fine.

Placeholders provided:
- `taskKey`, `taskTitle`, `jiraUrl`, `boardId`, `projectPath`
- `kbEntityId` — the KB entity created at init
- `worktreePath`, `branchName`
- `template` — which close template ran (`close-default` = remove worktree by default, `close-keep-worktree` = keep it)
- `nextStatus` — usually `done`

**Two flavors** — check `origin` on the BoardTask before starting:

```
orka board show-task --board <boardId> --key <taskKey> --json | jq '{origin, taskType, jiraUrl}'
```

- **Jira-origin** (default) — the ritual below runs in full.
- **Local-origin** (`origin: 'local'` or `taskKey` starts with `LOCAL-`)
  — skip Step 1 (no PR to gate on), Step 6 (no Jira comment), Step 7
  (no Jira transition). Everything else — artifact enumeration,
  overview.html enrichment, KB update, worktree remove (if any),
  terminal close — still applies. The "delivered artifact" for a local
  task IS the overview.html + the linked KB entities, not a PR.

Each step below carries a **`Local:`** note whenever its behavior
changes for local tasks.

---

## Step 1 — Sanity check: confirm the work has actually shipped

**Local: SKIP entirely.** A local task has no PR to gate on. The
deliverable is the doc / research / design captured in the KB
entity — that's already there or you'll write it in Step 3.

Before touching anything (Jira tasks only), verify the PR is merged. Skip only if the user
explicitly told you the ticket has no PR (spike / research / doc-only).

```
# Inside <worktreePath>
gh pr view --json state,mergedAt,url 2>/dev/null || echo "no PR"
```

If `state` is `MERGED`: capture `url` and `mergedAt`, continue.

If `state` is `OPEN` or `DRAFT`: **stop**. Print a warning to the user:
"The PR is still open at <url>. Wrap up assumes the ticket has already
shipped — if you want to close it, merge the PR first or run this
ritual afterwards." Do not proceed with worktree removal or the Jira
transition until the user confirms.

If `state` is `CLOSED` without merge: ask the user — abandoned or WIP?
Don't assume.

If there's no `gh` or no PR at all (spike / doc / repo without PRs):
skip this check. In that case there's no `prUrl` to capture — record
`n/a` in the log.

---

## Step 2 — Collect final artifacts

Gather everything we'll reference in the KB, the overview.html wrap-up
section, and the Jira comment. Lookups only — no mutations yet.

### 2.a Code changes

- **PR URL** (from Step 1, if any).
- **Merged commits into the base branch since init**:
  ```
  git log --oneline <baseBranch>..<mergedRef> -- <affected paths>
  ```
- **Files that landed**: `git diff --stat <baseBranch>..<mergedRef>` —
  trim to the top ~10 lines for display. Group by area if it helps
  (frontend / backend / docs / tests).
- **Additional PRs** if the work spanned more than one (e.g. a follow-up
  hotfix). Capture URLs for all of them.

### 2.b Documents & artifacts produced during the task

The whole point of this wrap-up is that six weeks from now, someone
opens `overview.html` and sees an INDEX of everything the task
produced, not just the code. Enumerate systematically:

- **Docs written in the worktree** (design notes, ADRs, migration
  guides, READMEs, runbooks). One useful sweep:
  ```
  git diff --name-only <baseBranch>..<mergedRef> -- '*.md' '*.mdx' '*.html' '*.rst' 'docs/'
  ```
- **KB entities you (or the task) created during this ticket** — any
  spin-off `decision`, `spike`, `bug`, `task`, `question`, `meeting`
  entities. Enumerate:
  ```
  orka kb list --json | jq '[.[] | select(.properties.source_task == "<taskKey>" or .properties.parent_task == "<taskKey>")]'
  ```
  If the task never linked spin-offs explicitly, look at what you
  yourself created in this session (Claude's own file-write history is
  the ground truth). For each entity capture: id, type, title, its
  `master_doc` path (usually `.claude-orka/.orka-kb/entities/.../overview.html`),
  and a one-sentence description.
- **External assets** if the task produced diagrams, screenshots,
  transcripts, meeting reports, or attachments — grab their paths.
- **Config or infra changes** that landed outside the code diff (env
  vars added to Vercel, feature flags flipped, DNS records changed,
  Jira workflow tweaks). Capture as bullet points, no link needed.

Build a small in-memory index for Step 3:

```
docs = [
  { title: "ADR-004: streaming chunk size",
    path: "docs/adr/004-streaming-chunk-size.md",
    summary: "Por qué elegimos hop=1500ms + overlap=500ms como default." },
  { title: "Notas de investigación de whisper.cpp",
    path: ".claude-orka/notes/whisper-research.md",
    summary: "Comparativa de latencia entre base / small / medium en el CPU de dev." },
  ...
]
kbSpinoffs = [
  { id: "dec-a1B2c3", type: "decision", title: "Adoptar whisper small como default",
    doc: ".claude-orka/.orka-kb/entities/decision/dec-a1B2c3/overview.html",
    summary: "Small es 3× más lento que base pero materialmente mejor con acentos ES." },
  ...
]
```

### 2.c Follow-ups worth their own KB entities

Any TODOs, deferred work, or discoveries during the PR that deserve
their own `task` / `bug` / `spike` / `decision`. Note them — you'll
create them in Step 5 (renumbered — was Step 4).

### 2.d Reproducción y validación

The whole point of this sub-step is that six months from now, someone
who's never seen this ticket can (a) reproduce the change locally in
under 10 minutes, (b) verify it's really live in prod, and (c) roll
back if it starts misbehaving. Gather:

- **Comandos de reproducción local**. Look at what the task actually
  needed the developer to run — scan the worktree for hints:
  ```
  # scripts declarados en el repo
  cat package.json 2>/dev/null | jq -r '.scripts // {} | to_entries[] | "\(.key)\t\(.value)"'
  ls Makefile justfile Taskfile.* 2>/dev/null
  # comandos que el propio Claude corrió en esta sesión — mirar el
  # historial de tool calls: cualquier `npm test`, `pnpm dev`, `pytest`,
  # `docker compose`, migración de DB, etc. cuenta.
  ```
  Capturá los MÍNIMOS necesarios para levantar el feature end-to-end:
  install deps, arrancar el dev server, la URL de acceso, credenciales
  de prueba si hay (masked — nunca secrets literales). Si hay steps
  no-obvios (migración manual, seed, feature flag flip, config env
  var), listalos en orden.
- **Feature flags / env vars tocadas**. Escaneá el diff:
  ```
  git diff <baseBranch>..<mergedRef> -- \
    '*.env*' 'build_flags.yaml' 'flags.json' \
    | grep -E '^\+' | grep -vE '^\+\+\+'
  ```
  Para cada flag: nombre, entorno donde está prendido (dev / staging /
  prod), cómo se prende (script, dashboard URL), y qué comportamiento
  cambia. NO copies valores de secrets literales — solo el nombre y
  cómo se configura.
- **Endpoints / URLs de verificación en prod**. Si la feature toca la
  web app: la URL o ruta donde se ve. Si es API: el método + path +
  ejemplo de curl (con headers/body de ejemplo, sin secrets reales). Si
  es un job/worker: cómo comprobar que corrió (logs, dashboard,
  métrica). Si es infra: qué recurso mirar.
- **Dashboards / observabilidad relevante**. Grafana, Datadog, Sentry,
  Vercel Analytics, whatever este repo use — pegá el link específico
  al panel que muestra la salud del feature, no el home genérico.
- **Tests ejecutados** — 3 fuentes complementarias, en orden de
  autoridad:
  1. **CI del PR**:
     ```
     gh pr view <prNumber> --json statusCheckRollup 2>/dev/null \
       | jq '[.statusCheckRollup[] | {name, conclusion, detailsUrl}]'
     ```
     Capturá el nombre de cada check + verde/rojo + link. Los `success`
     son los tests que efectivamente pasaron. Un `null` conclusion en
     el momento del merge suele indicar un check no-bloqueante.
  2. **Test files nuevos o modificados en el PR** (evidencia de qué
     se cubrió):
     ```
     git diff --name-only <baseBranch>..<mergedRef> -- \
       '*test*' '*spec*' '__tests__/' 'tests/' 'e2e/' 'cypress/' 'playwright/'
     ```
     For each file, one sentence about what case it covers.
  3. **QA manual** que hayas hecho vos o el usuario durante la sesión.
     Escaneá el historial de tool calls: sesiones de browser
     automation, ejecuciones ad-hoc de curl, invocaciones de scripts
     de prueba, screenshots que se generaron. Anotá cada bloque como
     "manual: <qué se probó> → <resultado>".
- **Casos borde considerados** — durante la implementación seguro se
  discutieron y se decidieron scenarios que quedaron IN y otros que
  quedaron OUT. Enumerá ambos brevemente: qué cubre esta entrega, qué
  intencionalmente no cubre (con motivo). Esto le evita a alguien
  reportar un "bug" que en realidad es scope out.
- **Rollback**. La pregunta es: "si esto empieza a fallar en prod a
  las 3am, ¿qué revierto y cómo?". Idealmente: (a) revert del PR (link
  al `git revert -m 1 <sha>` o al botón de Revert en GitHub), (b)
  toggle-off del feature flag si la feature está gated, (c) restore
  de datos si hubo migración destructiva (link al backup / snapshot).
  Si la feature es "safe to leave forward" (idempotente, backward-
  compatible, sin migración), anotá "no requiere rollback — safe to
  leave forward" with the reason in one sentence.

Guardá esto en el índice en memoria como `validation = { repro, flags, verifyProd, dashboards, tests, edgeCases, rollback }`. Vas a
inyectarlo en el `overview.html` en el Step 3 dentro de la sección
"Reproduction & validation".

---

## Step 3 — Update overview.html with a "Wrap-up" section

**Do this BEFORE the destructive steps.** If wrap-up aborts halfway
(user cancels, transition fails, whatever), the paper trail is still
complete — the overview.html tells the whole story on its own.

Read the current `<worktreePath>/.claude-orka/.orka-kb/entities/.../<kbEntityId>/overview.html`
(path is the entity's `master_doc` property from init).

Insert a NEW `<section>` **immediately before** the `<p class="meta">`
line, and bump the changelog + `.meta` "Current version" to the next
version. Structure:

```html
<section id="wrap-up">
  <h2>Wrap-up — work delivered</h2>

  <p class="closing-summary">
    <!-- 2-3 short paragraphs, spoken and natural. What was done, how,
         and what changed as a result. Write as if you were explaining
         it to the next developer who will pick up this area. Do not
         copy the PR title or the ticket checklist — describe the real
         outcome. -->
    We built ... so that ... . The approach was ... because ... . As a
    result, ... .
  </p>

  <h3>Changes delivered</h3>
  <ul>
    <li>Main PR: <a href="<prUrl>">#<prNumber></a> — merged on <mergedAt (short date)>.</li>
    <!-- If there were extra PRs: one per line -->
    <li>Key files (top of the diff):
      <ul>
        <li><code><path/1></code> — <one sentence about what changes></li>
        <li><code><path/2></code> — <one sentence></li>
        <!-- max 5-8; if there is more, close with "and N more — see the PR" -->
      </ul>
    </li>
    <!-- Config / infra changes that did NOT show up in the diff -->
    <li>Config / infra: <short description></li>
  </ul>

  <h3>Reproduction & validation</h3>
  <!-- Everything from the `validation` index in Step 2.d. Skip any
       sub-block that does not apply (e.g. no feature flag → drop the
       "Feature flags" block). Never invent URLs or commands you did
       not actually try — fewer and correct beats many and made-up. -->

  <h4>How to reproduce locally</h4>
  <ol class="repro-steps">
    <li>
      Prerequisites: <e.g. Node 20, docker running, an account on X with permission Y>.
    </li>
    <li>
      Setup:
      <pre><code>git checkout &lt;branchName or main&gt;
&lt;install command, e.g. pnpm install&gt;
&lt;migration / seed if needed&gt;</code></pre>
    </li>
    <li>
      Start:
      <pre><code>&lt;dev command, e.g. pnpm dev&gt;</code></pre>
    </li>
    <li>
      Check: open <a href="&lt;local URL e.g. http://localhost:3000/foo&gt;">&lt;local path&gt;</a>
      and expect &lt;the observable behavior, in one sentence&gt;.
    </li>
    <!-- Non-obvious steps (manual feature flag flip, seed data, test
         credential) go as their own <li>. -->
  </ol>

  <h4>Feature flags & config</h4>
  <!-- Skip this <h4>+<ul> if the change did not touch flags or env vars. -->
  <ul>
    <li>
      <code>&lt;flag_name&gt;</code> — &lt;what it controls, one sentence&gt;.
      Turned on in: dev · staging · prod. Toggle it from
      <a href="&lt;dashboard/link/to/flags panel&gt;">&lt;where&gt;</a>.
    </li>
    <li>
      New env vars: <code>&lt;VAR_NAME&gt;</code> — &lt;what it is&gt;
      (configured in <code>&lt;.env / vercel / secret manager&gt;</code>,
      NOT inline).
    </li>
  </ul>

  <h4>How to verify in production</h4>
  <ul>
    <li>
      URL / endpoint:
      <a href="&lt;prod URL e.g. https://app.acme.com/foo&gt;">&lt;prod path&gt;</a>
      · expect &lt;observable behavior&gt;.
    </li>
    <!-- For APIs: -->
    <li>
      API endpoint: <code>GET /api/…</code> — example:
      <pre><code>curl -sS 'https://api.acme.com/v1/…' \
  -H 'Authorization: Bearer &lt;test token, NOT literal&gt;'</code></pre>
      Expected response: &lt;shape + status in one sentence&gt;.
    </li>
    <!-- For jobs / workers: -->
    <li>
      Job / worker: runs at &lt;when&gt;.
      Check <a href="&lt;dashboard/logs&gt;">&lt;where&gt;</a>
      to see &lt;the expected signal&gt;.
    </li>
  </ul>

  <h4>Observability</h4>
  <!-- Skip if there are no relevant dashboards. -->
  <ul>
    <li>
      <a href="&lt;grafana/datadog/sentry link to the specific panel&gt;">&lt;panel name&gt;</a>
      — &lt;what metric it shows / what "healthy" looks like&gt;.
    </li>
  </ul>

  <h4>Tests executed</h4>
  <ul>
    <li>
      PR CI: &lt;N checks green, M yellow (with detail)&gt;.
      See <a href="&lt;PR /checks URL&gt;">PR status</a>.
    </li>
    <li>
      Test files added / changed:
      <ul>
        <li><code>&lt;path/to/foo.spec.ts&gt;</code> — &lt;what case it covers, one sentence&gt;.</li>
        <!-- one per relevant file, max ~8 -->
      </ul>
    </li>
    <li>
      Manual QA during the session: &lt;short list of scenarios tried by
      hand, with the result&gt;.
      <!-- e.g. "manual: tried to log in with an invalid email → showed
                 the inline error correctly"; "manual: loaded the view
                 with 200 rows → rendered in under 300ms" -->
    </li>
  </ul>

  <h4>Edge cases considered</h4>
  <dl class="edge-cases">
    <dt>Covered</dt>
    <dd>&lt;scenarios we deliberately handle, one per line&gt;</dd>
    <dt>Out of scope (on purpose)</dt>
    <dd>&lt;scenarios we did NOT cover and why — so no one later
        reports it as a bug&gt;</dd>
  </dl>

  <h4>Rollback</h4>
  <p class="rollback">
    <!-- Pick ONE that matches: -->
    <!-- (a) Revert the PR -->
    If something breaks: revert with
    <code>git revert -m 1 &lt;merge-sha&gt;</code> or use
    <a href="&lt;PR URL&gt;">the PR's Revert button</a>.
    <!-- (b) Feature flag off -->
    If the issue is behavioral only, turn off the
    <code>&lt;flag_name&gt;</code> flag from
    <a href="&lt;dashboard&gt;">the flags panel</a> — instant reversal
    without a redeploy.
    <!-- (c) Data restore -->
    If there was a destructive migration: restore from
    <a href="&lt;backup/snapshot&gt;">the pre-migration snapshot</a>
    taken on &lt;date&gt;.
    <!-- (d) Not needed -->
    No rollback needed — the delivery is backward-compatible /
    idempotent / behind a flag that is off by default.
  </p>

  <h3>Generated documents</h3>
  <!-- If NO document was generated, drop this <h3> and its <ul>. If
       there are some, one per line. Paths are RELATIVE to the project
       so the links work inside the Orka HTML preview. -->
  <ul>
    <li>
      <a href="../../../../../<doc.path>"><doc.title></a>
      — <doc.summary>
    </li>
    <li>
      <a href="../../../../../<other>"><other title></a>
      — <summary>
    </li>
  </ul>

  <h3>Related KB entities</h3>
  <!-- Skip if there were no spin-offs. Otherwise include id + type +
       a link to each one's overview.html. Links are relative between
       sibling entities' overview.html files. -->
  <ul>
    <li>
      <code><type></code> ·
      <a href="../<type>/<spinoffId>/overview.html"><spinoffId></a>
      — <title> · <one sentence about what it captures>
    </li>
  </ul>

  <h3>Close context</h3>
  <ul>
    <li>Jira ticket: <a href="<jiraUrl>"><taskKey></a> · moved to <nextStatus>.</li>
    <li>Branch: <code><branchName></code>.</li>
    <li>Worktree: <code><worktreePath></code> — <"removed after merge" | "kept (close-keep-worktree template)">.</li>
  </ul>
</section>
```

Then bump the version. In the same edit:

- Change `<p class="meta">` to say `<strong>Current version: v2.0</strong>`
  (or `vN+1.0` if v1.0 already existed as a normal edit — pick the next
  semantic MAJOR since a wrap-up is a milestone).
- Prepend a new `<li>` at the top of `.changelog ul`:
  ```html
  <li data-version="v2.0">
    <span class="ver">v2.0</span>
    <span class="when"><ISO date></span>
    Wrap-up — <taskKey> shipped in <a href="<prUrl>">PR</a>. Added the
    wrap-up section with an index of documents and delivery context.
  </li>
  ```

Do this with **one atomic Write of the full file** — don't patch with
`Edit` on scattered pieces. Read, mutate the string, Write back. This
avoids leaving the doc in a broken half-updated state if the process
gets interrupted.

---

## Step 4 — Update the KB entity (final state)

With overview.html already carrying the human-readable close, the
entity's properties are the machine-readable version:

```
orka kb update <kbEntityId> \
  --skill board-task-close \
  --status done \
  --property pr_url=<prUrl>            # omit if no PR
  --property merged_at=<mergedAt>       # omit if no PR
  --property closed_at=<isoNow> \
  --property outcome_summary="<1-3 English sentences: what was done, how, and any important consequence — this can be the same first paragraph of the <p class='closing-summary'> in the overview>"
```

If additional PRs shipped, add them as `--property extra_prs=<comma-separated urls>`.

---

## Step 5 — Capture spin-off entities (only what deserves it)

If Step 2.b already captured spin-off entities, they exist. If Step 2.c
noted additional follow-ups that STILL need to be registered, do it now.

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

**If you create spin-offs here (not in Step 2.b), also go back and add
them to the "Related KB entities" section of overview.html so the
close doc stays complete.** Just an Edit on that one `<ul>`.

---

## Step 6 — Short comment on the Jira ticket

**Local: SKIP entirely.** No Jira ticket to comment on. The
`outcome_summary` on the KB entity + the "Wrap-up" section on
overview.html carry the same information for local tasks.

Post a brief summary in English so anyone looking at the ticket in Jira
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
        { "type": "text", "text": "<English summary: what shipped and where. e.g. 'Feature shipped in PR #123, merged on 2026-07-24. See KB spk-... for the technical detail.'>" }
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

## Step 7 — Transition Jira to Done (if it isn't already)

**Local: SKIP entirely.** No Jira ticket. Step 8 updates the local
BoardTask column to `done` (or whatever `nextStatus` says) — that's
the only "transition" a local task needs.

```
GET  /rest/api/3/issue/<taskKey>?fields=status
```

If `fields.status.name` is already Done: skip the transition. Just log
"Jira was already Done, so no transition was applied".

Otherwise transition:

```
GET  /rest/api/3/issue/<taskKey>/transitions
POST /rest/api/3/issue/<taskKey>/transitions   { "transition": { "id": "<idOfDone>" } }
```

If the target status is something other than Done (e.g. Deployed,
Released), the caller's `nextStatus` placeholder will say so — use it.

---

## Step 8 — Update the local BoardTask

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

## Step 9 — Remove the worktree

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

## Step 10 — Signal server to close the terminal

Cleanup done. Tell the server it can tear down the tmux + ttyd for this
task:

```
orka board close-task --board <boardId> --key <taskKey> --terminal shutdown
```

Then print a compact one-paragraph recap in English. Two shapes:

**Jira-origin:**
```
✓ <taskKey> closed.
  overview.html updated with Wrap-up + Reproduction & validation
    (index of N docs, M spin-offs, K tests, rollback plan).
  KB updated: <kbEntityId> → done (+ N spin-off entities if any).
  Jira comment posted. Ticket moved to Done.
  Worktree removed: <worktreePath>.
```

**Local-origin:**
```
✓ <taskKey> closed  (local · <taskType>).
  overview.html updated with Wrap-up section
    (index of N docs, M spin-offs).
  KB updated: <kbEntityId> → done (+ N spin-off entities if any).
  No Jira ticket (local task).
  Worktree: <"removed" | "n/a — doc-only task">.
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
  Step 9.
- **KB entity for `jira_key` missing** — the init flow didn't run or
  the entity was deleted. Look up: `orka kb list --property jira_key=<key>`.
  If genuinely missing, create a minimal `done` entity so the paper trail
  isn't broken.
- **Duplicate Jira comment** — if a prior wrap-up comment exists,
  edit or append rather than posting a fresh copy.
- **No CI on the repo / no tests written** — the "Tests executed"
  sub-block still gets rendered, with a candid note: "No automated CI
  in this repo · no test files added in this PR · manual QA: <what was
  tried by hand>". Never invent tests that do not exist — that is
  worse than saying "there were none".
- **You don't know how to verify in prod because you never saw it run
  there** — do not guess URLs or dashboards. Write "Prod verification
  pending — the ticket owner should confirm before this can be closed"
  and move on. The section stays incomplete but honest.
- **Feature has not landed in prod yet** (merged but waiting on a
  deploy) — write in the rollback + verification blocks: "Not deployed
  to prod at close time — deploy scheduled for <date or release
  train>. Check there once it lands."
