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

    const prompt = `You are an expert note-taker and report writer. Given the following transcript, produce a comprehensive, well-organized markdown report.

The report MUST include these sections (skip any that don't apply):
- **Summary**: A concise 2-3 sentence overview
- **Key Points**: Bullet list of the most important points discussed
- **Topics Discussed**: Each major topic as a subsection (### heading) with details
- **Decisions Made**: Any decisions or conclusions reached
- **Action Items**: Tasks, next steps, or follow-ups mentioned (with owners if identifiable)
- **Questions Raised**: Open questions or unresolved issues
- **Notable Quotes**: Important or memorable statements (quoted)

Rules:
- Write in the same language as the transcript
- Be thorough but organized — group related information
- Use markdown formatting (headers, bullets, bold, quotes)
- If the transcript is a meeting, identify participants when possible
- If it's a lecture/presentation, focus on the educational content
- Output ONLY the markdown report, no preamble

Transcript:
${transcript}`

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
