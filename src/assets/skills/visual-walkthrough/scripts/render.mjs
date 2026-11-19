#!/usr/bin/env node
// Render every step of a visual-walkthrough figure to PNG with headless Chrome (puppeteer).
// usage: node render.mjs page.html [--out shots] [--figure "#fig"] [--width 1200] [--height 1000]
//        [--wait 2600] [--steps N] [--fs] [--phone]
// Puppeteer is resolved from the current project, then from the Orka package (orka prepare installs it).
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: node render.mjs page.html [--out dir] [--figure sel] [--width n] [--height n] [--wait ms] [--steps n] [--fs] [--phone]'); process.exit(2); }
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = name => args.includes('--' + name);
const out = opt('out', 'shots'), sel = opt('figure', 'figure.fig');
const width = flag('phone') ? 390 : +opt('width', 1200), height = flag('phone') ? 1400 : +opt('height', 1000);
const wait = +opt('wait', 2600), maxSteps = +opt('steps', 40);

async function loadPuppeteer() {
  try { return (await import('puppeteer')).default; } catch {}
  const req = createRequire(import.meta.url);
  const candidates = [];
  try { candidates.push(join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), '@enruana', 'claude-orka')); } catch {}
  for (const base of candidates) {
    try { const p = req.resolve('puppeteer', { paths: [base] }); return (await import(pathToFileURL(p).href)).default; } catch {}
  }
  throw new Error('puppeteer not found: run `npm i -D puppeteer` in the project or `orka prepare`');
}

const puppeteer = await loadPuppeteer();
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width, height, deviceScaleFactor: 1 });
const problems = [];
page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load' });
await page.evaluate(() => document.fonts && document.fonts.ready);
await new Promise(r => setTimeout(r, 900));
if (flag('fs')) await page.evaluate(s => document.querySelector(s).classList.add('fs'), sel);
const fig = await page.$(sel);
if (!fig) { console.error('no element matches ' + sel); await browser.close(); process.exit(2); }
const counter = async () => page.evaluate(s => { const f = document.querySelector(s); const c = f.querySelector('.steps'); return c ? c.textContent.trim() : ''; }, sel);
let first = await counter(), n = 0;
for (;;) {
  n++;
  await new Promise(r => setTimeout(r, wait));
  const name = join(out, 'step-' + String(n).padStart(2, '0') + '.png');
  await fig.screenshot({ path: name });
  console.log(name, '·', await counter());
  if (n >= maxSteps) break;
  await page.evaluate(s => document.querySelector(s).focus(), sel);
  await page.keyboard.press('ArrowRight');
  await new Promise(r => setTimeout(r, 150));
  if ((await counter()) === first && first) break;
}
await browser.close();
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
console.log('console clean · ' + n + ' step(s) rendered');
