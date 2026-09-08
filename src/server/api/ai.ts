import { Router } from 'express'
import execa from 'execa'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { TmuxCommands } from '../../utils/tmux'
import { KnowledgeBaseManager } from '../../core/KnowledgeBaseManager'

export const aiRouter = Router()

interface AIQueryBody {
  question: string
  context?: {
    type: 'terminal' | 'code' | 'none'
    projectPath?: string
    terminalPaneId?: string
    fileContent?: string
    filePath?: string
    selection?: string
  }
}

/**
 * POST /api/ai/query
 * Ask AI a question with optional context from terminal or code editor
 */
aiRouter.post('/query', async (req, res) => {
  try {
    const { question, context } = req.body as AIQueryBody

    if (!question?.trim()) {
      res.status(400).json({ error: 'question is required' })
      return
    }

    // Build context string
    let contextString = ''

    if (context?.type === 'terminal' && context.terminalPaneId) {
      try {
        const terminalText = await TmuxCommands.capturePane(context.terminalPaneId, -200)
        contextString = terminalText.trim()
      } catch {
        // Terminal capture failed, proceed without context
      }
    } else if (context?.type === 'code') {
      if (context.selection) {
        contextString = `File: ${context.filePath || 'unknown'}\n\nSelected code:\n${context.selection.slice(0, 4000)}`
      } else if (context.fileContent) {
        contextString = `File: ${context.filePath || 'unknown'}\n\n${context.fileContent.slice(0, 4000)}`
      }
    }

    // Build prompt
    let prompt: string
    if (contextString) {
      prompt = `Answer this question concisely. Context is provided via stdin.\n\nQuestion: ${question}`
    } else {
      prompt = `Answer this question concisely: ${question}`
    }

    const args = ['-p', prompt, '--model', 'haiku', '--no-session-persistence']

    const execaOptions: any = {
      timeout: 60000,
      // Unset CLAUDECODE to avoid "nested session" error when server runs inside a Claude session
      // execa v5 merges env with process.env by default, so we must use extendEnv: false
      env: { ...process.env, CLAUDECODE: '' },
      extendEnv: false,
    }
    if (contextString) {
      execaOptions.input = contextString
    }
    if (context?.projectPath) {
      execaOptions.cwd = context.projectPath
    }

    const { stdout } = await execa('claude', args, execaOptions)

    res.json({ answer: stdout.trim() })
  } catch (error: any) {
    console.error('Error in AI query:', error)

    if (error.code === 'ENOENT') {
      res.status(500).json({ error: 'Claude CLI not found. Make sure claude is installed and in PATH.' })
      return
    }
    if (error.timedOut) {
      res.status(500).json({ error: 'Request timed out. Try a simpler question.' })
      return
    }

    res.status(500).json({ error: error.message || 'Failed to process AI query' })
  }
})

interface TranslateBody {
  text: string
  sourceLang: 'en' | 'es'
  tone?: 'professional' | 'casual' | 'formal' | 'friendly'
}

/**
 * POST /api/ai/translate
 * Translate, improve, grammar-fix, and summarize text
 */
aiRouter.post('/translate', async (req, res) => {
  try {
    const { text, sourceLang, tone = 'professional' } = req.body as TranslateBody

    if (!text?.trim()) {
      res.status(400).json({ error: 'text is required' })
      return
    }
    if (sourceLang !== 'en' && sourceLang !== 'es') {
      res.status(400).json({ error: 'sourceLang must be "en" or "es"' })
      return
    }

    const targetLang = sourceLang === 'en' ? 'Spanish' : 'English'
    const srcLangName = sourceLang === 'en' ? 'English' : 'Spanish'

    const prompt = `You are a writing assistant. The user's text is in ${srcLangName}. Tone: ${tone}.

Produce a JSON object with exactly these four keys (no markdown, no code fences, just raw JSON):
- "translation": translate the text to ${targetLang}, matching the requested tone
- "improved": rewrite the original ${srcLangName} text to be clearer and more polished in ${srcLangName}, matching the requested tone
- "grammarFix": fix only grammar/spelling errors in the original ${srcLangName} text, keeping meaning identical. If there are no errors, return the original text unchanged
- "summary": a one-sentence ${srcLangName} summary of the text

Text: ${text}`

    const args = ['-p', prompt, '--model', 'sonnet', '--no-session-persistence']

    const { stdout } = await execa('claude', args, {
      timeout: 60000,
      env: { ...process.env, CLAUDECODE: '' },
      extendEnv: false,
    })

    // Parse the JSON from Claude's response
    const cleaned = stdout.trim()
    // Extract JSON from response - handle possible markdown fences
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      res.status(500).json({ error: 'Failed to parse AI response' })
      return
    }

    const result = JSON.parse(jsonMatch[0])
    res.json({
      translation: result.translation || '',
      improved: result.improved || '',
      grammarFix: result.grammarFix || '',
      summary: result.summary || '',
    })
  } catch (error: any) {
    console.error('Error in AI translate:', error)

    if (error.code === 'ENOENT') {
      res.status(500).json({ error: 'Claude CLI not found.' })
      return
    }
    if (error.timedOut) {
      res.status(500).json({ error: 'Request timed out.' })
      return
    }

    res.status(500).json({ error: error.message || 'Failed to process translation' })
  }
})

/**
 * POST /api/ai/markdown-format
 * Convert plain text into a well-structured Markdown document.
 */
aiRouter.post('/markdown-format', async (req, res) => {
  try {
    const { text } = req.body as { text: string }

    if (!text?.trim()) {
      res.status(400).json({ error: 'text is required' })
      return
    }

    const prompt = `You are a Markdown formatter. Convert the user's plain text (provided via stdin) into a well-structured Markdown document.

Rules:
- Identify natural headings and use ## / ### appropriately
- Detect bullet/numbered lists and format them with - or 1.
- Wrap code/commands/file paths in backticks. Multi-line code in \`\`\` fences with appropriate language hint when obvious
- Format URLs as [text](url) links when the surrounding text describes them, otherwise keep as raw URLs
- Use **bold** for emphasis and *italics* sparingly
- Use > for quotes
- Use tables when the text describes tabular data
- Preserve the original language of the text
- Preserve ALL the original information — do not summarize, omit, or paraphrase
- Output ONLY the Markdown content, no preamble, no explanation, no code fence around the whole thing`

    const args = ['-p', prompt, '--model', 'sonnet', '--no-session-persistence']

    const { stdout } = await execa('claude', args, {
      timeout: 120000,
      env: { ...process.env, CLAUDECODE: '' },
      extendEnv: false,
      input: text,
    })

    let markdown = stdout.trim()
    // If Claude wrapped the entire output in a markdown fence, strip it
    if (markdown.startsWith('```markdown\n') || markdown.startsWith('```md\n')) {
      markdown = markdown.replace(/^```(?:markdown|md)\n/, '').replace(/\n```\s*$/, '')
    } else if (markdown.startsWith('```\n') && markdown.endsWith('```')) {
      markdown = markdown.slice(4, -3).trim()
    }

    res.json({ markdown })
  } catch (error: any) {
    console.error('Error in AI markdown-format:', error)
    if (error.code === 'ENOENT') {
      res.status(500).json({ error: 'Claude CLI not found.' })
      return
    }
    if (error.timedOut) {
      res.status(500).json({ error: 'Request timed out.' })
      return
    }
    res.status(500).json({ error: error.message || 'Failed to format markdown' })
  }
})

/**
 * POST /api/ai/name
 * Generate a short descriptive title from a transcript or report
 */
aiRouter.post('/name', async (req, res) => {
  try {
    const { text } = req.body as { text: string }

    if (!text?.trim()) {
      res.status(400).json({ error: 'text is required' })
      return
    }

    const prompt = `Given the following text (a transcript or report), generate a short descriptive title (3-6 words max) that captures the main topic. Output ONLY the title in snake_case, lowercase, no quotes, no explanation. Examples: weekly_standup_backend_bugs, product_launch_planning, client_feedback_review, onboarding_process_discussion`

    const args = ['-p', prompt, '--model', 'haiku', '--no-session-persistence']

    const { stdout } = await execa('claude', args, {
      timeout: 30000,
      env: { ...process.env, CLAUDECODE: '' },
      extendEnv: false,
      input: text.slice(0, 3000),
    })

    // Clean: remove quotes, trim, enforce snake_case
    const raw = stdout.trim().replace(/['"]/g, '').replace(/\s+/g, '_').replace(/[^a-z0-9_]/gi, '').toLowerCase()
    const title = raw || 'untitled_recording'

    res.json({ title })
  } catch (error: any) {
    console.error('Error in AI name:', error)
    res.status(500).json({ error: error.message || 'Failed to generate name' })
  }
})

/**
 * POST /api/ai/report
 * Generate a structured markdown report from a transcript
 */
aiRouter.post('/report', async (req, res) => {
  try {
    const { transcript } = req.body as { transcript: string }

    if (!transcript?.trim()) {
      res.status(400).json({ error: 'transcript is required' })
      return
    }

    const prompt = `You are an expert note-taker producing a comprehensive report from a transcript provided via stdin.

Your goal is COMPLETENESS — the reader should never need to go back to the original transcript. DO NOT omit or summarize away any substantive information. Be thorough and detailed, not wordy.

Produce a markdown report with ALL of the following sections. If a section has no content, write "N/A" — do not skip it.

## Summary
2-3 sentence overview of what the transcript covers: who, what, why, outcome.

## Participants
List every person identified or implied, with their role/affiliation if discernible. If participants cannot be identified, write "Not identifiable from transcript."

## Key Points
Bullet list of the most important takeaways. Each bullet should be a complete, self-contained statement.

## Detailed Discussion
This is the core of the report. Reconstruct the full discussion organized by topic.
- Use ### subheadings for each major topic or theme
- Under each topic, include ALL points made, arguments presented, examples given, and context provided
- Preserve the logical flow and reasoning, not just conclusions
- Include specific details: numbers, names, dates, technical terms, examples mentioned
- If there was disagreement or debate, capture all sides

## Decisions Made
Each decision as a bullet with the reasoning/context behind it. If no decisions were made, write "N/A".

## Action Items
Format: **[Owner]** — Task description (deadline if mentioned). If no action items, write "N/A".

## Data & References
Capture ALL specific data points mentioned in the transcript:
- Numbers, statistics, percentages, amounts
- Dates, deadlines, timeframes
- Names of people, companies, products, tools, technologies
- URLs, documents, resources referenced
- Technical specifications or configurations

## Questions & Open Issues
Unresolved questions, concerns raised without resolution, topics deferred for later.

## Notable Quotes
Direct or near-direct quotes that are particularly important, insightful, or represent key positions. Use blockquote format.

Rules:
- Write in the same language as the transcript
- Use rich markdown: headers, bullets, bold for emphasis, blockquotes for quotes, tables if data warrants it
- Prioritize completeness over brevity — include everything substantive
- Group related information logically, but do not lose details in the process
- Output ONLY the markdown report, no preamble or closing remarks`

    const args = ['-p', prompt, '--model', 'sonnet', '--no-session-persistence']

    const { stdout } = await execa('claude', args, {
      timeout: 300000, // 5 min for long transcripts
      env: { ...process.env, CLAUDECODE: '' },
      extendEnv: false,
      input: transcript,
    })

    res.json({ report: stdout.trim() })
  } catch (error: any) {
    console.error('Error in AI report:', error)

    if (error.code === 'ENOENT') {
      res.status(500).json({ error: 'Claude CLI not found.' })
      return
    }
    if (error.timedOut) {
      res.status(500).json({ error: 'Request timed out.' })
      return
    }

    res.status(500).json({ error: error.message || 'Failed to generate report' })
  }
})

/**
 * POST /api/ai/kb-summary
 *
 * Generate a natural-language summary of a single KB entity in the
 * requested language. The summary is built from the entity itself plus
 * its 1-hop neighborhood, so the model has enough context to explain
 * what the item is about, who is involved, and what other knowledge
 * artifacts surround it.
 *
 * Body: { projectPath: string, entityId: string, language: 'es' | 'en' }
 * Returns: { summary: string }
 */
aiRouter.post('/kb-summary', async (req, res) => {
  try {
    const { projectPath, entityId, language } = req.body as {
      projectPath?: string
      entityId?: string
      language?: 'es' | 'en'
    }

    if (!projectPath || !entityId) {
      res.status(400).json({ error: 'projectPath and entityId are required' })
      return
    }
    const lang: 'es' | 'en' = language === 'es' ? 'es' : 'en'

    const kb = new KnowledgeBaseManager(projectPath)
    if (!kb.isInitialized()) {
      res.status(404).json({ error: 'KB not initialized for this project' })
      return
    }

    const entity = await kb.getEntity(entityId)
    if (!entity) {
      res.status(404).json({ error: `Entity ${entityId} not found` })
      return
    }

    // 1-hop neighborhood: outgoing edges (this entity → others) AND
    // incoming edges (other entities → this one). Provides the model
    // with the connective tissue needed to explain context.
    const all = await kb.listEntities()
    const byId = new Map(all.map((e) => [e.id, e]))
    const outgoing = entity.edges.map((edge) => ({
      relation: edge.relation,
      target: byId.get(edge.target),
    })).filter((x) => x.target)
    const incoming: Array<{ from: typeof entity; relation: string }> = []
    for (const e of all) {
      if (e.id === entity.id) continue
      for (const edge of e.edges) {
        if (edge.target === entity.id) incoming.push({ from: e, relation: edge.relation })
      }
    }

    // Render a compact, human-readable dump of everything the model needs.
    // Stay under ~6000 chars to keep the prompt cheap even for hairy entities.
    const lines: string[] = []
    lines.push(`Type: ${entity.type}`)
    lines.push(`Title: ${entity.title}`)
    lines.push(`Status: ${entity.status}`)
    if (entity.tags.length) lines.push(`Tags: ${entity.tags.map((t) => '#' + t).join(' ')}`)
    lines.push(`Created: ${entity.created}`)
    lines.push(`Updated: ${entity.updated}`)
    lines.push('')
    lines.push('Properties:')
    for (const [k, v] of Object.entries(entity.properties)) {
      const value = typeof v === 'string' ? v : JSON.stringify(v)
      lines.push(`  ${k}: ${value.length > 1200 ? value.slice(0, 1200) + '…' : value}`)
    }
    if (outgoing.length) {
      lines.push('')
      lines.push('Related entities (this → others):')
      for (const { relation, target } of outgoing.slice(0, 30)) {
        if (!target) continue
        lines.push(`  ${relation} → [${target.type}] ${target.title} (status: ${target.status})`)
      }
    }
    if (incoming.length) {
      lines.push('')
      lines.push('Referenced by:')
      for (const { from, relation } of incoming.slice(0, 30)) {
        lines.push(`  [${from.type}] ${from.title} —${relation}→ this`)
      }
    }
    let dump = lines.join('\n')
    if (dump.length > 6000) dump = dump.slice(0, 6000) + '\n…(truncated)'

    const langName = lang === 'es' ? 'Spanish' : 'English'
    const prompt = `You are summarizing a single item from a project knowledge base. The item's full record is supplied via stdin: its type, properties, tags, related entities (outgoing and incoming references).

Write a clear, useful summary in ${langName} that lets a teammate understand:
  - What this item IS (in one sentence — type + what it covers)
  - The key facts: dates, owners, status, decisions, outcomes
  - How it connects to its surroundings — call out the most important related items by name
  - Anything that looks unresolved, blocked, or needing attention

Style:
  - Native ${langName}, professional but warm — not stiff
  - Use short paragraphs and bullet lists when they help; do NOT wrap in code fences
  - 150-300 words depending on how much real content there is
  - If the item has very little content, say so honestly in one or two sentences instead of padding
  - Do not invent details that aren't in the input

Output ONLY the summary, no preamble or closing remarks.`

    const args = ['-p', prompt, '--model', 'sonnet', '--no-session-persistence']

    const { stdout } = await execa('claude', args, {
      timeout: 120000,
      env: { ...process.env, CLAUDECODE: '' },
      extendEnv: false,
      input: dump,
    })

    res.json({ summary: stdout.trim(), language: lang })
  } catch (error: any) {
    console.error('Error in AI kb-summary:', error)
    if (error.code === 'ENOENT') {
      res.status(500).json({ error: 'Claude CLI not found.' })
      return
    }
    if (error.timedOut) {
      res.status(500).json({ error: 'Request timed out.' })
      return
    }
    res.status(500).json({ error: error.message || 'Failed to generate summary' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/ai/topic-stream
//
// Summarizes a rolling slice of the live meeting transcript into a
// "current topic" card. Called by the sidepanel every ~20s while a
// recording is going. Uses the same `@anthropic-ai/claude-agent-sdk`
// `query()` helper as the master-agent daemon does — that means:
//   - Auth comes from the user's local Claude Code login (no API key
//     required in the server env).
//   - Structured output is enforced via a JSON schema — no fence
//     stripping / try/parse dance around free-form text.
//   - Latency is a few seconds per call, which matches the 20s cadence
//     the frontend uses.
// ---------------------------------------------------------------------------

interface TopicStreamTopic {
  id: string
  title: string
  summary: string
  keyPoints: string[]
  sentiment: string
}

interface TopicStreamBody {
  /** Full running transcript. Still accepted so an older extension build
   *  keeps working — when no `existingTopics` are sent this is what gets
   *  segmented, exactly as before. */
  transcript: string
  /** Only the speech since the last segmentation. Sent together with
   *  `existingTopics` — that pair is what makes the call incremental. */
  newTranscript?: string
  /** Topics already established and shown to the user. They are treated
   *  as settled: the model extends them, it does not re-derive them. */
  existingTopics?: TopicStreamTopic[]
  language?: 'es' | 'en' | 'auto'
  hint?: string
}

/**
 * Incremental segmentation prompt.
 *
 * The original prompt re-segmented the whole transcript on every poll,
 * with no knowledge of what it had already produced. Twenty seconds
 * later it would merge two topics into one, split another, and reword
 * every title — so the panel rewrote itself every cycle and nothing the
 * user had read stayed put.
 *
 * This one is handed the topics already on screen and only the new
 * speech, and is told the existing ones are settled. Its job shrinks
 * from "segment a meeting" to "does this new stretch continue the last
 * topic, or start a new one?" — a far narrower question, and a stable
 * one, because past answers are inputs rather than something to
 * re-derive.
 */
const TOPIC_INCREMENTAL_SYSTEM_PROMPT = `You are a meeting-transcript segmenter working INCREMENTALLY on a live meeting.

You receive:
1. TOPICS SO FAR — the segments already established and already shown to the user, in chronological order, each with a stable id.
2. NEW TRANSCRIPT — only the speech since the last time you were called.

Your job is NOT to re-segment the meeting. The existing topics are SETTLED. You decide what the new speech does to them.

Output ONE JSON object with this shape (nothing else):
{
  "updates": [
    { "id": "existing-topic-id", "summary": "...", "keyPoints": ["..."], "sentiment": "...", "title": "..." }
  ],
  "newTopics": [
    { "title": "...", "summary": "...", "keyPoints": ["..."], "sentiment": "..." }
  ]
}

## Decide per stretch of new speech

- The new speech CONTINUES the last topic → put an entry in "updates" for that topic id, with an enriched summary and any new keyPoints.
- The new speech STARTS a new subject → add one entry to "newTopics".
- The new speech RETURNS to an earlier subject → you may update that older topic by its id. This is rare; only do it when the new speech genuinely adds facts to that subject.
- The new speech adds nothing (filler, crosstalk, silence) → return {"updates":[],"newTopics":[]}. Returning nothing is a valid and useful answer.

## The test for "continue" vs "new"

Ask: would someone scanning the existing titles expect to find this content under the last one?

- YES → it continues. Update it.
- NO → it is a new topic, even if it is related, and even if the same people are still talking. Stretching a topic to cover a subject its title does not describe is WORSE than adding one: the user reads the title, opens the card, and finds something else.

Strong signals that a new topic started — treat these as new unless the content plainly says otherwise:
- The speakers announce one: "segundo punto", "pasemos a", "otro tema", "cambiando de tema", "next up".
- A different system, component, or product becomes the subject.
- A different problem or question is put on the table.
- The meeting turns to wrap-up: assigning owners, next steps, scheduling the follow-up.

Signals that it is NOT a new topic:
- Same subject, more detail, an example, or someone confirming what was just said.
- A brief tangent or joke that returns to the same subject.
- Only the wording changed.

## Rules that keep the panel stable — these matter most

- NEVER change the "title" of an existing topic unless it is now plainly wrong. A settled title the user has already read must not churn between polls.
- NEVER split an existing topic, merge two of them, delete one, or reorder them. You cannot express those operations and must not try.
- Only include a topic in "updates" if something ACTUALLY changed. An update that restates the same summary is noise — leave it out.
- When you update a summary, EXTEND what is there: keep the facts already recorded and add the new ones. Do not rewrite it from scratch in different words.
- keyPoints in an update REPLACE the topic's list, so repeat the existing points you want to keep and append the new ones. At most 5 total — when full, keep the most important, not merely the most recent.
- Do not open a new topic for a rephrasing, an example, or a follow-up question about the subject already being discussed. Several new topics from one short stretch of speech means you over-segmented — but folding a genuinely different subject into an existing card to avoid that is the worse error.

## Field rules

- title: 3-8 words in the transcript's dominant language (Spanish/English; default Spanish if mixed). No filler like "Discussion about".
- summary: 2-4 sentences of what was actually discussed. Concrete, not generic.
- keyPoints: at most 5 short bullets (facts, decisions, questions, action items).
- sentiment: exactly one of "neutral" | "positive" | "concerned" | "excited".
- Never invent speaker names.

## When TOPICS SO FAR is empty

There is nothing to continue, so segment the transcript you were given into "newTopics" (leave "updates" empty). Aim for 1 topic per ~30-90 seconds of discussion. The first topic can be greetings/setup if that is how the meeting opened — give it a real title like "Saludos iniciales".

## Output rules — VIOLATIONS BREAK THE UPSTREAM PARSER
- Your FIRST character MUST be "{" and your LAST character MUST be "}".
- Do NOT wrap the JSON in Markdown fences.
- Do NOT preface with prose ("Here is...", "Analizando...").
- Do NOT append anything after the closing "}".

Example — new speech continues the last topic and opens one new subject:
{"updates":[{"id":"t3","summary":"Se detectó que la calidad del transcript baja con chunks cortos. Se acordó subir el mínimo de hop a 1.5s y agregar overlap de 500ms, y ya se probó con un audio real.","keyPoints":["Chunks cortos degradan calidad","Subir mínimo a 1.5s","Overlap 500ms","Probado con audio real"],"sentiment":"concerned"}],"newTopics":[{"title":"Siguientes pasos y responsables","summary":"Se repartieron las tareas para el cierre de la semana.","keyPoints":["Ana: backend","Luis: pruebas"],"sentiment":"neutral"}]}

Example — nothing worth recording happened:
{"updates":[],"newTopics":[]}`

const TOPIC_INCREMENTAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    updates: {
      type: 'array',
      description: 'Existing topics that the new speech genuinely changed. Empty when nothing changed.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Id of the existing topic being extended' },
          title: { type: 'string', description: 'Only when the old title is plainly wrong' },
          summary: { type: 'string', description: 'Extended summary — keeps prior facts, adds new ones' },
          keyPoints: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 5,
            description: 'Full replacement list: repeat the points to keep, append the new ones',
          },
          sentiment: { type: 'string', enum: ['neutral', 'positive', 'concerned', 'excited'] },
        },
        required: ['id'],
      },
    },
    newTopics: {
      type: 'array',
      description: 'Subjects that started in the new speech. Usually zero or one.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '3-8 word topic title in the transcript language' },
          summary: { type: 'string', description: '2-4 sentence description of what was actually said' },
          keyPoints: { type: 'array', items: { type: 'string' }, maxItems: 5 },
          sentiment: { type: 'string', enum: ['neutral', 'positive', 'concerned', 'excited'] },
        },
        required: ['title', 'summary', 'keyPoints', 'sentiment'],
      },
    },
  },
  required: ['updates', 'newTopics'],
}

/**
 * Render the settled topics for the prompt.
 *
 * Recent topics go in full because the new speech most likely continues
 * one of them. Older ones collapse to a title — the model still needs to
 * know they exist so it doesn't open a duplicate, but their bodies would
 * just spend context. A 30-minute meeting reaches ~25 topics, which sent
 * in full would dwarf the handful of new sentences being classified.
 */
const TOPIC_FULL_DETAIL_COUNT = 8

function renderExistingTopics(topics: TopicStreamTopic[]): string {
  const splitAt = Math.max(0, topics.length - TOPIC_FULL_DETAIL_COUNT)
  const older = topics.slice(0, splitAt)
  const recent = topics.slice(splitAt)

  const lines: string[] = []
  if (older.length > 0) {
    lines.push('Earlier topics (titles only — already closed, listed so you do not duplicate them):')
    older.forEach((t, i) => lines.push(`  ${i + 1}. [${t.id}] ${t.title}`))
    lines.push('')
  }
  lines.push('Most recent topics (full detail — the new speech most likely continues the LAST one):')
  recent.forEach((t, i) => {
    const n = splitAt + i + 1
    lines.push(`  ${n}. [${t.id}] ${t.title}`)
    if (t.summary) lines.push(`     summary: ${t.summary}`)
    if (t.keyPoints?.length) lines.push(`     keyPoints: ${t.keyPoints.join(' | ')}`)
    lines.push(`     sentiment: ${t.sentiment || 'neutral'}`)
  })
  return lines.join('\n')
}

aiRouter.post('/topic-stream', async (req, res) => {
  const { transcript, newTranscript, existingTopics, language, hint } =
    (req.body || {}) as TopicStreamBody

  const priorTopics = Array.isArray(existingTopics) ? existingTopics : []
  const incremental = priorTopics.length > 0

  // Incremental calls are judged on the DELTA; only the first call (no
  // topics yet) needs the whole transcript.
  const source = incremental ? (newTranscript || '') : (transcript || '')
  if (typeof source !== 'string' || source.trim().length < 20) {
    if (incremental) {
      // Not an error — 20s of silence or crosstalk is normal. Answering
      // "nothing changed" keeps the client's poll loop simple.
      res.json({ updates: [], newTopics: [], latencyMs: 0, skipped: 'not enough new speech' })
      return
    }
    res.status(400).json({ error: 'transcript too short to segment' })
    return
  }

  // Cap what we send. On the first call this is the whole meeting, so we
  // keep the tail — the most recent content matters most for a live
  // panel and the early minutes are the least costly thing to drop. On
  // incremental calls the delta is a few hundred chars and the cap never
  // bites; it only guards against a client that stalled and then sent a
  // huge catch-up chunk.
  const MAX_CHARS = incremental ? 6000 : 12000
  const trimmedSource = source.length > MAX_CHARS
    ? '(…earlier transcript trimmed…)\n' + source.slice(-MAX_CHARS)
    : source

  const userText = [
    hint ? `Extra hint: ${hint}` : null,
    language && language !== 'auto' ? `Preferred output language: ${language}` : null,
    incremental
      ? `TOPICS SO FAR:\n${renderExistingTopics(priorTopics)}`
      : 'TOPICS SO FAR:\n  (none — this is the first segmentation)',
    incremental
      ? `NEW TRANSCRIPT (only the speech since the last call):\n"""\n${trimmedSource}\n"""`
      : `Full meeting transcript so far:\n"""\n${trimmedSource}\n"""`,
    incremental
      ? 'Decide what this new speech does to the topics above. Respond with exactly one JSON object matching the schema. No prose, no fences. First character "{", last character "}".'
      : 'Segment this into topics as instructed, all of them under "newTopics" with "updates" empty. Respond with exactly one JSON object matching the schema. No prose, no fences. First character "{", last character "}".',
  ].filter(Boolean).join('\n\n')

  try {
    const t0 = Date.now()
    let structured: unknown = null
    let resultText: string | undefined
    let collectedText = ''      // fallback: any text emitted by the model
    const messageTypesSeen: string[] = []

    // Iterate the SDK stream. maxTurns=2 gives the model room to both
    // reason and materialize the json_schema output — with 1 the tool
    // call sometimes cuts before it lands and `result` comes back empty.
    // We also fan-out over EVERY message type so short-circuits like
    // assistant text blocks give us something to fall back on.
    for await (const message of query({
      prompt: userText,
      options: {
        model: 'haiku',
        systemPrompt: TOPIC_INCREMENTAL_SYSTEM_PROMPT,
        maxTurns: 2,
        allowedTools: [],
        outputFormat: {
          type: 'json_schema',
          schema: TOPIC_INCREMENTAL_SCHEMA,
        },
      } as any,  // outputFormat may not be in the sdk d.ts yet; the runtime accepts it
    })) {
      const msg = message as Record<string, unknown>
      const t = String(msg.type || '')
      messageTypesSeen.push(t)
      if (t === 'result') {
        structured = msg.structured_output
        resultText = msg.result as string | undefined
      }
      // Assistant messages carry `message.content` as an array of
      // content blocks; text blocks contain the model's prose. When the
      // json_schema path fails silently we can still parse JSON out of
      // this text.
      if (t === 'assistant' && msg.message && typeof msg.message === 'object') {
        const inner = msg.message as Record<string, unknown>
        const content = inner.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object') {
              const b = block as Record<string, unknown>
              if (b.type === 'text' && typeof b.text === 'string') {
                collectedText += b.text
              }
            }
          }
        } else if (typeof inner.content === 'string') {
          collectedText += inner.content
        }
      }
      if (typeof msg.text === 'string') collectedText += msg.text
    }

    // Fallback ladder: prefer explicit structured_output, then parse
    // whatever text we captured (result field OR assistant blocks).
    if (!structured) {
      const candidates = [resultText, collectedText].filter((s): s is string => !!s && s.length > 0)
      for (const raw of candidates) {
        const cleaned = raw
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim()
        // Some models wrap the JSON in prose ("Here is the topic: {...}").
        // Extract the first {...} block that parses.
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
        const attempts = jsonMatch ? [jsonMatch[0], cleaned] : [cleaned]
        for (const attempt of attempts) {
          try {
            const parsed = JSON.parse(attempt)
            if (parsed && typeof parsed === 'object') {
              structured = parsed
              break
            }
          } catch {
            // try next
          }
        }
        if (structured) break
      }
    }

    if (!structured || typeof structured !== 'object') {
      console.error('[topic-stream] no usable output — messages seen:', messageTypesSeen, 'text:', collectedText.slice(0, 200))
      res.status(502).json({
        error: 'Claude returned no usable structured output',
        raw: (resultText || collectedText || '').slice(0, 400),
        seen: messageTypesSeen,
      })
      return
    }

    const parsed = structured as Record<string, unknown>
    const updates = Array.isArray(parsed.updates) ? parsed.updates : []
    // `topics` is tolerated as an alias for `newTopics`: the two prompts
    // differ only in framing and the model occasionally reaches for the
    // older key on a first-call segmentation.
    const newTopics = Array.isArray(parsed.newTopics)
      ? parsed.newTopics
      : (Array.isArray(parsed.topics) ? parsed.topics : [])

    // Drop updates that name a topic the client doesn't have. The model
    // does occasionally invent an id, and applying one would silently do
    // nothing on the client while looking like a successful poll here.
    const knownIds = new Set(priorTopics.map((t) => t.id))
    const applicable = updates.filter((u) => {
      const id = (u as Record<string, unknown>)?.id
      return typeof id === 'string' && knownIds.has(id)
    })
    const droppedUpdates = updates.length - applicable.length
    if (droppedUpdates > 0) {
      console.warn(`[topic-stream] dropped ${droppedUpdates} update(s) for unknown topic ids`)
    }

    res.json({
      updates: applicable,
      newTopics,
      // Back-compat: an older extension build reads `topics` and expects
      // the full list. It never sends `existingTopics`, so its calls are
      // always first-call segmentations and `newTopics` IS the full list.
      topics: incremental ? undefined : newTopics,
      latencyMs: Date.now() - t0,
    })
  } catch (err) {
    const e = err as Error
    console.error('Error in AI topic-stream:', e)
    res.status(500).json({ error: e.message || 'topic-stream failed' })
  }
})

interface EditCodeBody {
  /** The exact text the user selected — this is what gets rewritten. */
  selection: string
  /** What to do with it, in the user's words ("make it an arrow function"). */
  instruction: string
  /** Project-relative path, used for language cues in the prompt. */
  filePath?: string
  /** Lines around the selection. Not rewritten, but the model needs them
   *  to keep names, types and style consistent with the file. */
  contextBefore?: string
  contextAfter?: string
}

/**
 * Strip the wrapper a model puts around code even when told not to.
 *
 * Instructions alone don't hold: ```-fences and a leading "Here's the
 * updated code:" show up often enough that the caller would be pasting
 * prose into the file. Peeling them here is cheap and idempotent — text
 * that arrives clean passes through untouched.
 */
function unwrapCodeReply(raw: string): string {
  let out = raw.trim()

  // A single fenced block, optionally preceded by a sentence of preamble.
  const fenced = out.match(/```[a-zA-Z0-9+#-]*\n([\s\S]*?)```/)
  if (fenced) {
    out = fenced[1]
  } else {
    // Unterminated fence (truncated reply) — drop the opener.
    out = out.replace(/^```[a-zA-Z0-9+#-]*\n?/, '')
  }

  // Trailing newline only; leading whitespace can be meaningful
  // indentation, so it stays.
  return out.replace(/\s+$/, '')
}

/**
 * Put back the selection's leading indentation if the reply dropped it.
 *
 * A selection dragged from the start of a line carries its indent, and
 * the replacement is substituted at that exact position — so a reply
 * that starts flush left silently dedents the first line while the rest
 * of the block keeps its original depth. Models do this often enough
 * that the prompt alone can't be trusted.
 *
 * Only applied when the reply has no leading whitespace at all: if it
 * came back indented differently, that was a deliberate choice and
 * second-guessing it would be worse.
 */
function restoreLeadingIndent(original: string, edited: string): string {
  const indent = original.match(/^[ \t]+/)?.[0]
  if (!indent) return edited
  if (/^[ \t]/.test(edited)) return edited
  return indent + edited
}

/**
 * POST /api/ai/edit-code
 *
 * Rewrite a selected span of code according to a plain-language
 * instruction, and return ONLY the replacement text so the editor can
 * drop it straight into the selection's range.
 *
 * The surrounding lines are sent as read-only context: rewriting a
 * function body in isolation produces code that doesn't match the
 * file's naming or style, and the model needs to see what's in scope.
 * They are explicitly marked do-not-return so they don't come back
 * duplicated into the file.
 */
aiRouter.post('/edit-code', async (req, res) => {
  try {
    const { selection, instruction, filePath, contextBefore, contextAfter } = req.body as EditCodeBody

    if (!selection?.trim()) {
      res.status(400).json({ error: 'selection is required' })
      return
    }
    if (!instruction?.trim()) {
      res.status(400).json({ error: 'instruction is required' })
      return
    }

    const prompt = [
      'You are editing code inside an editor. Rewrite ONLY the selected snippet',
      'according to the instruction.',
      '',
      'Output rules — these are absolute:',
      '- Return the replacement snippet and NOTHING else.',
      '- No markdown fences, no language tag, no explanation, no preamble.',
      '- Do not return the surrounding context; it is shown to you only so the',
      '  rewrite matches the file, and it stays in the file either way.',
      '- Preserve the indentation style of the original snippet, since the text',
      '  is substituted directly into its position.',
      '- If the instruction cannot be applied, return the snippet unchanged.',
      '',
      filePath ? `File: ${filePath}` : '',
      '',
      `Instruction: ${instruction}`,
    ].filter(Boolean).join('\n')

    // Everything sizeable travels on stdin rather than argv — a large
    // selection would otherwise risk the command-line length limit.
    const stdin = [
      contextBefore ? `--- CONTEXT BEFORE (do not return) ---\n${contextBefore}` : '',
      `--- SELECTED SNIPPET (rewrite this) ---\n${selection}`,
      contextAfter ? `--- CONTEXT AFTER (do not return) ---\n${contextAfter}` : '',
    ].filter(Boolean).join('\n\n')

    const { stdout } = await execa(
      'claude',
      ['-p', prompt, '--model', 'sonnet', '--no-session-persistence'],
      {
        timeout: 120000,
        input: stdin,
        // Unset CLAUDECODE so the CLI doesn't refuse as a nested session.
        env: { ...process.env, CLAUDECODE: '' },
        extendEnv: false,
      }
    )

    const edited = restoreLeadingIndent(selection, unwrapCodeReply(stdout))
    if (!edited) {
      res.status(502).json({ error: 'The model returned an empty edit' })
      return
    }

    res.json({ edited, unchanged: edited === selection })
  } catch (error: any) {
    console.error('Error in AI edit-code:', error)
    if (error.code === 'ENOENT') {
      res.status(500).json({ error: 'Claude CLI not found. Make sure claude is installed and in PATH.' })
      return
    }
    if (error.timedOut) {
      res.status(500).json({ error: 'The edit timed out. Try a smaller selection.' })
      return
    }
    res.status(500).json({ error: error.message || 'Failed to edit code' })
  }
})
