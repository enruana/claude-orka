#!/usr/bin/env node
// Static checks for a visual-walkthrough page: scripts parse, tags balance, the parts of the
// style are present, every step has its label / caption / now line / scene, every scene exists.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node check.mjs page.html'); process.exit(2); }
const html = readFileSync(file, 'utf8');
const fails = [], notes = [];
const ok = (cond, msg) => (cond ? notes.push('ok  ' + msg) : fails.push('FAIL ' + msg));

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.trim());
ok(scripts.length > 0, 'has at least one inline script');
scripts.forEach((s, i) => { try { new Function(s); notes.push('ok  script ' + (i + 1) + ' parses'); } catch (e) { fails.push('FAIL script ' + (i + 1) + ' does not parse: ' + e.message); } });

const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
const voids = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'path', 'circle', 'rect', 'line', 'stop', 'use', 'polyline', 'polygon', 'ellipse']);
const stack = []; let balanced = true;
for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
  const [, close, tag, self] = m; const t = tag.toLowerCase();
  if (self || voids.has(t) || t.startsWith('!')) continue;
  if (!close) stack.push(t); else if (stack.length && stack[stack.length - 1] === t) stack.pop(); else { balanced = false; fails.push('FAIL tag mismatch at </' + t + '> (open: ' + stack.slice(-3).join(' > ') + ')'); break; }
}
if (balanced) ok(stack.length === 0, 'tags balance' + (stack.length ? ' (unclosed: ' + stack.join(', ') + ')' : ''));

const figs = [...html.matchAll(/<figure[^>]*class="[^"]*\bfig\b[^"]*"[^>]*>([\s\S]*?)<\/figure>/g)];
ok(figs.length > 0, figs.length + ' figure(s) with class fig');
figs.forEach((f, i) => {
  const inner = f[1], label = 'figure ' + (i + 1);
  const ctrl = inner.indexOf('class="ctrl top"'), cap = inner.indexOf('class="cap'), draw = inner.search(/<svg|class="scroll"/);
  ok(ctrl >= 0 && cap > ctrl && draw > cap, label + ': controls on top, then the caption, then the drawing');
  ok(/class="con"/.test(inner), label + ': has a console under the drawing');
  ok(/data-info=/.test(inner), label + ': has an ⓘ button');
  ok(/data-fs/.test(inner), label + ': has a full-screen button');
  ok(/id="[^"]*prev"/.test(inner) && /id="[^"]*next"/.test(inner), label + ': has prev / next');
  ok(/tabindex="0"/.test(f[0]), label + ': is focusable (tabindex="0") for the keyboard');
  ok(/class="layer/.test(inner), label + ': the drawing is split into layers');
});
ok(/<template id="/.test(html), 'explanations live in a <template> for the modal');
ok(/class="fold/.test(html), 'status / history folds present');
ok(/prefers-reduced-motion/.test(html), 'reduced motion honoured');
ok(/ArrowRight/.test(html), 'keyboard ← → handled');
ok(/step=\(\\d\+\)|step=\(\\d\+\)|\/step=/.test(html), '#step=N deep link parsed');
ok(!/orka-diff-new|<mark[\s>]/.test(html), 'no change highlights left in the page');

const all = scripts.join('\n');
for (const m of all.matchAll(/const STEPS = \[([\s\S]*?)\n\s*\];/g)) {
  const entries = m[1].split(/\n\s*\{/).filter(e => /\bk:/.test(e));
  entries.forEach((e, k) => {
    const has = f => new RegExp('\\b' + f + ':').test(e);
    ok(has('k') && has('t') && has('now') && has('scene') && has('place') && has('layers'), 'step ' + (k + 1) + ' has k · t · now · scene · place · layers');
  });
  const scenes = [...m[1].matchAll(/scene: '(\w+)'/g)].map(x => x[1]);
  const map = /const SCENES = \{([\s\S]*?)\};/.exec(all);
  scenes.forEach(s => ok(map ? new RegExp('\\b' + s + '\\b').test(map[1]) : new RegExp('function scene' + s[0].toUpperCase() + s.slice(1)).test(all), 'scene «' + s + '» is defined'));
}
console.log(notes.join('\n'));
if (fails.length) { console.log(fails.join('\n')); console.log('\n' + fails.length + ' problem(s)'); process.exit(1); }
console.log('\nall checks pass');
