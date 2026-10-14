---
name: knowledge-capture
description: Review and update the durable system knowledge in 04-knowledge/systems/ after work lands. Turns what a task taught you about how the system actually works into a living HTML doc — created, improved or corrected in place — with a revision log that records what changed and when, so a future reader can reconstruct how the system looked at any point. Load at the end of a task (board-task-close Step 5b calls it), or on its own whenever you learn something about the system worth keeping.
---

# Knowledge Capture — keep the system's story current

The point of `04-knowledge/` is to answer a question that neither the
code nor the ticket can: **how does this part of the system actually
work, and how did it get that way?** Code shows the present. Tickets
show one change in isolation. This folder is the connective tissue.

This is not a changelog of commits. It is a changelog of
*understanding* — an entry earns its place when it changes how someone
would reason about the system, not merely because something was edited.

Prerequisite reading: `board-guide` if you're running inside a task.

**Output language: Spanish or English — match whatever the sibling docs
in that folder already use.** Do not mix within one document. Write
plainly: short sentences, common verbs, no academic register. The
reader is a competent engineer who has never seen this subsystem.

---

## Where knowledge lives

```
04-knowledge/
  systems/
    <area>/                     one folder per SYSTEM AREA
      <topic>.html              one file per coherent topic
```

`<area>` is a part of the system that outlives any project — how you'd
name it in conversation: `t5-recommendations`, `billing`, `auth`,
`listing-sync`, `email-pipeline`. `<topic>` is one thing a reader would
want to understand end to end: `scoring.html`, `timezone-handling.html`,
`shared-contacts.html`.

**Filed by system area, not by project or ticket — and this is the one
structural decision worth defending.** A project folder stops being
read the day the project ends, and by then its knowledge is still true
and still needed. A ticket folder is worse: the task's own
`overview.html` already plays that role. Areas accumulate — three
tasks over six months improve the same doc, which is exactly the
"revisit it later and understand" case this folder exists for.

The existing domain folders (`real-estate/`, `tech-stack/`,
`engineering-practices/`, `books/`) stay as they are: those are about
the world around the system. `systems/` is about the system itself.

If a topic genuinely spans areas, put it in the area that *owns* the
behavior and link to it from the others. Do not duplicate prose — a
second copy is a second thing to keep true, and it won't be.

---

## Step 1 — Decide whether there is anything to capture

Ask one question: **would this have saved me time if I'd read it before
starting?** If no, stop here and say so. Most small tasks teach nothing
durable, and an entry that restates the ticket makes the folder worse —
every doc that isn't worth reading trains people not to read the folder.

Capture-worthy, typically:
- how a subsystem actually behaves, especially where it surprised you
- a constraint that isn't visible in the code (an upstream contract, a
  timezone rule, a shared row, a rate limit)
- why something is the way it is, when the code can't say
- a correction: the folder claims X and you proved X is now false

Not capture-worthy:
- what the ticket asked for — that's the task's `overview.html`
- a change that touched only this task's own files
- anything you'd have to invent to fill the section headings

---

## Step 2 — Find what already exists before writing anything

```
ls 04-knowledge/systems/ 2>/dev/null
grep -ril "<keyword>" 04-knowledge/ | head
```

Search by the concepts involved, not by the ticket key. Three outcomes,
in order of preference:

1. **A doc covers this topic** → improve it in place (Step 3b). This is
   the common case and the valuable one.
2. **A doc covers the area but not this topic** → add a section to it if
   it belongs there, or add a sibling file if the topic stands alone.
3. **Nothing exists** → create the area and the file (Step 3a).

Prefer improving over creating. A folder of forty thin documents is
harder to use than eight that are actually maintained.

---

## Step 3a — Create a new doc

Reuse the HTML shell the task docs use — same `<style>` block, so
everything in the project reads alike. Path:
`04-knowledge/systems/<area>/<topic>.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title><Topic> — <Area></title>
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
  <p class="key"><area></p>
  <h1><Topic></h1>
  <p><One sentence: what this document lets you understand.></p>

  <section>
    <h2>How it works</h2>
    <!-- The mechanism, in the order a reader needs it. Name the real
         files, tables, endpoints and jobs — a doc that stays abstract
         cannot be checked against reality later. -->
  </section>

  <section>
    <h2>Why it is like this</h2>
    <!-- History and constraints. This is the part the code cannot
         carry, and usually the reason someone opens this file. Skip
         the section if you genuinely do not know — an honest gap beats
         an invented rationale. -->
  </section>

  <section>
    <h2>Things that surprised us</h2>
    <!-- Where the obvious assumption is wrong. If a task lost hours to
         something, it belongs here. This is often the highest-value
         section in the file. -->
  </section>

  <section>
    <h2>How to check it yourself</h2>
    <!-- Commands, queries or URLs that let a reader verify the above is
         still true. Only what you actually ran. This is what keeps the
         doc falsifiable instead of folklore. -->
  </section>

  <section>
    <h2>Related</h2>
    <ul>
      <li><a href="../<other-area>/<file>.html">…</a> — <why it's related></li>
      <li>Task <code><taskKey></code> — <what it changed here></li>
    </ul>
  </section>

  <p class="meta">Current version: v1.0 · Area: <area> · Last updated <YYYY-MM-DD></p>

  <div class="changelog">
    <h3>Revision log</h3>
    <ul>
      <li><span class="ver">v1.0</span><span class="when"><YYYY-MM-DD></span>Created from <taskKey> — <what was learned, one line>.</li>
    </ul>
  </div>
</body>
</html>
```

---

## Step 3b — Update an existing doc

This is the path that matters most, and it has one rule: **edit the
prose to be true now, and record what changed in the revision log.**

1. Rewrite the affected sections so the document reads as current — a
   reader should never have to diff the changelog against the body to
   learn what is true today.
2. When something is now *wrong* rather than merely incomplete, say so
   explicitly in the log entry ("was: X — corrected, X stopped being
   true when Y"). Silent corrections destroy the value of the log.
3. Bump the version: patch for a clarification, minor for new material,
   major when the understanding changed shape.
4. Update `.meta` and prepend a `<li>` to the revision log:

```html
<li><span class="ver">v1.2</span><span class="when">2026-09-24</span>
  <taskKey> — <what changed and why it matters, one or two lines>.</li>
```

The log is the feature, not decoration. It is what lets a reader ask
"how did we understand this in June?" and get an answer.

---

## Step 4 — Register it in the KB

So the doc is reachable from the graph, not only from the filesystem:

```
orka kb add artifact "<Topic> — <Area>" \
  --skill knowledge-capture \
  --property path="04-knowledge/systems/<area>/<topic>.html" \
  --property area="<area>" \
  --tag knowledge
orka kb link <newId> resulted_from <kbEntityId>     # the task's entity
```

If the artifact already exists, update it instead of adding a duplicate:

```
orka kb list --type artifact --json | jq '.[] | select(.properties.path == "04-knowledge/systems/<area>/<topic>.html")'
orka kb update <existingId> --skill knowledge-capture --property last_task=<taskKey>
```

---

## Step 5 — Hand the reader a link

These are HTML on purpose: the preview route renders them, and with the
overlays the reader can comment on a paragraph or talk to the voice
agent about it without leaving the page.

```
https://<host>:<port>/api/files/preview/<projectB64>/04-knowledge/systems/<area>/<topic>.html?comments=1&voice=1
```

`<projectB64>` is the project path in URL-safe base64 — the same
encoding the file preview already uses elsewhere. Print the URL at the
end of the run so it is one click away.

---

## Failure modes

- **Writing a summary of the ticket.** The most common failure. If the
  doc only makes sense to someone who read the ticket, it belongs in
  the task's `overview.html`, not here.
- **Creating a new file because searching felt slow.** Step 2 exists to
  prevent exactly this. Duplicated topics are how a knowledge folder
  dies.
- **Filing by project.** `systems/<area>/`, never `systems/<project>/`.
  If you cannot name the area without naming the project, the knowledge
  is probably not durable yet — skip it.
- **Inventing the "Why it is like this" section.** If the history isn't
  known, leave the section out. A plausible-sounding invented rationale
  is worse than no rationale, because the next reader will trust it.
- **Silently rewriting something that was wrong.** Correct the prose AND
  say in the log that it was wrong. The correction is the interesting
  part.
