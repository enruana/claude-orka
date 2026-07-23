---
name: board-task-init
description: Boot ritual for a board task-terminal — create the worktree (moxikit), read docs and the Jira ticket, register the task in Orka KB, link everything back, and move the Jira ticket to In Progress. Load when a task-terminal spawns and its init prompt fires.
---

# Board Task — Init Ritual

You are running inside a **task-terminal** for a Jira ticket. You just booted. Your job is to get the workspace ready to start coding and to make sure the ticket, the local BoardTask, and the KB entity are all linked.

Prerequisite reading: `board-guide` (schema + CLI), `kb-guide` (KB shape), `board-jira-api` (Jira endpoints).

Placeholders provided to you in the init prompt:
- `taskKey` — Jira issue key (e.g. `PROJ-123`)
- `taskTitle` — issue title
- `jiraUrl` — canonical URL
- `boardId` — the parent board
- `projectPath` — absolute path to the Orka project
- `template` — which init template ran (`full`, `spike`, or a custom name)
- `branchName` — suggested branch (e.g. `PROJ-123-short-slug`)
- `worktreeParent` — where worktrees go (from moxikit config)

---

## Step 1 — Read the ticket

Fetch fresh from Jira (don't rely on the local mirror alone):

```
GET /rest/api/3/issue/<taskKey>?fields=summary,description,priority,labels,assignee,status,comment,subtasks
```

Read the summary, description, acceptance criteria, comments. This is what you're going to work on — understand it before doing anything else.

If the description references docs (Confluence links, files in the repo, other issues), open them.

---

## Step 2 — Read repo context

Before creating branches or files, know the codebase:
1. Check `CLAUDE.md` and any `README.md` at the project root.
2. Skim `docs/` if it exists.
3. Load the KB project context for the current project:
   ```
   orka kb context --project <projectPath>
   ```
   Or invoke the `kb-project-context` skill if you need the deep dive.

---

## Step 3 — Create the worktree (if the template requires it)

Templates default:
- `full` → `requiresWorktree: true` — spin a fresh worktree for isolated work.
- `spike` → `requiresWorktree: false` — stay in the main tree; nothing to clean up later.

For `requiresWorktree: true`, run moxikit:

```
moxikit worktree create <branchName>
```

Moxikit will create the worktree, set up the branch, and print the resulting path. Capture:
- `worktreePath` — absolute path to the new worktree
- `branchName` — confirmed branch name

If moxikit isn't installed or fails, fall back to plain git:
```
git worktree add <worktreeParent>/<branchName> -b <branchName>
```

Then `cd` into the worktree.

---

## Step 4 — Create the task's docs folder + generate the overview

Every task gets its own docs folder inside the board's storage tree so
the KB entity and the BoardTask both have a stable path to point at.

```
mkdir -p <projectPath>/.claude-orka/.boards/<boardId>/tasks/<taskKey>
```

Inside that folder, write **`overview.html`** — the deep-dive briefing
for the ticket, in **Spanish**, that the developer opens before touching
code. It answers what/why/how. Structure:

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>{{taskKey}} — <taskTitle en español></title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 780px; margin: 32px auto; padding: 0 20px; color: #24292f; line-height: 1.6; }
    h1 { margin: 0 0 4px; }
    .key { color: #6e7781; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
    section { margin: 28px 0; }
    section h2 { border-bottom: 1px solid #d0d7de; padding-bottom: 6px; font-size: 18px; }
    code, pre { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    pre { padding: 12px; overflow-x: auto; }
    ul { padding-left: 20px; }
    .meta { color: #6e7781; font-size: 12px; margin-top: 32px; border-top: 1px solid #d0d7de; padding-top: 12px; }
  </style>
</head>
<body>
  <p class="key">{{taskKey}}</p>
  <h1><Título del ticket, en español></h1>
  <p><Una sola frase de resumen — la esencia del ticket></p>

  <section>
    <h2>¿Qué es este ticket?</h2>
    <p>Explicación clara de qué pide el ticket — funcional, no técnico.</p>
  </section>

  <section>
    <h2>¿Por qué se necesita?</h2>
    <p>Motivación de negocio o del usuario, contexto, dependencias que
       lo hacen relevante ahora. Menciona tickets relacionados si aplica.</p>
  </section>

  <section>
    <h2>Intención</h2>
    <p>El resultado que el ticket persigue en el producto — cómo cambia
       la experiencia o la métrica.</p>
  </section>

  <section>
    <h2>Cómo abordarlo — soluciones posibles</h2>
    <p>Aquí es donde la investigación previa pesa. Enumera 1–3 enfoques
       viables con sus trade-offs. Sé concreto en archivos y componentes
       que tocarías si los conoces.</p>
    <ul>
      <li><strong>Opción A:</strong> …</li>
      <li><strong>Opción B:</strong> …</li>
    </ul>
    <p>Cierra con una recomendación si tienes convicción, o marca como
       spike si necesitas explorar más.</p>
  </section>

  <section>
    <h2>Contexto útil</h2>
    <ul>
      <li>Ticket Jira: <a href="{{jiraUrl}}">{{taskKey}}</a></li>
      <li>Rama: <code>{{branchName}}</code></li>
      <li>Worktree: <code>{{worktreePath}}</code></li>
    </ul>
  </section>

  <p class="meta">Generado por Orka al iniciar la tarea.</p>
</body>
</html>
```

Reemplaza los placeholders `{{…}}` y los stubs `<…>` con contenido real
basado en lo que leíste del ticket + del repo en los Pasos 1 y 2. No
copies el cuerpo del ticket tal cual — sintetiza en español y prioriza
claridad sobre exhaustividad. Guárdalo con `Write`.

---

## Step 5 — Register the KB entity

Create a `task` entity in the KB, linking it to the docs folder + overview
so el panel de la task en el board puede exponer esos accesos igual que
el panel de detalle del KB:

```
orka kb add task "<taskTitle>" \
  --skill board-task-init \
  --property jira_key=<taskKey> \
  --property jira_url=<jiraUrl> \
  --property board_id=<boardId> \
  --property worktree_path=<worktreePath> \
  --property branch_name=<branchName> \
  --property path=.claude-orka/.boards/<boardId>/tasks/<taskKey> \
  --property master_doc=.claude-orka/.boards/<boardId>/tasks/<taskKey>/overview.html \
  --status in_progress
```

`path` y `master_doc` son project-relative — así el Finder de Orka y el
panel de la task pueden abrirlos directamente vía
`/projects/<enc>/files?path=…` y `/files/view?path=…`.

If the project itself is a KB entity (typical Orka setup), link the task to it:
```
orka kb link <newTaskId> part_of <projectEntityId>
```

Grab the returned KB entity id — you'll need it in Step 6.

---

## Step 6 — Link back to the BoardTask

Update the local `BoardTask` so the UI and future syncs know these two records are the same task:

```
orka board update-task \
  --board <boardId> \
  --key <taskKey> \
  --kb-entity <kbEntityId> \
  --worktree-path <worktreePath> \
  --branch-name <branchName>
```

---

## Step 7 — Move the Jira ticket to In Progress

Get the available transitions and pick the "In Progress" one:

```
GET  /rest/api/3/issue/<taskKey>/transitions
POST /rest/api/3/issue/<taskKey>/transitions   { "transition": { "id": "<idOfInProgress>" } }
```

If the ticket is already In Progress (e.g. drift acceptance path), skip this step.

---

## Step 8 — Report ready

Print a short summary in the terminal:
```
Ready to work on <taskKey> — <taskTitle>
- Worktree: <worktreePath> (branch <branchName>)
- KB: <kbEntityId>
- Jira: moved to In Progress
```

You're now in normal working mode — the user drives from here.

---

## Failure modes

- **Worktree already exists** → moxikit and git both refuse. Ask the user: reuse it or pick a new branch name?
- **Ticket not assigned to the current user** → warn, but don't stop. The user may be working on someone else's ticket intentionally.
- **KB entity for this jira_key already exists** → reuse it (`orka kb list task --property jira_key=<key>`); don't create a duplicate. Bump its status back to `in_progress` and update `worktree_path` / `branch_name`.
- **Jira transition unavailable** — the ticket's workflow doesn't allow To Do → In Progress directly. Print the available transitions and ask the user which to use.
