/**
 * Session-watcher hook installer.
 *
 * Writes a small set of Claude Code hook entries into a project's
 * `.claude/settings.json` so the running Orka server can track per-session
 * "waiting for user input" state and Claude session id rotations.
 * Independent of the agent system: these hooks are installed unconditionally
 * for every Orka project on init / reinitialize, and coexist with agent
 * hooks via a unique URL marker so the two systems do not stomp each other
 * when (re-)installing.
 *
 * Events tracked:
 *  - Notification       → may set `waitingForInput=true` on the receiver side
 *                         (filtered by message content there).
 *  - UserPromptSubmit   → clears the flag.
 *  - PreToolUse         → clears the flag.
 *  - SessionStart       → deterministically re-attaches Orka branches to the
 *                         new claudeSessionId after /clear or /compact,
 *                         using the tmux pane id (from $TMUX_PANE) to
 *                         identify which branch rotated.
 */

import fs from 'fs-extra'
import path from 'path'
import { logger } from '../utils'

/** URL path used by these hooks. Must stay stable — also acts as the marker
 *  used to filter and replace prior entries on reinstall, and to distinguish
 *  these from agent hooks (which point to `/api/hooks/<agentId>`). */
export const SESSION_WATCHER_PATH = '/api/sessions/hook'

const WATCHED_EVENTS = ['Notification', 'UserPromptSubmit', 'PreToolUse', 'SessionStart'] as const

interface HookEntry {
  matcher?: string
  hooks: Array<{ type: 'command'; command: string }>
}

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

function settingsPath(projectPath: string): string {
  return path.join(projectPath, '.claude', 'settings.json')
}

async function readSettings(projectPath: string): Promise<ClaudeSettings> {
  const p = settingsPath(projectPath)
  if (await fs.pathExists(p)) {
    try {
      return await fs.readJson(p)
    } catch {
      logger.warn(`session-watcher: failed to parse ${p}; starting fresh`)
      return {}
    }
  }
  return {}
}

async function writeSettings(projectPath: string, settings: ClaudeSettings): Promise<void> {
  const p = settingsPath(projectPath)
  await fs.ensureDir(path.dirname(p))
  await fs.writeJson(p, settings, { spaces: 2 })
}

function buildCommand(host: string, port: number, event: string, protocol: 'http' | 'https'): string {
  // `?event=` is a redundant hint — the Claude Code payload carries
  // `hook_event_name`, but the query string makes the server log readable
  // and gives us a fallback if the payload field name ever changes.
  //
  // `-k` (insecure) is required when protocol=https because the server
  // uses a Tailscale-issued cert whose SAN is the *.ts.net hostname, not
  // `localhost` — strict verification would reject the local hit. Hook
  // payloads do not contain secrets we'd care to protect against MITM on
  // a loopback connection, so this is safe.
  //
  // `X-Tmux-Pane` header: when Claude Code runs inside tmux, `$TMUX_PANE`
  // is set to the containing pane id (e.g. `%1`). The receiver uses this
  // to route SessionStart rotations to the exact Orka branch that
  // triggered them — the only reliable identifier we have that survives
  // `/clear` and `/compact` (both of which mint a new claudeSessionId).
  // Empty when Claude is invoked outside tmux; the receiver falls back
  // to cwd+session_id lookup in that case.
  const insecure = protocol === 'https' ? '-k ' : ''
  return `curl -s ${insecure}-X POST '${protocol}://${host}:${port}${SESSION_WATCHER_PATH}?event=${event}' ` +
    `-H 'Content-Type: application/json' ` +
    `-H "X-Tmux-Pane: \${TMUX_PANE:-}" ` +
    `--data-binary @-`
}

/**
 * Install (or reinstall) the session-watcher hooks for a project.
 * Idempotent: existing session-watcher entries are removed first (matched by
 * the unique URL path) and then re-added. Agent hooks (different URL) are
 * left untouched. Errors are logged but never thrown — a hook install
 * failure should never block project init.
 */
export async function installSessionWatcherHooks(
  projectPath: string,
  orkaPort: number,
  protocol: 'http' | 'https' = 'http',
  host: string = 'localhost'
): Promise<void> {
  try {
    const settings = await readSettings(projectPath)
    if (!settings.hooks) settings.hooks = {}

    for (const event of WATCHED_EVENTS) {
      const existing = settings.hooks[event] ?? []
      // Drop any prior session-watcher entries (matched by URL path).
      const filtered = existing.filter(
        (group) => !group.hooks.some((h) => h.command.includes(SESSION_WATCHER_PATH))
      )
      filtered.push({
        hooks: [{ type: 'command', command: buildCommand(host, orkaPort, event, protocol) }],
      })
      settings.hooks[event] = filtered
    }

    await writeSettings(projectPath, settings)
    logger.debug(`session-watcher: installed hooks for ${projectPath} → ${protocol}://${host}:${orkaPort}`)
  } catch (err: any) {
    logger.warn(`session-watcher: failed to install hooks for ${projectPath}: ${err?.message || err}`)
  }
}

/** Remove all session-watcher hooks for a project. Currently unused but
 *  kept symmetric with `installSessionWatcherHooks` for future cleanup. */
export async function uninstallSessionWatcherHooks(projectPath: string): Promise<void> {
  try {
    const settings = await readSettings(projectPath)
    if (!settings.hooks) return

    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = settings.hooks[event].filter(
        (group) => !group.hooks.some((h) => h.command.includes(SESSION_WATCHER_PATH))
      )
      if (settings.hooks[event].length === 0) delete settings.hooks[event]
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks

    await writeSettings(projectPath, settings)
  } catch (err: any) {
    logger.warn(`session-watcher: failed to uninstall hooks for ${projectPath}: ${err?.message || err}`)
  }
}
