---
name: board-jira-api
description: Jira Cloud REST API cheatsheet for board terminals — auth, search, transitions, comments, attachments. Load whenever any board skill needs to call Jira, or when troubleshooting 4xx responses.
---

# Jira Cloud REST API — Board Cheatsheet

Reference-only. Load this when running `board-sync`, `board-task-init`, or `board-task-close` and you need the actual endpoints or wire format.

Base URL: `$JIRA_URL` (e.g. `https://acme.atlassian.net`) + path.

---

## Auth

Basic auth with email + API token. Never OAuth from a terminal — it's noise.

```
export JIRA_URL="https://acme.atlassian.net"
export JIRA_EMAIL="you@company.com"
export JIRA_API_TOKEN="atlassian-token"

AUTH=$(printf '%s:%s' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | base64 -w0)
```

Every request:
```
curl -sSL -H "Authorization: Basic $AUTH" \
     -H "Accept: application/json" \
     -H "Content-Type: application/json" \
     "$JIRA_URL/rest/api/3/..."
```

Fallback: check `~/.orka/config.json` under `jira.instanceUrl`, `jira.email`, `jira.apiToken` if env vars are missing.

---

## Search / JQL

Recommended endpoint on Jira Cloud (new, paginated):
```
POST /rest/api/3/search/jql
{
  "jql": "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
  "fields": ["summary","description","status","priority","assignee","reporter","labels","comment","subtasks","issuetype"],
  "maxResults": 100,
  "nextPageToken": "<from previous response>"
}
```

Response:
```
{ "issues": [ {...}, ... ], "nextPageToken": "..." }
```

Loop while `nextPageToken` is present.

For quick one-off checks the older endpoint still works:
```
GET /rest/api/3/search?jql=<encoded>&fields=summary,status,assignee
```

---

## Fetch one issue

```
GET /rest/api/3/issue/<key>
GET /rest/api/3/issue/<key>?fields=summary,description,status,priority,assignee,labels,comment
```

Custom fields come back as `customfield_XXXXX` — pull the `raw` field on your local `BoardTask` if you need them.

---

## Transitions (change status)

Two calls: list what's allowed, then perform.

```
GET /rest/api/3/issue/<key>/transitions
```
Response:
```
{ "transitions": [ { "id":"31", "name":"In Progress", "to":{"name":"In Progress"} }, ... ] }
```

Never assume transition ids are stable across projects — always fetch first.

Perform:
```
POST /rest/api/3/issue/<key>/transitions
{ "transition": { "id": "31" } }
```

Returns 204 on success. 400 typically means the target status isn't reachable from the current one.

---

## Comments

Get:
```
GET /rest/api/3/issue/<key>/comment
```
Response: `{ "comments": [...] }`. Each item has `id`, `author.displayName`, `created`, `updated`, `body` (in ADF).

Post: **must be ADF (Atlassian Document Format)**, not a plain string.
```
POST /rest/api/3/issue/<key>/comment
{
  "body": {
    "type": "doc",
    "version": 1,
    "content": [{
      "type": "paragraph",
      "content": [{ "type": "text", "text": "Your comment here" }]
    }]
  }
}
```

Line breaks: use separate `paragraph` blocks, not `\n` inside a single text.

Rendering a fetched ADF comment back to plain text: walk `body.content[*].content[*].text` and join.

---

## Attachments (only what you already need)

List:
```
GET /rest/api/3/issue/<key>?fields=attachment
```

Download (auth-required, follow redirects):
```
curl -sSL -H "Authorization: Basic $AUTH" "$attachment.content" -o "$file"
```

Upload:
```
curl -X POST -H "Authorization: Basic $AUTH" -H "X-Atlassian-Token: no-check" \
  -F "file=@./local.png" \
  "$JIRA_URL/rest/api/3/issue/<key>/attachments"
```

---

## Common status codes

| Code | Meaning | What to do |
|---|---|---|
| 200/204 | Success | — |
| 400 | Bad payload (usually ADF wrong or unknown field) | Re-check the request body |
| 401 | Bad credentials | Re-check env vars; token may have expired |
| 403 | Auth OK but no permission on this project/issue | Ask the user which account should be used |
| 404 | Issue/board doesn't exist for these creds | Confirm the key and project |
| 429 | Rate-limited | Honor `Retry-After` header (seconds) |

---

## Time budget

- Search JQL: aim to finish in one page unless > 100 issues expected.
- Per-issue GET: only when you need fields the search didn't return (custom fields, comments, attachments).
- Transitions: batch by ticket, not by state; one round of transitions per sync at most.

Never poll Jira in a loop — this API is not designed for it, and their rate limits are unforgiving.
