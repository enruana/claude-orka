import { Router } from 'express'
import { getGlobalStateManager } from '../../core/GlobalStateManager'
import { StateManager } from '../../core/StateManager'
import { TerminalReader } from '../../agent/TerminalReader'
import execa from 'execa'
import { logger } from '../../utils/logger'

/**
 * The live terminals the voice agent can be pointed at.
 *
 * "Which terminals exist" is spread across per-project state files, so
 * this walks the registered projects and flattens every Claude session
 * pane — the session's main branch plus each of its forks — into one
 * list the picker can render.
 *
 * Each entry carries a parsed verdict of what the pane is doing, which
 * is the part that makes "how is this one going" answerable at all.
 * That parsing already existed for the autonomous agent daemon
 * (TerminalReader); nothing here reimplements it.
 */

export interface ActiveTerminal {
  /** Stable id for the picker and for selection: the tmux pane. */
  paneId: string
  projectPath: string
  projectName: string
  sessionId: string
  sessionName: string
  /** 'main' or the fork id — which branch of the session this pane is. */
  branch: string
  branchLabel: string
  /** The session's ttyd port, when one is running — this is what lets
   *  the viewer show the terminal LIVE instead of a text capture. Forks
   *  share it, since they are panes of the same tmux session. */
  ttydPort?: number
  lastActivity: string
  state: {
    label: 'waiting' | 'processing' | 'permission' | 'context-limit' | 'error' | 'unknown'
    detail: string
  }
}

/** Collapse TerminalReader's flags into one word the UI can colour and
 *  the model can say out loud. Order matters: a pane that is both
 *  processing and out of context needs the blocking condition first. */
function summarizeState(content: string): ActiveTerminal['state'] {
  const s = TerminalReader.parseState(content)
  const detail = (s.lastMessage || '').trim().slice(-240)
  if (s.hasContextLimit) return { label: 'context-limit', detail }
  if (s.error) return { label: 'error', detail: s.error.slice(0, 240) }
  if (s.hasPermissionPrompt) return { label: 'permission', detail }
  if (s.isProcessing) return { label: 'processing', detail }
  if (s.isWaitingForInput) return { label: 'waiting', detail }
  return { label: 'unknown', detail }
}

/** Capture a pane and describe it, tolerating a pane that just died. */
export async function describeTerminal(paneId: string, lines = 120): Promise<{
  content: string
  state: ActiveTerminal['state']
} | null> {
  try {
    // `capture` wants a session name for logging only; the pane id is
    // what actually addresses the terminal.
    const captured = await TerminalReader.capture(paneId, 'voice', lines)
    const content = captured.content || ''
    return { content, state: summarizeState(content) }
  } catch {
    return null
  }
}

export async function listActiveTerminals(): Promise<ActiveTerminal[]> {
  const globalState = await getGlobalStateManager()
  const projects = globalState.getProjects()
  const out: ActiveTerminal[] = []

  // Projects are independent; walking them in parallel keeps the picker
  // responsive when several are registered.
  await Promise.all(projects.map(async (project) => {
    let sessions
    try {
      const state = new StateManager(project.path)
      sessions = await state.listSessions()
    } catch {
      return // Project directory gone or unreadable — skip it.
    }

    const projectName = project.path.split('/').filter(Boolean).pop() || project.path

    for (const session of sessions) {
      if (session.status !== 'active') continue

      const panes: { paneId?: string; branch: string; branchLabel: string }[] = [
        { paneId: session.main?.tmuxPaneId, branch: 'main', branchLabel: session.main?.label || 'main' },
        ...(session.forks || [])
          .filter((f: any) => f.status === 'active')
          .map((f: any) => ({ paneId: f.tmuxPaneId, branch: f.id, branchLabel: f.name || f.id })),
      ]

      for (const p of panes) {
        if (!p.paneId) continue
        const described = await describeTerminal(p.paneId, 60)
        // A stored pane id whose tmux is gone is not an active terminal.
        if (!described) continue
        out.push({
          paneId: p.paneId,
          projectPath: project.path,
          projectName,
          sessionId: session.id,
          sessionName: session.name,
          branch: p.branch,
          branchLabel: p.branchLabel,
          ttydPort: session.ttydPort,
          lastActivity: session.lastActivity,
          state: described.state,
        })
      }
    }
  }))

  return out.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''))
}

/**
 * Resolve a tmux SESSION name to the pane the voice agent should read.
 *
 * Not every terminal in the product knows its pane id: the editor
 * terminals, the system terminal and the board master drawer are
 * addressed by tmux session name, and only the per-session views carry
 * a pane. Resolving here means the caller can hand over whichever
 * identifier it happens to have, instead of every call site growing
 * bookkeeping it has no other use for.
 *
 * The ACTIVE pane is the right answer: in a split session that is the
 * one the user is looking at.
 */
export async function resolvePaneForSession(tmuxSession: string): Promise<string | null> {
  try {
    const { stdout } = await execa('tmux', [
      'list-panes', '-t', tmuxSession, '-F', '#{pane_active} #{pane_id}',
    ])
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
    const active = lines.find(l => l.startsWith('1 '))
    const chosen = active || lines[0]
    return chosen ? chosen.split(' ')[1] : null
  } catch {
    return null
  }
}

export const voiceTerminalsRouter = Router()

/** GET /api/voice/terminals — everything the picker needs. */
voiceTerminalsRouter.get('/', async (_req, res) => {
  try {
    res.json({ terminals: await listActiveTerminals() })
  } catch (error: any) {
    logger.error('Failed to list active terminals:', error)
    res.status(500).json({ error: error.message })
  }
})
