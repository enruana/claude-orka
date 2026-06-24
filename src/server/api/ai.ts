import { Router } from 'express'
import execa from 'execa'
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

