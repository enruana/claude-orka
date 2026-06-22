#!/usr/bin/env node
/**
 * Recover Claude session ids in state.json for one or all Orka projects.
 *
 * Why: Claude Code rotates its session id (on /clear, /compact, internal
 * triggers). Orka's `claudeSessionId` for each branch (main + forks) is
 * frozen at creation time and only refreshed by `syncSessionIds`, which
 * for months has been a silent no-op because it depended on a
 * `sessions-index.json` Claude Code no longer maintains. Result:
 * `claude --resume <stored-id>` on resume loads ancient state, the user
 * sees "lost context".
 *
 * This script does the same matching the new in-process syncSessionIds
 * does (scan per-session `.jsonl`s, greedy assign newest-first to
 * branches main → oldest fork), but offline against `state.json` files
 * directly — so the fix lands BEFORE the next server restart instead of
 * waiting for the first resume after upgrading.
 *
 * Usage:
 *   node scripts/recover-claude-session-ids.js               # all registered projects
 *   node scripts/recover-claude-session-ids.js <projectPath> # one project
 *   node scripts/recover-claude-session-ids.js --dry-run     # show diff, do not write
 *
 * Backups: every modified state.json is copied to
 * `state.json.recover-<timestamp>.bak` next to the original. No deletes.
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects')
const ORKA_GLOBAL_CFG = path.join(os.homedir(), '.orka', 'config.json')

const DRY = process.argv.includes('--dry-run')
const PROJECT_ARG = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'))

function encodeProjectPath(p) {
  // mirrors Claude Code's encoding: replace `/` and other separators with `-`
  return p.replace(/[/.]/g, '-')
}

async function readJSON(p, fallback) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')) } catch { return fallback }
}

/** Scan every <sessionId>.jsonl in the project's Claude folder. */
async function listProjectSessions(projectPath) {
  const dir = path.join(CLAUDE_PROJECTS, encodeProjectPath(projectPath))
  let names
  try { names = await fsp.readdir(dir) } catch { return [] }
  const entries = []
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue
    const sid = f.slice(0, -'.jsonl'.length)
    const full = path.join(dir, f)
    let st
    try { st = await fsp.stat(full) } catch { continue }
    // peek the first lines to capture cwd / sidechain flag
    let cwd = ''
    let sidechain = false
    try {
      const text = await fsp.readFile(full, 'utf8')
      const lines = text.split('\n')
      for (let i = 0; i < Math.min(lines.length, 20); i++) {
        if (!lines[i]) continue
        try {
          const o = JSON.parse(lines[i])
          if (typeof o.cwd === 'string' && !cwd) cwd = o.cwd
          if (o.isSidechain === true) sidechain = true
          if (cwd) break
        } catch {}
      }
    } catch {}
    entries.push({
      sessionId: sid, fullPath: full, fileMtime: st.mtimeMs,
      cwd: cwd || projectPath, isSidechain: sidechain,
    })
  }
  entries.sort((a, b) => b.fileMtime - a.fileMtime)
  return entries
}

/**
 * Pure greedy: each branch claims the newest unclaimed jsonl whose mtime
 * is fresher than its `activitySince`. Caller controls ordering — we order
 * most-recently-active SESSIONS first so the active session gets the
 * freshest jsonls; dormant sessions get whatever remains.
 */
function discoverBranches(available, branchKeys) {
  const result = new Map()
  const claimed = new Set()
  for (const b of branchKeys) {
    const afterMs = b.activitySince ? new Date(b.activitySince).getTime() : 0
    const c = available.find(e => !claimed.has(e.sessionId) && e.fileMtime > afterMs)
    if (c) { result.set(b.key, c); claimed.add(c.sessionId) }
  }
  return result
}

async function processProject(projectPath) {
  const statePath = path.join(projectPath, '.claude-orka', 'state.json')
  const state = await readJSON(statePath, null)
  if (!state) {
    console.log(`  ⊘ ${projectPath} — no state.json`)
    return { changed: 0, errors: 0 }
  }

  const sessions = state.sessions || []
  const available = (await listProjectSessions(projectPath)).filter(e => !e.isSidechain)
  if (available.length === 0) {
    console.log(`  ⊘ ${projectPath} — no .jsonl found`)
    return { changed: 0, errors: 0 }
  }

  console.log(`\n▸ ${projectPath}`)
  console.log(`    available: ${available.length} jsonl  ·  sessions: ${sessions.length}`)

  // Project-wide branch list ordered by session lastActivity DESC; main
  // before forks within a session; forks oldest-first.
  const orderedSessions = [...sessions].sort(
    (a, b) => new Date(b.lastActivity || b.createdAt) - new Date(a.lastActivity || a.createdAt)
  )
  const branchKeys = []
  for (const sess of orderedSessions) {
    branchKeys.push({
      key: `${sess.id}::main`,
      storedId: sess.main.claudeSessionId,
      activitySince: sess.createdAt,
      sessRef: sess, branchType: 'main',
    })
    const forks = (sess.forks || [])
      .filter(f => f.status === 'active' || f.status === 'saved')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    for (const f of forks) {
      branchKeys.push({
        key: `${sess.id}::${f.id}`,
        storedId: f.claudeSessionId,
        activitySince: f.createdAt,
        sessRef: sess, forkRef: f, branchType: 'fork',
      })
    }
  }

  const matches = discoverBranches(available, branchKeys)

  let totalChanges = 0
  for (const b of branchKeys) {
    const m = matches.get(b.key)
    if (!m || m.sessionId === b.storedId) continue
    const oldShort = b.storedId.slice(0, 8)
    const newShort = m.sessionId.slice(0, 8)
    const ts = new Date(m.fileMtime).toISOString().slice(0, 16).replace('T', ' ')
    if (b.branchType === 'main') {
      console.log(`    ✎ ${b.sessRef.name} main: ${oldShort}… → ${newShort}…  (${ts})`)
      b.sessRef.main.claudeSessionId = m.sessionId
    } else {
      console.log(`    ✎ ${b.sessRef.name} fork "${b.forkRef.name}": ${oldShort}… → ${newShort}…  (${ts})`)
      b.forkRef.claudeSessionId = m.sessionId
    }
    totalChanges++
  }

  if (totalChanges === 0) {
    console.log(`    ✓ already up-to-date`)
    return { changed: 0, errors: 0 }
  }

  if (DRY) {
    console.log(`    [dry-run] ${totalChanges} change(s) NOT written`)
    return { changed: totalChanges, errors: 0 }
  }

  // Backup, then atomic write
  const backup = `${statePath}.recover-${Date.now()}.bak`
  await fsp.copyFile(statePath, backup)
  state.lastUpdated = new Date().toISOString()
  const tmp = `${statePath}.tmp.${process.pid}`
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await fsp.rename(tmp, statePath)
  console.log(`    ✓ wrote ${totalChanges} change(s)  (backup: ${path.basename(backup)})`)
  return { changed: totalChanges, errors: 0 }
}

async function main() {
  let projects
  if (PROJECT_ARG) {
    projects = [PROJECT_ARG]
  } else {
    const cfg = await readJSON(ORKA_GLOBAL_CFG, { projects: [] })
    projects = (cfg.projects || []).map(p => p.path)
  }

  console.log(`\nClaude session-id recovery${DRY ? ' (DRY RUN)' : ''}`)
  console.log(`Scanning ${projects.length} project(s)…`)

  let total = 0
  for (const p of projects) {
    const { changed } = await processProject(p)
    total += changed
  }
  console.log(`\nDone. Total fields ${DRY ? 'would change' : 'changed'}: ${total}\n`)
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
