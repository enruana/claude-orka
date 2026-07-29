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

interface TopicStreamBody {
  transcript: string
  language?: 'es' | 'en' | 'auto'
  hint?: string
}

const TOPIC_SYSTEM_PROMPT = `You are a meeting-transcript segmenter. You receive the FULL live transcript of a meeting and split it into an ordered list of topic segments — each one representing a coherent subject the speakers discussed for some stretch of the conversation.

Output ONE JSON object with this shape (nothing else):
{
  "topics": [
    {
      "title": "string, 3-8 words",
      "summary": "string, 2-3 sentences",
      "keyPoints": ["string", "..."],
      "sentiment": "neutral" | "positive" | "concerned" | "excited"
    },
    ...
  ]
}

The topics array is ordered EARLIEST to LATEST (chronological). The client renders it with the most recent on top; you don't reverse it yourself.

Segmentation rules:
- Group by SUBJECT, not by paragraph. A stretch of small talk about the same joke is one topic. A tangent that briefly interrupts a decision discussion and then returns should be folded into the surrounding topic unless it's clearly its own subject.
- Aim for 1 topic every ~30-90 seconds of discussion. A 5-minute meeting typically has 3-8 topics; a 30-minute meeting typically has 10-25.
- Do NOT create a new topic just because the wording changed. The bar is a real shift in what's being discussed (new question, new agenda item, new problem).
- The FIRST topic can be small talk / setup / greetings if that's what the meeting opened with. Give it a real title like "Saludos iniciales" rather than "Introduction".
- If the transcript is too short or noisy to segment (< 3 sentences of real content), return a single-topic array whose title = "(sin contenido suficiente)" (or "(not enough content)" in English) and empty keyPoints.

Field rules per topic:
- title: 3-8 words in the transcript's dominant language (Spanish/English; default Spanish if mixed). No filler like "Discussion about" or "Introduction to".
- summary: 2-3 sentences describing what was actually discussed inside this segment. Concrete, not generic.
- keyPoints: at most 5 short bullets (facts, decisions, questions, action items). Empty array if nothing concrete.
- sentiment: exactly one of the four allowed values.
- Never invent speaker names. Only mention names if clearly stated in the transcript.

Output rules — VIOLATIONS BREAK THE UPSTREAM PARSER:
- Your FIRST character MUST be "{" and your LAST character MUST be "}".
- Do NOT wrap the JSON in Markdown fences.
- Do NOT preface with prose ("Here is...", "Analizando...", "Based on the transcript...").
- Do NOT append anything after the closing "}".

Example valid output (Spanish meeting, 3 topics):
{"topics":[{"title":"Saludos iniciales","summary":"El equipo se reunió y comentó cómo estuvo el fin de semana antes de arrancar la agenda.","keyPoints":[],"sentiment":"positive"},{"title":"Bug en el pipeline de transcripción","summary":"Se detectó que la calidad del transcript en vivo bajaba con chunks cortos. Se acordó subir el mínimo de hop a 1.5s y agregar overlap de 500ms.","keyPoints":["Chunks cortos degradan calidad","Subir mínimo a 1.5s","Overlap 500ms"],"sentiment":"concerned"},{"title":"Siguientes pasos y responsables","summary":"Se asignaron las tareas: Ana revisa el backend, Luis prueba con un audio real, revisamos mañana.","keyPoints":["Ana: backend","Luis: prueba con audio real","Revisión mañana"],"sentiment":"neutral"}]}`

const TOPIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    topics: {
      type: 'array',
      description: 'Ordered chronologically (earliest first). One entry per coherent subject discussed.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '3-8 word topic title in the transcript language' },
          summary: { type: 'string', description: '2-3 sentence description of what was actually said' },
          keyPoints: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 5,
            description: 'At most 5 short bullets of facts, decisions, or action items',
          },
          sentiment: {
            type: 'string',
            enum: ['neutral', 'positive', 'concerned', 'excited'],
          },
        },
        required: ['title', 'summary', 'keyPoints', 'sentiment'],
      },
    },
  },
  required: ['topics'],
}

aiRouter.post('/topic-stream', async (req, res) => {
  const { transcript, language, hint } = (req.body || {}) as TopicStreamBody
  if (!transcript || typeof transcript !== 'string' || transcript.trim().length < 20) {
    res.status(400).json({ error: 'transcript too short to segment' })
    return
  }

  // Cap the transcript we send at 12000 chars (~25 min of talk) so a very
  // long meeting doesn't blow past the model's context / our latency
  // budget. When it grows past the cap we keep the tail — Claude sees
  // the most recent content in full and only loses the early minutes,
  // which is the least useful thing to drop for a live-panel view.
  const MAX_CHARS = 12000
  const trimmedTranscript = transcript.length > MAX_CHARS
    ? '(…earlier transcript trimmed…)\n' + transcript.slice(-MAX_CHARS)
    : transcript

  const userText = [
    hint ? `Extra hint: ${hint}` : null,
    language && language !== 'auto' ? `Preferred output language: ${language}` : null,
    `Full meeting transcript so far:\n"""\n${trimmedTranscript}\n"""`,
    'Segment this into topics as instructed. Respond with exactly one JSON object matching the schema. No prose, no fences. First character "{", last character "}".',
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
        systemPrompt: TOPIC_SYSTEM_PROMPT,
        maxTurns: 2,
        allowedTools: [],
        outputFormat: {
          type: 'json_schema',
          schema: TOPIC_SCHEMA,
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

    // Response shape: { topics: [...] }. If Claude returned the shape
    // right, this is a pass-through. If it returned a single topic
    // (older client behavior), wrap it for backward compatibility.
    const parsed = structured as Record<string, unknown>
    const topics = Array.isArray(parsed.topics)
      ? parsed.topics
      : (parsed.title ? [parsed] : [])
    res.json({
      topics,
      latencyMs: Date.now() - t0,
    })
  } catch (err) {
    const e = err as Error
    console.error('Error in AI topic-stream:', e)
    res.status(500).json({ error: e.message || 'topic-stream failed' })
  }
})
