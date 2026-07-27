---
name: board-task-init
description: Boot ritual for a board task-terminal — create the worktree (moxikit), read docs and the Jira ticket, register the task in Orka KB, link everything back, and move the Jira ticket to In Progress. Load when a task-terminal spawns and its init prompt fires.
---

# Board Task — Init Ritual

You are running inside a **task-terminal** for a Jira ticket. You just booted. Your job is to get the workspace ready to start coding and to make sure the ticket, the local BoardTask, and the KB entity are all linked.

Prerequisite reading: `board-guide` (board schema + CLI), `kb-guide` (KB shape), `kb-project` (**la convención de tier + carpeta + `path` property que debes seguir**), `board-jira-api` (Jira endpoints).

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

## Step 1 — Look for an existing KB entity FIRST

**Antes de crear cualquier cosa** revisa si este ticket ya tiene una
entidad en el KB. Si existe, retomamos con todo su contexto en vez de
duplicar. Un mismo ticket puede pasar por varias sesiones (close +
reopen, spawn manual desde la CLI, drift acceptance, etc.) — la única
regla dura es: **una entidad por `jira_key`**.

Chequeo, en orden:

1. Si el prompt trae ya un `kbEntityId` (el BoardTask lo persiste tras el
   primer init) → cargalo: `orka kb show <kbEntityId>`.
2. Si no, busca por `jira_key`:
   ```
   orka kb list --property jira_key=<taskKey> --json
   ```
   Filtra entre los tiers work-tier (`task` / `project` / `spike` / `bug`).

Si **hay match**:

- Lee la entidad completa: `orka kb show <id>` — mira `properties.path`,
  `properties.master_doc`, `properties.worktree_path`, `status`, historia.
- Lee el `master_doc` (`overview.html`) para recuperar contexto —
  incluyendo el `<section class="changelog">` con lo que se decidió antes.
- Lee los timelines vinculados si aplica: `orka kb timeline --entity <id>`.
- **Retoma en vez de duplicar**:
  - Bump el status de la entidad a `in_progress` si no lo estaba
    (`orka kb update <id> --status in_progress`).
  - Actualiza `worktree_path` / `branch_name` si cambiaron para esta
    sesión (nuevo worktree, rebase, etc.).
  - **Salta el Step 4 (crear folder + overview)** — reusa el que ya
    existe. Si necesitas anotar el reboot, agrega una entrada al
    `<section class="changelog">` en el overview (version bump menor,
    p.ej. `v1.2 → v1.3` con nota "Retomada tras reopen — YYYY-MM-DD").
  - **Salta el Step 5 (crear la entidad KB)** — la entidad ya existe.
  - Continúa con Step 6 (linkear al BoardTask, updating `kbEntityId`
    con el id recuperado) y Steps 7-8.

Si **no hay match**: sigue el flujo completo desde el Step 2. Cuando
llegues al Step 5 harás el `orka kb add` normal.

---

## Step 2 — Read the ticket

Fetch fresh from Jira (don't rely on the local mirror alone):

```
GET /rest/api/3/issue/<taskKey>?fields=summary,description,priority,labels,assignee,status,comment,subtasks
```

Read the summary, description, acceptance criteria, comments. This is what you're going to work on — understand it before doing anything else.

If the description references docs (Confluence links, files in the repo, other issues), open them.

---

## Step 3 — Read repo context

Before creating branches or files, know the codebase:
1. Check `CLAUDE.md` and any `README.md` at the project root.
2. Skim `docs/` if it exists.
3. Load the KB project context for the current project:
   ```
   orka kb context --project <projectPath>
   ```
   Or invoke the `kb-project-context` skill if you need the deep dive.

---

## Step 4 — Create the worktree (if the template requires it)

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

## Step 5 — Resolve the entity's folder (via the KB convention)

**Salta este paso** si en Step 1 encontraste una entidad existente —
reusas su `properties.path` y `properties.master_doc`.


**IMPORTANT**: no inventes rutas propias para el ticket. La ubicación de
la carpeta y del documento la manda el skill `kb-project` (o `kb-track`
para trabajo más ligero). Cargalo y sigue *su* convención — típicamente
PARA-style dentro del vault del proyecto (p.ej.
`03-projects/active/<slug>/` para proyectos, o el path que tu vault
tenga). **Nunca uses `.claude-orka/.boards/*` para docs de entidades**;
esa carpeta es storage interno de Orka Boards, no del KB.

Pasos:

1. Carga `kb-project`. Mira sus ejemplos de `--property path=…` para
   identificar la convención del vault en el que estás.
2. Decide el **tier** correcto para este ticket de Jira:
   - `project` si el ticket es un outcome bounded con fecha (feature de
     tamaño medio, epic pequeño).
   - `task` si es trabajo atómico (single-sitting / single-PR).
   - `spike` si es exploración time-boxed.
   - `bug` si es un defecto.
3. Resuelve el `path` project-relative que corresponde según esa
   convención + tier + slug del ticket. Ejemplos guía:
   - `03-projects/active/<slug>/` para un `project`
   - `03-projects/active/<parent-slug>/tasks/<slug>/` para un `task` que
     cuelga de un project existente
   - Si el vault no tiene todavía convención clara para tasks, pregúntale
     al usuario dónde quiere que vivan (una sola vez — a partir de ahí
     usa esa carpeta).
4. `mkdir -p <projectPath>/<resolvedPath>`.
5. Adentro, escribe `overview.html` con la estructura de la siguiente
   sección.

Guarda `<resolvedPath>` — lo usarás como `path` de la entidad KB en el
Step 5.

### overview.html — estructura

En **español**, deep-dive briefing del ticket que el developer abre antes
de tocar código. Responde qué/por qué/cómo. Estructura:

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
    .changelog { margin-top: 40px; border-top: 1px dashed #d0d7de; padding-top: 12px; color: #6e7781; font-size: 11px; }
    .changelog h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 8px; color: #57606a; }
    .changelog ul { margin: 0; padding-left: 16px; list-style: none; }
    .changelog li { padding: 4px 0; }
    .changelog li + li { border-top: 1px dotted #eaeef2; }
    .changelog .ver { display: inline-block; min-width: 42px; font-family: monospace; color: #24292f; }
    .changelog .when { color: #8b949e; margin-right: 8px; }
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

  <p class="meta">Generado por Orka al iniciar la tarea. <strong>Versión actual: v1.0</strong></p>

  <!-- Changelog embebido: cada revisión del documento agrega una entrada
       arriba (más reciente primero). Sirve como paper trail sutil sin
       necesidad de archivos externos. Mantén los `data-version` únicos y
       secuenciales (v1.0 → v1.1 → v2.0 según envergadura del cambio). -->
  <section class="changelog" aria-label="Historial de cambios">
    <h3>Historial</h3>
    <ul>
      <li data-version="v1.0">
        <span class="ver">v1.0</span>
        <span class="when">{{ISO date}}</span>
        Documento generado al iniciar la tarea.
      </li>
    </ul>
  </section>
</body>
</html>
```

Reemplaza los placeholders `{{…}}` y los stubs `<…>` con contenido real
basado en lo que leíste del ticket + del repo en los Pasos 1 y 2. No
copies el cuerpo del ticket tal cual — sintetiza en español y prioriza
claridad sobre exhaustividad. Guárdalo con `Write`.

---

## Step 6 — Register the KB entity

**Salta este paso** si en Step 1 encontraste una entidad existente —
solo actualiza status / worktree_path / branch_name en ella con
`orka kb update <id> ...`. El resto de comandos abajo son para el path
"entidad nueva".


Crea la entidad **con el tier decidido en Step 4** (`project` / `task` /
`spike` / `bug`) y **con `path` = `<resolvedPath>` de Step 4** —
`master_doc` = `<resolvedPath>/overview.html`. Sigue la forma de comando
que `kb-project` documenta; añade los properties específicos del board
(Jira link + board_id) por encima:

```
orka kb add <tier> "<taskTitle>" \
  --skill board-task-init \
  --property description="<resumen en español>" \
  --property jira_key=<taskKey> \
  --property jira_url=<jiraUrl> \
  --property board_id=<boardId> \
  --property worktree_path=<worktreePath> \
  --property branch_name=<branchName> \
  --property path=<resolvedPath> \
  --property master_doc=<resolvedPath>/overview.html \
  --status in_progress
```

Ambos `path` y `master_doc` son project-relative para que el Finder de
Orka y el Quick Access del panel del board task los abran directamente
vía `/projects/<enc>/files?path=…` y `/files/view?path=…`.

Si el proyecto es una entidad KB (setup típico Orka), enlaza el task a él
con la relación que `kb-project` recomienda (`scope-of`, `child-of`,
`part_of` según el tier):
```
orka kb link <newTaskId> <relation> <projectEntityId>
```

Guarda el `<newTaskId>` — lo usas en Step 6.

---

## Step 7 — Link back to the BoardTask

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

## Step 8 — Move the Jira ticket to In Progress

Get the available transitions and pick the "In Progress" one:

```
GET  /rest/api/3/issue/<taskKey>/transitions
POST /rest/api/3/issue/<taskKey>/transitions   { "transition": { "id": "<idOfInProgress>" } }
```

If the ticket is already In Progress (e.g. drift acceptance path), skip this step.

---

## Step 9 — Report ready

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
- **Duplicate KB entity detected mid-flow** — si Step 1 no encontró la
  entidad pero al hacer `orka kb add` en Step 6 sale un conflicto de
  `jira_key`, es porque otra sesión la creó en paralelo (race). Aborta
  el add, ejecuta Step 1 otra vez, y retoma desde el path "reuse".
- **Jira transition unavailable** — the ticket's workflow doesn't allow To Do → In Progress directly. Print the available transitions and ask the user which to use.
