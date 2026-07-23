---
name: board-sync
description: How the board master terminal syncs from Jira — auth, pull tickets/comments/docs, diff against local, mark drift. Load when running the sync ritual in a master terminal (usually after the user hits Sync or types "sync" into the master pane).
---

# Board Sync — Master Ritual

You are running inside a **Board master terminal**. The user just triggered a sync. Your job is to bring the local board in step with Jira, without ever writing back to Jira.

Prerequisite reading: `board-guide` (schema + CLI), `board-jira-api` (auth + endpoints).

---

## Step 1 — Authenticate

Prefer environment variables (they're the recommended path):
- `JIRA_URL` — e.g. `https://acme.atlassian.net`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`

If any is missing, check `~/.orka/config.json` under `jira.*`. If still missing, stop and ask the user to configure them.

Basic auth header:
```
Authorization: Basic $(echo -n "$JIRA_EMAIL:$JIRA_API_TOKEN" | base64)
```

---

## Step 2 — Load the board config

```
orka board list --project <projectPath>
```

Find the `boardId` matching `orka-board-master-<boardId>` (the tmux session you're running inside). Then read the config:

```
cat <project>/.claude-orka/.boards/<boardId>/config.json
```

Fields to use: `jiraUrl`, `jql` (if set — otherwise default to `assignee = currentUser() AND resolution = Unresolved`), `columns`, `lastSyncedAt`.

---

## Step 3 — Pull tickets from Jira

Use the Jira REST API (`board-jira-api` skill has the endpoints). Recommended: `POST /rest/api/3/search/jql` with the board's JQL.

For each Jira issue:
1. Extract `key`, `fields.summary`, `fields.status.name`, `fields.priority.name`, `fields.assignee.displayName`, `fields.reporter.displayName`, `fields.labels`, `fields.description`.
2. Map Jira status → local column. Default mapping: `To Do → todo`, `In Progress → in-progress`, `In Review → review`, `Done → done`. Custom columns must be listed in `BoardState.columns`.
3. Look up local task: `orka board show-task --board <id> --key <key>`.

---

## Step 4 — Apply the diff

All human-facing text you write into the local board must be in **Spanish**
— that includes `--title` and `--description`. Titles you can usually
translate literally; `description` should be a short *explanatory* summary
in Spanish (not a raw dump of the Jira description). See "Spanish
description shape" below.

For each ticket:

- **New in Jira, absent locally** → `orka board add-task --board <id> --key <k> --title "<título en español>" --description "<resumen en español>" --status <mapped> --assignee "..." --priority "..." --labels "l1,l2"`. Include `--raw '<escaped JSON>'` if the ticket has custom fields worth preserving.

- **Local exists, Jira changed non-status fields** → `orka board update-task --board <id> --key <k> --title "..." --description "..." --priority "..." --assignee "..."`. Never overwrite `kbEntityId`, `claudeSessionId`, `terminalPaneId`, `ttydPort`, `worktreePath`, or `branchName` — those are local-only.

- **Jira removed the ticket from the query** → do NOT delete locally. Log it and leave the local task in place (the user may still be working on it).

- **Status changed in Jira** — see Step 5 (drift).

### Spanish description shape

For every task you add or update, synthesize a 3–8 sentence description in
Spanish that a developer landing on the board can read and grasp fast.
Prefer explanatory prose over bullet lists. Cover, in this order:

1. **¿Qué es?** — resumen concreto de lo que pide el ticket, en 1–2 frases.
2. **¿Por qué?** — motivación / problema que resuelve o intención del PM,
   inferida del cuerpo del ticket, los comentarios, y el label / componente.
3. **Contexto útil** — dependencias, tickets relacionados (por key),
   componentes del código si el ticket los menciona.

Ejemplo (tono buscado):
> Añade filtros por país al listado de facturas para que el equipo de
> finanzas pueda cerrar mes sin exportar todo a Excel. El ticket nace de
> una petición de Legal (comentario del 12/07) y bloquea PROJ-98, que ya
> depende de este filtro para el reporte trimestral.

Nunca escribas la descripción como "traducción literal del ticket" — es
una explicación pensada para el humano que va a trabajar en la tarea.

---

## Step 5 — Drift detection

A ticket is in drift when:
1. Jira status ≠ local status, AND
2. There is no active task-terminal responsible for the transition (`terminalPaneId` empty or the pane is dead).

If drift found:
```
orka board mark-drift --board <id> --key <k> --from <localStatus> --to <jiraStatus>
```

Do NOT run `orka board start-task` or change the status automatically. The UI surfaces the drift as a badge and the user decides.

If Jira status matches local, and there is a stale drift record, clear it:
```
orka board ack-drift --board <id> --key <k>
```

---

## Step 6 — Pull comments and attachments

For each ticket that changed since `lastSyncedAt`:

```
GET /rest/api/3/issue/<key>/comment
```

For each new comment (compare `created` timestamps against `attachments/<key>/comments.jsonl` if it exists):
```
orka board attach-comment --board <id> --key <k> --author "..." --body "..."
```

For linked docs (Atlassian-native Confluence pages, links in the description, etc.), fetch and store via:
```
orka board attach-doc --board <id> --key <k> --path <local-file-path>
```

Skip attachments larger than a few MB unless the user asked for them.

---

## Step 7 — Wrap up

Update `lastSyncedAt`:
```
orka board sync --board <id>       # bumps lastSyncedAt server-side
```

Report a compact summary to the user in the terminal:
- N added, N updated, N unchanged
- M drift alerts (list keys)
- K new comments across L tickets

That's it — never write to Jira from the master.

---

## Failure modes

- **401/403** → auth failed. Print the offending header (redacted) and stop. Tell the user to check env vars.
- **429** → rate-limited. Wait per `Retry-After` and retry. If it keeps happening, report and stop.
- **JQL invalid** → print the JQL, tell the user to fix `config.json`. Do not guess.
- **Schema mismatch** — a Jira status that doesn't map to any local column → add it to `BoardState.columns` first (with the user's OK) via `orka board update --add-column <name>`, then re-run.
