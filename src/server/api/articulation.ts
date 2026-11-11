import { Router, Request, Response } from 'express'
import execa from 'execa'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { logger } from '../../utils'
import { getWhisperServer } from '../../utils/whisper'

export const articulationRouter = Router()

/**
 * Articulation drills — bite-sized exercises that target one dimension
 * of spoken English at a time, independent of the user's own clip
 * library. The first drill shipped here is PACE: a short passage with a
 * target WPM; the user reads it out loud and we grade how close their
 * delivered pace came. Tongue-twisters and pause-before-reply drills
 * will plug into the same router later.
 */

interface PacePassage {
  id: string
  title: string
  category: 'standup' | 'email' | 'presentation' | 'casual' | 'technical' | 'leadership'
  text: string
  wordCount: number
}

const RAW_PASSAGES: Omit<PacePassage, 'wordCount'>[] = [
  {
    id: 'standup-release',
    title: 'Standup — release week',
    category: 'standup',
    text:
      "Yesterday I finished the authentication refactor and opened a pull request. " +
      "Today I'll pair with Sam on the payment flow bug, and I should be done by end of day. " +
      "No blockers right now, but I'd like a review before the release cutoff.",
  },
  {
    id: 'standup-blocker',
    title: 'Standup — raising a blocker',
    category: 'standup',
    text:
      "Quick update: I'm blocked on the migration rollout — the staging database " +
      "is out of sync with prod and I can't verify the schema change. " +
      "I pinged the data team yesterday. If I don't hear back by noon, I'll switch " +
      "to the smaller tickets in the backlog.",
  },
  {
    id: 'email-intro',
    title: 'Short email intro',
    category: 'email',
    text:
      "Hi team, following up on our conversation from last week. " +
      "I've put together a short proposal and I'd love to get your feedback before " +
      "we take this to the leadership review on Friday. Let me know what time works.",
  },
  {
    id: 'presentation-opener',
    title: 'Presentation opener',
    category: 'presentation',
    text:
      "Good morning everyone. Thanks for making time for this. " +
      "In the next ten minutes I'll walk you through three things: what we shipped last quarter, " +
      "what we learned from the data, and where I think we should place our next bet.",
  },
  {
    id: 'technical-bug',
    title: 'Explaining a bug',
    category: 'technical',
    text:
      "So the issue is this: when the user clicks submit twice in quick succession, " +
      "we fire two parallel requests, and because the backend uses an optimistic lock, " +
      "the second one fails silently. The fix is to disable the button on the first click " +
      "and re-enable it when the response comes back.",
  },
  {
    id: 'casual-weekend',
    title: 'Casual catch-up',
    category: 'casual',
    text:
      "How was your weekend? Mine was surprisingly busy — I ended up helping a friend move, " +
      "which took most of Saturday. On Sunday I just chilled, caught up on a couple of episodes, " +
      "and went for a long walk. What about you? Did you do anything fun?",
  },
  {
    id: 'leadership-feedback',
    title: 'Giving feedback',
    category: 'leadership',
    text:
      "I want to flag something I've been noticing. In the last few reviews, the pattern has been " +
      "that feedback comes in late and feels rushed, which puts the author in a tough spot. " +
      "I think if we commit to a 48-hour turnaround we'd avoid a lot of that friction.",
  },
  {
    id: 'technical-tradeoff',
    title: 'Explaining a tradeoff',
    category: 'technical',
    text:
      "There are two reasonable ways to do this. Option A is faster to ship but couples us " +
      "to the legacy service. Option B takes an extra sprint but gives us a clean seam we can " +
      "swap later. My recommendation is B, because the timeline is flexible and the coupling cost compounds.",
  },
]

const PACE_PASSAGES: PacePassage[] = RAW_PASSAGES.map((p) => ({
  ...p,
  wordCount: p.text.trim().split(/\s+/).filter(Boolean).length,
}))

function findPassage(id: string): PacePassage | null {
  return PACE_PASSAGES.find((p) => p.id === id) || null
}

// GET /api/articulation/passages
articulationRouter.get('/passages', (_req, res) => {
  res.json({ passages: PACE_PASSAGES })
})

// POST /api/articulation/pace-drill?passageId=X&target=140
articulationRouter.post('/pace-drill', async (req: Request, res: Response) => {
  try {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'upload must be raw audio bytes' })
      return
    }
    const passageId = String(req.query.passageId || '').trim()
    const targetWpm = Math.max(60, Math.min(220, parseInt(String(req.query.target || '140'), 10) || 140))
    const passage = findPassage(passageId)
    if (!passage) { res.status(404).json({ error: 'passage not found' }); return }

    const tmpDir = path.join(os.tmpdir(), 'orka-articulation')
    await fs.ensureDir(tmpDir)
    const id = randomUUID()
    const rawPath = path.join(tmpDir, `${id}.raw`)
    const wavPath = path.join(tmpDir, `${id}.wav`)

    try {
      await fs.writeFile(rawPath, req.body)
      await execa('ffmpeg', [
        '-i', rawPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wavPath,
      ])
      const wav = await fs.readFile(wavPath)
      const whisper = await getWhisperServer()
      const userText = (await whisper.transcribe(wav, { language: 'en', prompt: passage.text })).trim()

      const { stdout } = await execa('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', wavPath,
      ])
      const durationSec = parseFloat(stdout.trim()) || 1
      // User's own word count drives WPM — if they said half the passage, their WPM should reflect that.
      const userWordCount = userText.split(/\s+/).filter(Boolean).length
      const userWpm = durationSec > 0 ? Math.round((userWordCount / durationSec) * 60) : 0
      const delta = userWpm - targetWpm

      // Rough coverage: how much of the passage did they actually deliver?
      const coverage = passage.wordCount > 0
        ? Math.min(1, userWordCount / passage.wordCount)
        : 0

      // Heuristic note — WPM-only signal is deterministic and good enough.
      // An LLM pass can layer qualitative notes later.
      let note: string
      let band: 'too-slow' | 'slightly-slow' | 'on-target' | 'slightly-fast' | 'too-fast'
      const absDelta = Math.abs(delta)
      if (absDelta <= 10) {
        band = 'on-target'
        note = 'Great pace — right inside the target band.'
      } else if (delta > 10 && delta <= 25) {
        band = 'slightly-fast'
        note = 'A touch fast. Try adding small pauses after key phrases to let them land.'
      } else if (delta > 25) {
        band = 'too-fast'
        note = 'Too fast — slow down and trust the key words. Breathe between sentences.'
      } else if (delta < -10 && delta >= -25) {
        band = 'slightly-slow'
        note = "A little slow. Push the energy up — you can trust yourself to speak faster without losing clarity."
      } else {
        band = 'too-slow'
        note = 'Quite slow — try reading it like you mean it, keeping sentences continuous.'
      }
      if (coverage < 0.7) {
        note = `You delivered about ${Math.round(coverage * 100)}% of the passage — read the whole thing to get a real pace measurement. ${note}`
      }

      res.json({
        passageId,
        passageTitle: passage.title,
        passageWordCount: passage.wordCount,
        targetWpm,
        userWpm,
        delta,
        band,
        coverage: Math.round(coverage * 100),
        durationSec: Math.round(durationSec * 10) / 10,
        userTranscript: userText,
        note,
      })
    } finally {
      try { await fs.remove(rawPath) } catch { /* drop */ }
      try { await fs.remove(wavPath) } catch { /* drop */ }
    }
  } catch (err: any) {
    logger.error('[articulation] pace-drill failed:', err)
    res.status(500).json({ error: err.message || 'pace drill failed' })
  }
})
