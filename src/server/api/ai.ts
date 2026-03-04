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
