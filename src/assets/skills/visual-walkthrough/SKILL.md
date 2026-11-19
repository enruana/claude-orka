---
name: visual-walkthrough
description: Turn a process, pipeline, mechanism or design into a self-contained HTML walkthrough where things move through places, one step at a time — dots that travel between boxes, machine blocks with a queue, a slot and an exit, a console under the drawing that narrates what happens to each item and why, an AI-reader box that shows what a model reads and answers, a population of owners the items come back to. Controls on top (prev / next / play), a caption per step, the explanations behind an ⓘ modal, status and history in folds, full screen. Use whenever someone asks for a presentation, explainer, "slides", a "one day in the life of…" figure, or to make a design visual and easy to follow for people who do not know the system.
---

# Visual walkthrough — things that move through places, one step at a time

The style this skill reproduces came from a figure called "One day in the life of the notes":
forty notes as dots travel from an api box to a lake box, pass a watermark, line up in a checker
block, go through its slot one by one while a console prints the check for each one, fall to a bin
or move on, enter an AI reader whose card shows the text being read and the four fields of the
answer appearing, and the two that matter travel back to the contact they belong to, who crosses
to another territory. Eight steps. Nobody in the room needed to know ML to follow it.

**What made it work is not the CSS.** It is the method below. Keep the method; the look is yours
(the template ships one look that you may keep or replace).

## The method, in one paragraph

Every concept becomes a **thing** (a dot), every state becomes a **place** (a box), every rule
becomes a **machine** (a block with a queue, a slot and an exit) and every step **moves things
between places for a reason that is printed at the same moment** in a console under the drawing.
The viewer never has to imagine anything: if the text says "eight pass, four fall", eight dots
move right and four fall down, one at a time, while a line per dot says why. One step = one idea.
Nothing moves without a reason. Nothing is explained that cannot be seen.

## Workflow

1. **Write the story before any code** — use `references/story-template.md`. Decide the cast
   (what is a dot), the stage (which places exist and where they are), the steps (6 to 10; each
   with a label, two or three sentences, a "now" line with the counts, where every dot is at the
   end, who moves, and what the console shows), the owners if the things belong to someone, and
   what goes behind the ⓘ (the explanations) and into folds (status, asks, history). A step that
   cannot be described as "these move from here to there because …" is not a step: split it or
   drop it. Show the story to the user in chat and get a yes before building.
2. **Scaffold** from `templates/walkthrough.html` (a complete working example: inbox → queue →
   watermark → checker block → AI reader → the result meets its owner). Copy it next to the
   user's docs with their naming convention, then replace the story: the `AREA` map, the SVG
   layers, `STEPS`, the `tone()` rules, the data rows and the scene functions.
3. **Build the stage** (the SVG): one `<g class="layer">` per box or arrow so steps can reveal
   them in order; every machine block drawn with its three zones (queue · slot · passed) and its
   one-line rule under the title; owners' territories under the source box when things belong to
   someone; the clock in the top-left corner when time matters.
4. **Script the steps**: `STEPS[i] = { clock, k, t, now, place, layers, scene, hold, delay }`.
   `place(id)` says where each dot ends; the engine packs dots inside each place and animates
   from the previous layout. Scenes do the choreography that needs a reason per item.
5. **Write the console for every step**, including the quiet ones. A scene without choreography
   still reveals its rows one by one. The meter at the console's right shows the running count.
6. **Verify like the audience**: `node scripts/check.mjs page.html` (parse, structure, story
   completeness), then `node scripts/render.mjs page.html --out shots/` and read every PNG: does
   each step say one thing, is every move explained, is nothing clipped, does step n+1 start
   exactly where step n ended. Fix, re-render, until yes.
7. **Finish the page**: eyebrow, title, a two-sentence lede, the figure, the ⓘ template, the
   folds, a version history. No change highlights. No person names in the body (roles instead).

## Rules of the style

- **One figure group = one mechanism.** If the audience needs two mechanisms, make two figures,
  each with its own stepper. Do not stack steps from different mechanisms in one stepper.
- **Controls on top**, then the caption, then the drawing, then the console. The viewer reads
  top-down: what step, what it says, what moves, why each one moved.
- **Caption = three lines**: a small label (`step 4 · 1 · filter contacts`), two or three plain
  sentences, and a "now" line with counts (`12 changed · 8 with behaviour before · 4 never
  opened`). The sentences say what the viewer is about to see, in the order they will see it.
- **Every move has a visible reason at the moment it happens.** A dot that falls to the bin gets
  its console line turning on in the same instant; a lookup draws a dashed line to what it looked
  up; an item entering a machine passes through the slot, not around it.
- **Gradual, one by one, in a stable order.** Items move in sequence with a fixed cadence (about
  half a second per item); the audience must be able to follow a single dot with their eyes.
- **Separate machines, never a reused container.** Two rules are two blocks, each with its own
  queue, slot and exit, and a visible hand-over between them.
- **Places keep their layout between steps.** A dot that did not move stays exactly where it was.
  Step n+1 starts from step n's final positions (the engine snaps before animating, so rapid
  clicking never leaves stale positions).
- **Tones carry the state**, consistently across steps: untouched, candidate, passed, dropped,
  found, done. One halo animation marks "moving now".
- **The AI reader is drawn as a model reading**: a box with a multicolour border, a slot called
  "reading", a card in the console with the item's text typing in, a scan sweep, the answer
  fields appearing one by one, a verdict line, and a running token / cost meter.
- **Things that belong to someone come back to them.** When the result of the pipeline concerns
  an owner, the owner population is on stage from step 1 (territories), the machine looks them
  up there, and the result travels back as a token before the owner changes territory with a
  travelling tag that says why.
- **Stop where the mechanism stops.** What another system does with the result belongs to that
  system's figure. The last step may look beyond one day (backfill, version change) but adds no
  new mechanism.
- **Explanations go behind ⓘ**, in a modal with tables and short lists: cadences, contracts,
  schemas, cost, rules. Status (decided / assumed / open), asks and version history go into
  folds at the end. The page itself stays clean: figures and one lede.
- **Play, keyboard and full screen** always: ▶ play with a hold per step, ← → on the figure,
  `#step=N` deep links, a full-screen button, reduced-motion honoured (positions jump, no
  animation, console rows shown at once).
- **Facts are real or marked illustrative.** Counts in the "now" line and the console come from
  the story's data; if they are invented to show the shape, the ⓘ says so.

## What to hand back

- The HTML file (self-contained, fonts from Google Fonts only, no other network), renders clean
  at 1200 px wide and at 390 px wide, console errors zero.
- The story worksheet (as a fold or in the README notes) so the next person can extend it.
- A line in the folder's README index if the project keeps one.

Read `references/engine.md` for the API of the engine and `references/story-template.md` for the
worksheet before touching the template.
