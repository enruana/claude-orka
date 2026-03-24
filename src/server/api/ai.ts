import { Router } from 'express'
import execa from 'execa'
import { TmuxCommands } from '../../utils/tmux'

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
