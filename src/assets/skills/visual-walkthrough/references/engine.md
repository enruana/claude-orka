# The engine — how the template moves things

Everything below names the identifiers used in `templates/walkthrough.html`. Rename freely, keep
the shapes. The engine is ~200 lines of plain JS inside one IIFE per figure; no library.

## 1. The cast: dots and their data

```js
const N = 36;                                   // how many things are on stage
const ids = Array.from({ length: N }, (_, i) => i);
const dots = ids.map(() => mk('circle', { r: 4.5, class: 'dot t-item' }));   // appended to <g id="idots">
const ROW = [ { id: 17, own: 'free0', d: '2026-11-02', text: '…', words: 20, out: ['urgent', 'reason', '0.9'] }, … ];
const isNew = id => id < 12, isElig = id => id < 9, isAct = id => id < 3;      // the story's subsets, by index
```

Dot `i` of `ROW` is the i-th candidate; the subsets are prefixes of the id range so a place
function can be a comparison. `ROW` carries what the console prints (dates, text, the answer).
Facts in `ROW` are the story's facts; if invented, say so in the ⓘ.

## 2. The stage: places, layers, owners

```js
const AREA = { inbox: { x: 44, y: 76, w: 172, h: 110 }, queue: {…}, cpassed: { x: 688, y: 88, w: 64, h: 20, sp: 16 },
               read: { x: 524, y: 192, w: 120, h: 8 }, park: {…}, out: {…}, hidden: { x: -40, y: -40, w: 20, h: 8 } };
```

A place is a rectangle in viewBox units (inside the drawn box, not the box itself) plus an
optional `sp` (dot pitch). `targets(place)` packs the dots that land in each place into a grid
centred in that rectangle:

```js
function targets(place) {
  const groups = {}; ids.forEach(id => { const t = place(id); (groups[t] = groups[t] || []).push(id); });
  const out = new Array(N);
  Object.keys(groups).forEach(t => { const a = AREA[t], sp = a.sp || SP, list = groups[t], n = list.length,
    cols = Math.max(1, Math.min(n, Math.floor(a.w / sp))), rows = Math.ceil(n / cols),
    x0 = a.x + (a.w - (cols - 1) * sp) / 2, y0 = a.y + (a.h - (rows - 1) * sp) / 2;
    list.forEach((id, k) => { out[id] = { x: x0 + (k % cols) * sp, y: y0 + Math.floor(k / cols) * sp, t }; }); });
  return out;
}
```

Every box and arrow of the SVG is a `<g id="…" class="layer">` (plus `off` when hidden at
start). A step lists the layers that are visible: `L1 = ['bInbox', 'terr']`, `L2 = L1.concat([…])`.

Owners (the population the things belong to) live in territories drawn under the source box:

```js
const OWN = { free: [[48, 244], [72, 244], …], busy: [[118, 244], …], away: [[188, 244], [212, 244]] };
const OWNMAP = ['free0', 'free1', 'free2', 'busy0', …];   // owner of candidate i
const odots = {}; // OWN key + index → circle, appended to <g id="odots">
```

## 3. The steps

```js
const STEPS = [
  { clock: 'day 1 · 08:00', k: 'in the inbox', t: 'Two or three sentences …', now: '36 requests',
    place: T.s1, layers: L1, scene: 'inbox', hold: 7500 },
  { …, place: T.s4, layers: L4, scene: 'check', hold: 10500, delay: id => isNew(id) ? -1 : 0 },
  …
];
const T = { s1: () => 'inbox', s2: () => 'queue', s4: id => isElig(id) ? 'cpassed' : isNew(id) ? 'park' : 'queue', … };
```

- `place(id)` → the place key where dot `id` ends this step.
- `layers` → which groups are on.
- `scene` → the name of the choreography + console for this step (`SCENES[name]`).
- `hold` → milliseconds ▶ play waits on this step; long enough to read the caption and watch the moves.
- `delay(id)` → per-dot delay in ms for the engine's own move; `-1` means "the scene moves this
  dot by hand" (the engine leaves it at the previous position and tone).
- `cmove` → the step moves owners (so the engine restores their end positions when shown instantly).

`tone(step, id)` returns the CSS tone class each dot has at the end of a step. It is a pure function
of (step, id): the engine uses `tone(step - 1, id)` before a delayed move and `tone(step, id)` after.

## 4. `show(i, instant)` — the heart

```text
step = i mod STEPS.length; tg = targets(s.place); clearScene()
toggle layers; write clock, caption label, text, counter, now line; reset owners
still = instant || reduced-motion || first paint
if (!still) snap every dot to last[id] (the previous step's END layout) — this is what keeps
    rapid clicking honest: step n+1 always starts from step n's end
for each dot: set its tone (previous tone if the scene or a delay will move it later)
hide the console; run SCENES[s.scene](still)
if still: put every dot at tg[id]; last = tg; return
else animate all dots whose delay >= 0 from where they are to tg[id] (900 ms, ease in-out cubic,
    per-dot delay); last = tg
```

Rules the engine enforces: a step shown instantly (deep link, reduced motion, play catching up)
must look exactly like the end of its animation — every scene therefore takes `instant` and, when
true, renders its final console with every row `on` and returns without timers.

## 5. Scenes — the choreography with a reason per item

A scene has four parts: build the console rows, show the console header, return if instant,
schedule the moves and the row reveals on the same clock.

```js
function sceneCheck(instant) {
  const rows = ROW.map((r, i) => '<li' + (instant ? ' class="on"' : '') + '>…</li>').join('');
  conShow('1 · check the owner · the block looks up each request’s owner', 'rule: …', '<ol>' + rows + '</ol>');
  if (instant) { conM.textContent = '12 checked · 9 pass · 3 parked'; return; }
  const fin = targets(T.s4), lis = Array.from(conB.querySelectorAll('li'));
  ROW.forEach((r, i) => moveN(i, QPOS(i), 700, 300 + i * 50, 't-new'));          // line up in the queue zone
  ROW.forEach((r, i) => {
    const t = 1500 + i * STEPMS;                                                  // one item every 520 ms
    moveN(i, SLOT, 260, t, 't-new mv');                                           // into the slot
    later(t + 60, () => { /* dashed line to the owner dot + halo for the lookup */ });
    later(t + 120, () => { lis[i].classList.add('on'); conM.textContent = 'checking ' + (i + 1) + ' of 12'; });
    later(t + 380, () => moveN(i, fin[i], ok ? 350 : 600, 0, ok ? 't-new' : 't-drop'));   // out: passed or parked
  });
  later(1500 + 12 * STEPMS + 300, () => { conM.textContent = '12 checked · 9 pass · 3 parked'; });
}
```

Helpers:

- `later(ms, fn)` — a timer the engine can cancel (`clearScene` clears all timers and the frame loop).
- `moveN(id, to, D, at, cls)` — move one dot to `{x, y}` in `D` ms, starting at `at`, switching its class.
- `moveC(key, to, text, at)` — move an owner dot with a travelling tag (`.mtag`) that says why.
- `token(from, to, at, D)` — a temporary dot that travels along a dashed line (the result going back to its owner).
- `conShow(title, meter, html)` / `reveal(sel, every, from)` — console header and timed row reveals.
- `haloDot(id, at, ms)` — the "moving now" halo without a move (for a step that only points).
- Machine zones: `QPOS(i)` lays the queue out in a 4-wide grid left of the slot; `SLOT` is the
  circle drawn in the block; the exit is a place in `AREA` (`cpassed`) so `targets` packs it.

The reader scene differs in one way: the console shows a **card** (the item being read on the left,
the answer on the right) instead of rows; the text types in (`setInterval`, 40 ms per 5 chars),
a scan sweep runs, the answer fields turn on one by one, then the verdict; the meter counts tokens
and cost. Scope the field timers to the card element (`if (!cardEl.isConnected) return`) so a fast
click to the next step never reveals fields on the wrong card.

## 6. Owners: the result comes back

In the last mechanism step the engine lets the scene move owners: `token()` from the dot in the
output place to the owner dot; then `moveC(ownerKey, [x, y], 'assigned → busy')` moves the owner to
its new territory with the tag. `resetC()` puts owners back at each `show()`; steps after the move
(and the move step itself when instant) call `placeC()` to pin the moved owners at their end
positions. Keep the number of moved owners small (two or three) so the eye can follow.

## 7. Controls, keyboard, deep links, play, full screen

- Controls above the caption: `◀ prev`, `next ▶`, `▶ play` (toggles to `❚❚ pause`), the counter
  `n / N`, the ⓘ button, the full-screen button.
- `fig.addEventListener('keydown', …)` handles ← → on the focused figure (`tabindex="0"`), stopping
  propagation so two figures on one page do not both move.
- `#step=N` in the URL opens that step instantly.
- Play waits `STEPS[step].hold` and stops on `visibilitychange` (hidden tab timers stall).
- Full screen: the shared block at the end of the template handles the button, the Esc, the
  modals (moved into the full-screen element while open) and the fallback (class `fs` on the
  figure when the browser refuses). CSS turns the figure into a flex column where the drawing
  takes the free height and the console is capped at 36 vh with its own scroll.
- Reduced motion: `matchMedia('(prefers-reduced-motion: reduce)')` → every step is shown instantly.

## 8. Timing that reads well

| what | value | why |
|---|---|---|
| engine move | 900 ms, ease in-out cubic | long enough to see, short enough to not wait |
| per-dot stagger (engine) | 12 ms × id | a wave, not a blob |
| machine cadence | 520 ms per item | one item at a time, followable |
| console row reveal | 260–650 ms | matches the move it explains |
| reader per item | 2600 ms | typing + scan + four fields + verdict |
| hold per step (play) | 6.5–18 s | caption read + choreography complete |

## 9. What to check in the renders

Each step at rest (instant) equals the end of its animation. No dot overlaps a label. The console
never exceeds the figure (phone width: rows wrap, nothing scrolls sideways except the drawing).
The caption's "now" counts equal the dots you can count. The last step leaves everything where
the story ends.
