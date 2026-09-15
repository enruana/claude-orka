import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TerminalReader } from '../../agent/TerminalReader'
import { describeTerminal } from './voice-terminals'
import { logger } from '../../utils/logger'

/**
 * The tools the voice agent may use, scoped to ONE selected terminal.
 *
 * The defining decision here: no tool takes a target. The pane is bound
 * when the user picks a terminal in the UI, and the server closes over
 * it. Speech recognition is lossy — in this project's own tests Whisper
 * turned "Hola" into "o la" — so a model choosing which terminal to act
 * on from a transcript is a mis-hearing away from acting on the wrong
 * one. Binding it server-side makes that impossible: the worst a bad
 * transcript can do is send the wrong text to the right terminal, which
 * is recoverable and, for writes, confirmed out loud first.
 */

export const VOICE_MCP_SERVER_NAME = 'orka'

export interface SelectedTerminal {
  paneId: string
  label: string
  projectPath: string
  sessionId: string
}

/**
 * A write that has been composed but not performed.
 *
 * The model cannot type into a terminal in one step. `send_to_terminal`
 * only stages the text and hands back a token; `confirm_send` performs
 * it. That forces the exact characters through the user's ears before
 * anything runs, which is the whole safety story here: speech
 * recognition is lossy, and a mis-heard sentence is recoverable in a
 * way a mis-heard command is not.
 *
 * Instructing the model to "ask first" was not enough — that is a
 * suggestion it can talk itself out of. This is a lock: without the
 * token there is no code path that reaches the terminal.
 */
export interface PendingSend {
  token: string
  text: string
  paneId: string
  expiresAt: number
}

/** Short enough that a stale confirmation can't fire much later, long
 *  enough for a real spoken exchange. */
const PENDING_SEND_TTL_MS = 120_000

/**
 * Where the staged write lives.
 *
 * Deliberately NOT a variable inside the server closure: the driver can
 * exit between turns and be respawned, rebuilding the server and
 * throwing away anything it held. Staging and confirming are two
 * different turns by design, so this has to outlive both.
 */
export type PendingSendStore = { current: PendingSend | null }

/**
 * The SDK's built-in tools, explicitly denied.
 *
 * `allowedTools` is NOT enough here and it is worth being precise about
 * why: it is a permission allowlist, and `permissionMode:
 * 'bypassPermissions'` skips permission checks altogether, so the
 * allowlist never runs. Measured, not assumed — with only `allowedTools`
 * set, asking the voice agent to run `echo orka-probe-42` still had it
 * invoke Bash and return the output. `disallowedTools` removes the
 * tools instead of governing them, and does hold.
 */
export const VOICE_DISALLOWED_TOOLS = [
  'Bash', 'BashOutput', 'KillShell',
  'Read', 'Write', 'Edit', 'NotebookEdit',
  'Glob', 'Grep',
  'WebFetch', 'WebSearch',
  'Task', 'TodoWrite',
]

/** What the model may call — our terminal tools and nothing else. Kept
 *  alongside the denylist: the denylist is what enforces, this is what
 *  documents intent and covers non-bypass permission modes. */
export function voiceAllowedTools(canWrite: boolean): string[] {
  const names = ['read_terminal', 'terminal_state']
  if (canWrite) names.push('send_to_terminal', 'confirm_send')
  return names.map(n => `mcp__${VOICE_MCP_SERVER_NAME}__${n}`)
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/**
 * Build the per-session MCP server.
 *
 * `getSelected` is read at call time, not captured, so switching
 * terminals mid-conversation redirects the tools without rebuilding the
 * query.
 */
export function createVoiceMcpServer(opts: {
  getSelected: () => SelectedTerminal | null
  /** Gate for the write tool — phase 2, off unless explicitly enabled. */
  allowWrite?: boolean
  /** Called before any write actually lands, for logging/audit. */
  onSend?: (text: string) => void
  /** Session-owned storage for the staged write. */
  pendingStore?: PendingSendStore
}) {
  const { getSelected, allowWrite = false, onSend } = opts
  // Falls back to a local box so the server still works standalone
  // (tests, one-off use) without a session behind it.
  const store: PendingSendStore = opts.pendingStore ?? { current: null }

  const noTerminal = () => textResult(
    'No terminal is selected. Ask the user to pick one from the terminal button in the voice agent.'
  )

  // Each tool has its own schema type, so the array needs the widened
  // element type the SDK accepts rather than the one inferred from the
  // first entry.
  const tools: Parameters<typeof createSdkMcpServer>[0]['tools'] = [
    tool(
      'read_terminal',
      'Read the recent output of the terminal the user selected. Use this to answer questions about what is happening in it.',
      { lines: z.number().int().min(10).max(400).optional().describe('How many lines of scrollback to read (default 120)') },
      async (args) => {
        const sel = getSelected()
        if (!sel) return noTerminal()
        const described = await describeTerminal(sel.paneId, args.lines ?? 120)
        if (!described) return textResult(`The terminal "${sel.label}" is no longer running.`)
        return textResult(`Terminal: ${sel.label}\nState: ${described.state.label}\n\n${described.content}`)
      }
    ),

    tool(
      'terminal_state',
      'Get a short structured verdict of what the selected terminal is doing right now — whether it is waiting for input, working, blocked on a permission prompt, or out of context.',
      {},
      async () => {
        const sel = getSelected()
        if (!sel) return noTerminal()
        const described = await describeTerminal(sel.paneId, 60)
        if (!described) return textResult(`The terminal "${sel.label}" is no longer running.`)
        return textResult(
          `Terminal: ${sel.label}\nState: ${described.state.label}\nLast output: ${described.state.detail || '(nothing recent)'}`
        )
      }
    ),
  ]

  if (allowWrite) {
    tools.push(
      tool(
        'send_to_terminal',
        'Stage text to type into the selected terminal. This does NOT send it. '
        + 'You must then read the exact text back to the user out loud, ask them to confirm, '
        + 'and only call confirm_send once they clearly agree.',
        { text: z.string().min(1).describe('The exact text to type') },
        async (args) => {
          const sel = getSelected()
          if (!sel) return noTerminal()
          store.current = {
            token: `snd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
            text: args.text,
            paneId: sel.paneId,
            expiresAt: Date.now() + PENDING_SEND_TTL_MS,
          }
          logger.info(`[voice-tools] staged for ${sel.label}: ${args.text.slice(0, 120)}`)
          return textResult(
            `STAGED — nothing has been sent yet.\n`
            + `Terminal: ${sel.label}\n`
            + `Text: ${args.text}\n\n`
            + `Read that text back to the user word for word and ask them to confirm. `
            + `If they agree, call confirm_send with token "${store.current!.token}". `
            + `If they change it, call send_to_terminal again with the new text.`
          )
        }
      ),

      tool(
        'confirm_send',
        'Actually type the staged text into the selected terminal. Only call this after the user has confirmed the exact text out loud.',
        { token: z.string().describe('The token returned by send_to_terminal') },
        async (args) => {
          const sel = getSelected()
          if (!sel) return noTerminal()
          const pending = store.current
          if (!pending) return textResult('Nothing is staged. Call send_to_terminal first.')
          if (args.token !== pending.token) {
            return textResult('That token does not match what is staged. Call send_to_terminal again.')
          }
          if (Date.now() > pending.expiresAt) {
            store.current = null
            return textResult('That confirmation expired. Stage the text again.')
          }
          // The user may have switched terminals between staging and
          // confirming; the text was approved for the old one.
          if (pending.paneId !== sel.paneId) {
            store.current = null
            return textResult('The selected terminal changed since you staged that. Stage it again.')
          }

          const { text, paneId } = pending
          store.current = null
          onSend?.(text)
          logger.info(`[voice-tools] CONFIRMED send to ${sel.label} (${paneId}): ${text.slice(0, 120)}`)
          try {
            await TerminalReader.sendTextWithEnter(paneId, text)
          } catch (err: any) {
            return textResult(`Could not send it: ${err?.message || err}`)
          }
          // Give the terminal a moment, then report what came back so the
          // user hears the outcome instead of just "sent".
          await new Promise(r => setTimeout(r, 1200))
          const after = await describeTerminal(paneId, 40)
          return textResult(
            `Sent to ${sel.label}.\nState now: ${after?.state.label ?? 'unknown'}\n\n${after?.content.slice(-1200) ?? ''}`
          )
        }
      )
    )
  }

  return createSdkMcpServer({ name: VOICE_MCP_SERVER_NAME, version: '1.0.0', tools })
}
