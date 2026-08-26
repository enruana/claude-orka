import { Router } from 'express'
import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import { logger } from '../../utils/logger'

/**
 * Persistence for voice-agent conversations.
 *
 * WHERE: `~/.claude-orka/voice-conversations/<id>.json`, one file per
 * conversation — alongside `agents.json`, the other user-level Orka
 * state. The obvious alternative was the per-PROJECT
 * `.claude-orka/state.json`, and it's the wrong home for this: the
 * standalone voice agent runs against a virtual project (`/`) that has
 * no project directory at all, so half the conversations would have
 * nowhere to live. A user-level store keyed BY project sidesteps that
 * entirely and still lets the UI filter per project. One file per
 * conversation (rather than one big index) keeps saves cheap and means
 * a corrupted record can never take the whole list down with it.
 *
 * WHAT: enough to resume the conversation exactly where it stopped —
 * the model-facing history, a clean display transcript for the UI, and
 * the attachments.
 *
 * Attachment text is stored INLINE rather than as a pointer to re-fetch.
 * A URL that resolved when you saved may 404, move behind a login, or
 * silently change content a month later; an uploaded PDF is gone the
 * moment the browser tab closes. Re-reading the source would make
 * "resume from the same point" a lie. The origin (url / project path)
 * is kept alongside so the viewer can still link out, and the total is
 * already bounded by the session's attachment budget.
 */

const CONVERSATIONS_DIR = path.join(os.homedir(), '.claude-orka', 'voice-conversations')

export interface StoredAttachment {
  source: 'project-file' | 'upload' | 'url' | 'text'
  label: string
  text: string
  chars: number
  /** Original URL or project-relative path, when the source had one. */
  origin?: string
}

export interface StoredTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface Conversation {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  project: string
  language: string
  voice: string
  /** Model-facing history — may contain injected attachment blobs. */
  history: { role: 'user' | 'assistant'; content: string }[]
  /** Clean turns for rendering the transcript on resume. */
  transcript: StoredTurn[]
  attachments: StoredAttachment[]
}

/** Listing shape — everything the picker needs, none of the payload. */
export interface ConversationSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  project: string
  language: string
  turnCount: number
  attachmentCount: number
  preview: string
}

let idCounter = 0
export function makeConversationId(): string {
  return `conv-${Date.now().toString(36)}-${(++idCounter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Reject anything that could climb out of the conversations dir. */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

function fileFor(id: string): string {
  return path.join(CONVERSATIONS_DIR, `${id}.json`)
}

function summarize(c: Conversation): ConversationSummary {
  const firstUser = c.transcript.find((t) => t.role === 'user')?.text || ''
  return {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    project: c.project,
    language: c.language,
    turnCount: c.transcript.length,
    attachmentCount: c.attachments.length,
    preview: firstUser.length > 120 ? firstUser.slice(0, 119) + '…' : firstUser,
  }
}

export async function listConversations(project?: string): Promise<ConversationSummary[]> {
  await fs.ensureDir(CONVERSATIONS_DIR)
  const files = (await fs.readdir(CONVERSATIONS_DIR)).filter((f) => f.endsWith('.json'))
  const out: ConversationSummary[] = []
  for (const f of files) {
    try {
      const c = (await fs.readJson(path.join(CONVERSATIONS_DIR, f))) as Conversation
      if (!c?.id) continue
      if (project && c.project !== project) continue
      out.push(summarize(c))
    } catch (err: any) {
      // One unreadable file must not blank the whole list.
      logger.warn(`[voice-conversations] skipping unreadable ${f}: ${err.message}`)
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getConversation(id: string): Promise<Conversation | null> {
  if (!isSafeId(id)) return null
  const p = fileFor(id)
  if (!(await fs.pathExists(p))) return null
  try {
    return (await fs.readJson(p)) as Conversation
  } catch {
    return null
  }
}

export async function saveConversation(c: Conversation): Promise<Conversation> {
  if (!isSafeId(c.id)) throw new Error(`invalid conversation id: ${c.id}`)
  await fs.ensureDir(CONVERSATIONS_DIR)
  // Write-then-rename so a crash mid-write can't leave a half-file
  // where a working conversation used to be.
  const finalPath = fileFor(c.id)
  const tmpPath = `${finalPath}.tmp`
  await fs.writeJson(tmpPath, c, { spaces: 2 })
  await fs.move(tmpPath, finalPath, { overwrite: true })
  logger.info(
    `[voice-conversations] saved "${c.name}" (${c.id}) · ${c.transcript.length} turns · ` +
    `${c.attachments.length} attachments`
  )
  return c
}

export async function deleteConversation(id: string): Promise<boolean> {
  if (!isSafeId(id)) return false
  const p = fileFor(id)
  if (!(await fs.pathExists(p))) return false
  await fs.remove(p)
  logger.info(`[voice-conversations] deleted ${id}`)
  return true
}

// ============================================================
// REST surface — listing and deleting are stateless, so they don't
// need the WebSocket. Saving does (it reads live session state), and
// lives in voice-live.ts as a control message.
// ============================================================

export const voiceConversationsRouter = Router()

voiceConversationsRouter.get('/', async (req, res) => {
  try {
    const project = typeof req.query.project === 'string' ? req.query.project : undefined
    res.json({ conversations: await listConversations(project) })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

voiceConversationsRouter.get('/:id', async (req, res) => {
  try {
    const c = await getConversation(req.params.id)
    if (!c) { res.status(404).json({ error: 'conversation not found' }); return }
    res.json(c)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

voiceConversationsRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteConversation(req.params.id)
    if (!ok) { res.status(404).json({ error: 'conversation not found' }); return }
    res.json({ ok: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/** Rename without touching the payload. */
voiceConversationsRouter.patch('/:id', async (req, res) => {
  try {
    const c = await getConversation(req.params.id)
    if (!c) { res.status(404).json({ error: 'conversation not found' }); return }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!name) { res.status(400).json({ error: 'name required' }); return }
    c.name = name.slice(0, 120)
    c.updatedAt = Date.now()
    await saveConversation(c)
    res.json({ ok: true, conversation: summarize(c) })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})
