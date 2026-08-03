---
name: board-task-close
description: Post-merge cleanup ritual for a board task-terminal — the ticket work is DONE (PR already merged / feature already in prod). Enumerates every artifact the task produced (PR, code files, docs, spin-off KB entities, infra changes, feature flags, tests, repro commands), enriches the task's overview.html with a "Cierre" section that indexes all of it in Spanish plus a "Replica y validación" section covering how to reproduce locally, verify in prod, tests executed, edge cases handled, and rollback plan. Then closes the KB entity, comments + transitions Jira, and finally cleans up the worktree + terminal. Load when the user hits Wrap up in the task modal.
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
     Para cada archivo, 1 frase de qué caso cubre.
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
  leave forward" con el motivo en 1 frase.

Guardá esto en el índice en memoria como `validation = { repro, flags, verifyProd, dashboards, tests, edgeCases, rollback }`. Vas a
inyectarlo en el `overview.html` en el Step 3 dentro de la sección
"Replica y validación".

---

## Step 3 — Update overview.html with a "Cierre" section

**Do this BEFORE the destructive steps.** If wrap-up aborts halfway
(user cancels, transition fails, whatever), the paper trail is still
complete — the overview.html tells the whole story on its own.

Read the current `<worktreePath>/.claude-orka/.orka-kb/entities/.../<kbEntityId>/overview.html`
(path is the entity's `master_doc` property from init).

Insert a NEW `<section>` **immediately before** the `<p class="meta">`
line, and bump the changelog + `.meta` "Versión actual" to the next
version. Structure:

```html
<section id="cierre">
  <h2>Cierre — trabajo entregado</h2>

  <p class="closing-summary">
    <!-- 2-3 párrafos en español, hablados, naturales. Qué se hizo,
         cómo, con qué consecuencias. Escribe como si le explicaras al
         próximo dev que tome esta área. No copies el título del PR ni
         el checklist del ticket — sintetiza el desenlace real. -->
    Se implementó ... resolviendo ... . La aproximación fue ... porque
    ... . Como consecuencia, ... .
  </p>

  <h3>Cambios entregados</h3>
  <ul>
    <li>PR principal: <a href="<prUrl>">#<prNumber></a> — mergeado <mergedAt (fecha corta ES)>.</li>
    <!-- Si hubo PRs adicionales: uno por línea -->
    <li>Archivos clave (top del diff):
      <ul>
        <li><code><path/1></code> — <1 frase de qué cambia></li>
        <li><code><path/2></code> — <1 frase></li>
        <!-- máximo 5-8; si hay mucho más, cierra con "y N más — ver PR" -->
      </ul>
    </li>
    <!-- Si hubo cambios de config/infra que NO están en el diff -->
    <li>Config / infra: <breve descripción></li>
  </ul>

  <h3>Replica y validación</h3>
  <!-- Todo lo del índice `validation` de la sub-sección 2.d.
       Omite cualquier sub-bloque que no aplique (ej. sin feature flag →
       sin bloque "Feature flags"). Nunca inventes URLs / comandos que
       no probaste — mejor menos y correctos que muchos y ficticios. -->

  <h4>Cómo reproducir localmente</h4>
  <ol class="repro-steps">
    <li>
      Requisitos previos: <ej. Node 20, docker corriendo, cuenta en X con permiso Y>.
    </li>
    <li>
      Setup:
      <pre><code>git checkout &lt;branchName o main&gt;
&lt;install command, ej. pnpm install&gt;
&lt;migración / seed si aplica&gt;</code></pre>
    </li>
    <li>
      Arrancar:
      <pre><code>&lt;dev command, ej. pnpm dev&gt;</code></pre>
    </li>
    <li>
      Verificar: abrí <a href="&lt;url local ej. http://localhost:3000/foo&gt;">&lt;path local&gt;</a>
      y esperá &lt;el comportamiento observable, en 1 frase&gt;.
    </li>
    <!-- Steps no-obvios (feature flag flip manual, seed, credencial
         de prueba) van como <li> propios. -->
  </ol>

  <h4>Feature flags y config</h4>
  <!-- Omite este <h4>+<ul> si la entrega no tocó flags ni env. -->
  <ul>
    <li>
      <code>&lt;flag_name&gt;</code> — &lt;qué controla en 1 frase&gt;.
      Encendido en: dev · staging · prod. Se prende desde
      <a href="&lt;dashboard/link/al/panel/de/flags&gt;">&lt;dónde&gt;</a>.
    </li>
    <li>
      Env vars nuevas: <code>&lt;VAR_NAME&gt;</code> — &lt;qué es&gt;
      (configurada en <code>&lt;.env / vercel / secret manager&gt;</code>,
      NO inline).
    </li>
  </ul>

  <h4>Cómo verificar en producción</h4>
  <ul>
    <li>
      URL / endpoint:
      <a href="&lt;url prod ej. https://app.acme.com/foo&gt;">&lt;path prod&gt;</a>
      · esperá &lt;comportamiento observable&gt;.
    </li>
    <!-- Para APIs: -->
    <li>
      Endpoint API: <code>GET /api/…</code> — ejemplo:
      <pre><code>curl -sS 'https://api.acme.com/v1/…' \
  -H 'Authorization: Bearer &lt;token de prueba, NO literal&gt;'</code></pre>
      Respuesta esperada: &lt;shape + status en 1 frase&gt;.
    </li>
    <!-- Para jobs/workers: -->
    <li>
      Job / worker: se corre &lt;cuándo&gt;.
      Verificar en <a href="&lt;dashboard/logs&gt;">&lt;dónde&gt;</a>
      que aparece &lt;señal esperada&gt;.
    </li>
  </ul>

  <h4>Observabilidad</h4>
  <!-- Omite si no hay dashboards específicos. -->
  <ul>
    <li>
      <a href="&lt;grafana/datadog/sentry link específico al panel&gt;">&lt;nombre del panel&gt;</a>
      — &lt;qué métrica mira / cuál es el "healthy" esperado&gt;.
    </li>
  </ul>

  <h4>Tests ejecutados</h4>
  <ul>
    <li>
      CI del PR: &lt;N checks en verde, M en amarillo (con detalle)&gt;.
      Ver <a href="&lt;url del PR /checks&gt;">status del PR</a>.
    </li>
    <li>
      Test files agregados / modificados:
      <ul>
        <li><code>&lt;path/to/foo.spec.ts&gt;</code> — &lt;caso que cubre en 1 frase&gt;.</li>
        <!-- uno por archivo relevante, máximo ~8 -->
      </ul>
    </li>
    <li>
      QA manual durante la sesión: &lt;lista corta de escenarios que se
      probaron a mano, con resultado&gt;.
      <!-- ej: "manual: intentar login con email inválido → mostró el
                error inline correcto"; "manual: cargar la vista con
                200 filas → renderizó en &lt;300ms" -->
    </li>
  </ul>

  <h4>Casos borde considerados</h4>
  <dl class="edge-cases">
    <dt>Cubierto</dt>
    <dd>&lt;qué escenarios manejamos deliberadamente, uno por línea&gt;</dd>
    <dt>Fuera de scope (intencional)</dt>
    <dd>&lt;qué escenarios NO se cubrieron y por qué — evita que alguien
        lo reporte como bug más adelante&gt;</dd>
  </dl>

  <h4>Rollback</h4>
  <p class="rollback">
    <!-- Elegí UNO según aplique: -->
    <!-- (a) Revert del PR -->
    Si algo se rompe: revertir con
    <code>git revert -m 1 &lt;merge-sha&gt;</code> o desde
    <a href="&lt;url del PR&gt;">el botón Revert del PR</a>.
    <!-- (b) Feature flag off -->
    Si el problema es solo comportamental, apagar el flag
    <code>&lt;flag_name&gt;</code> desde
    <a href="&lt;dashboard&gt;">el panel de flags</a> — reversión
    inmediata sin re-deploy.
    <!-- (c) Restore de datos -->
    Si hubo migración destructiva: restaurar desde
    <a href="&lt;backup/snapshot&gt;">el snapshot pre-migración</a>
    tomado el &lt;fecha&gt;.
    <!-- (d) No aplica -->
    No requiere rollback — la entrega es backward-compatible /
    idempotente / detrás de un flag apagado por default.
  </p>

  <h3>Documentos generados</h3>
  <!-- Si NO se generó ningún documento, omite este <h3> y su <ul>.
       Si sí, uno por línea. Los paths son RELATIVOS al proyecto para que
       el link funcione dentro del preview HTML de Orka. -->
  <ul>
    <li>
      <a href="../../../../../<doc.path>"><doc.title></a>
      — <doc.summary>
    </li>
    <li>
      <a href="../../../../../<otro>"><otro título></a>
      — <resumen>
    </li>
  </ul>

  <h3>Entidades KB relacionadas</h3>
  <!-- Omite si no hubo spin-offs. Si sí, incluye el id + type + link al
       overview.html de cada una. Los links son relativos entre
       overview.html de entidades hermanas. -->
  <ul>
    <li>
      <code><type></code> ·
      <a href="../<type>/<spinoffId>/overview.html"><spinoffId></a>
      — <título> · <1 frase de qué captura>
    </li>
  </ul>

  <h3>Contexto de cierre</h3>
  <ul>
    <li>Ticket Jira: <a href="<jiraUrl>"><taskKey></a> · movido a <nextStatus>.</li>
    <li>Rama: <code><branchName></code>.</li>
    <li>Worktree: <code><worktreePath></code> — <"eliminado tras merge" | "conservado (template close-keep-worktree)">.</li>
  </ul>
</section>
```

Then bump the version. In the same edit:

- Change `<p class="meta">` to say `<strong>Versión actual: v2.0</strong>`
  (or `vN+1.0` if v1.0 already existed as a normal edit — pick the next
  semantic MAJOR since a wrap-up is a milestone).
- Prepend a new `<li>` at the top of `.changelog ul`:
  ```html
  <li data-version="v2.0">
    <span class="ver">v2.0</span>
    <span class="when"><ISO date></span>
    Cierre — <taskKey> mergeado en <a href="<prUrl>">PR</a>. Se agregó
    la sección de cierre con índice de documentos y contexto de entrega.
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
  --property outcome_summary="<1-3 frases en español: qué se hizo, cómo, y cualquier consecuencia importante — puede ser el mismo primer párrafo del <p class='closing-summary'> del overview>"
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
them to the "Entidades KB relacionadas" section of overview.html so the
close doc stays complete.** Just an Edit on that one `<ul>`.

---

## Step 6 — Short comment on the Jira ticket

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

## Step 7 — Transition Jira to Done (if it isn't already)

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

Then print a compact one-paragraph recap in Spanish:

```
✓ <taskKey> cerrado.
  overview.html actualizado con sección de Cierre + Replica y validación
    (índice de N docs, M spin-offs, K tests, rollback plan).
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
  Step 9.
- **KB entity for `jira_key` missing** — the init flow didn't run or
  the entity was deleted. Look up: `orka kb list --property jira_key=<key>`.
  If genuinely missing, create a minimal `done` entity so the paper trail
  isn't broken.
- **Duplicate Jira comment** — if a prior wrap-up comment exists,
  edit or append rather than posting a fresh copy.
- **No CI on the repo / no tests written** — the "Tests ejecutados"
  sub-block still gets rendered but with a candid note: "Sin CI
  automatizado en este repo · sin test files agregados en este PR ·
  QA manual: <lo que se probó a mano>". Nunca inventes tests que no
  existen — es peor que decir "no había".
- **No sabés cómo verificar en prod porque nunca lo viste correr allá**
  — no adivines URLs ni dashboards. Anotá "Verificación en prod
  pendiente — el owner del ticket debe confirmar antes de cerrar" y
  seguí adelante. La sección queda incompleta pero honesta.
- **Feature todavía no llegó a prod** (mergeado pero pendiente de
  deploy) — anotá en el rollback + verificación "Aún no desplegado en
  prod al momento del cierre — deploy programado para <fecha o release
  train>. Verificar allá cuando aterrice."
