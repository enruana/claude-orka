/**
 * Agents API Router
 * Provides REST endpoints for managing Master Agents
 */

import { Router } from 'express'
import { getAgentManager } from '../../agent/AgentManager'
import { logger } from '../../utils'
import { AgentHookTrigger, NotificationConfig, PromptRole } from '../../models/Agent'

export const agentsRouter = Router()

/**
 * GET /api/agents
 * List all agents
 */
agentsRouter.get('/', async (_req, res) => {
  try {
    const manager = await getAgentManager()
    const agents = manager.getAgents()
    res.json(agents)
  } catch (error: any) {
    logger.error('Failed to list agents:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/agents
 * Create a new agent
 * Body: { name: string, masterPrompt: string, hookEvents?: string[], autoApprove?: boolean, ... }
 */
agentsRouter.post('/', async (req, res) => {
  try {
    const { name, masterPrompt, hookEvents, notifications, autoApprove, maxConsecutiveResponses, decisionHistorySize, promptRoles, activeRoleId } = req.body

    if (!name || !masterPrompt) {
      res.status(400).json({ error: 'name and masterPrompt are required' })
      return
    }

    const manager = await getAgentManager()
    const agent = await manager.createAgent(name, masterPrompt, {
      hookEvents: hookEvents as AgentHookTrigger[],
      notifications: notifications as NotificationConfig,
      autoApprove,
      maxConsecutiveResponses,
      decisionHistorySize,
      promptRoles: promptRoles as PromptRole[],
      activeRoleId,
    })

    res.status(201).json(agent)
  } catch (error: any) {
    logger.error('Failed to create agent:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/agents/:id
 * Get a specific agent
 */
agentsRouter.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const manager = await getAgentManager()
    const agent = manager.getAgent(id)

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }

    res.json(agent)
  } catch (error: any) {
    logger.error('Failed to get agent:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * PUT /api/agents/:id
 * Update an agent
 * Body: Partial<Agent>
 */
agentsRouter.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const updates = req.body

    const manager = await getAgentManager()
    const agent = await manager.updateAgent(id, updates)

    res.json(agent)
  } catch (error: any) {
    logger.error('Failed to update agent:', error)
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message })
    } else {
      res.status(500).json({ error: error.message })
    }
  }
})

/**
 * DELETE /api/agents/:id
 * Delete an agent
 */
agentsRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const manager = await getAgentManager()
    const deleted = await manager.deleteAgent(id)

    if (!deleted) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }

    res.json({ success: true })
  } catch (error: any) {
    logger.error('Failed to delete agent:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/agents/:id/start
 * Start an agent daemon
 */
agentsRouter.post('/:id/start', async (req, res) => {
  try {
    const { id } = req.params
    const manager = await getAgentManager()

    await manager.startAgent(id)
    const agent = manager.getAgent(id)

    res.json(agent)
  } catch (error: any) {
    logger.error('Failed to start agent:', error)
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message })
    } else {
      res.status(500).json({ error: error.message })
    }
  }
})

/**
 * POST /api/agents/:id/stop
 * Stop an agent daemon
 */
agentsRouter.post('/:id/stop', async (req, res) => {
  try {
    const { id } = req.params
    const manager = await getAgentManager()

    await manager.stopAgent(id)
    const agent = manager.getAgent(id)

    res.json(agent)
  } catch (error: any) {
    logger.error('Failed to stop agent:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/agents/:id/pause
 * Pause an agent
 */
agentsRouter.post('/:id/pause', async (req, res) => {
  try {
    const { id } = req.params
    const manager = await getAgentManager()

    const agent = await manager.pauseAgent(id)
    res.json(agent)
  } catch (error: any) {
    logger.error('Failed to pause agent:', error)
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message })
    } else {
      res.status(500).json({ error: error.message })
    }
  }
})

/**
 * POST /api/agents/:id/resume
 * Resume an agent from paused or waiting_human state
 */
agentsRouter.post('/:id/resume', async (req, res) => {
  try {
    const { id } = req.params
    const manager = await getAgentManager()

    const agent = await manager.resumeAgent(id)
    res.json(agent)
  } catch (error: any) {
    logger.error('Failed to resume agent:', error)
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message })
    } else {
      res.status(500).json({ error: error.message })
    }
  }
})

/**
 * POST /api/agents/:id/connect
 * Connect an agent to a project
 * Body: { projectPath: string, sessionId?: string, tmuxPaneId?: string }
 */
agentsRouter.post('/:id/connect', async (req, res) => {
  try {
    const { id } = req.params
    const { projectPath, sessionId, tmuxPaneId, branchId } = req.body

    if (!projectPath) {
      res.status(400).json({ error: 'projectPath is required' })
      return
    }

    const manager = await getAgentManager()
    const agent = await manager.connectAgent(id, projectPath, sessionId, tmuxPaneId, branchId)

    res.json(agent)
  } catch (error: any) {
    logger.error('Failed to connect agent:', error)
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message })
    } else {
      res.status(500).json({ error: error.message })
    }
  }
})

/**
 * POST /api/agents/:id/disconnect
 * Disconnect an agent from its project
 */
agentsRouter.post('/:id/disconnect', async (req, res) => {
  try {
    const { id } = req.params
    const manager = await getAgentManager()

    const agent = await manager.disconnectAgent(id)
    res.json(agent)
  } catch (error: any) {
    logger.error('Failed to disconnect agent:', error)
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message })
    } else {
      res.status(500).json({ error: error.message })
    }
  }
})

/**
 * POST /api/agents/:id/trigger
 * Manually trigger an agent to analyze and act on its connected terminal
 * This simulates receiving a hook event
 */
agentsRouter.post('/:id/trigger', async (req, res) => {
  try {
    const { id } = req.params
    const manager = await getAgentManager()

    await manager.triggerAgent(id)
    const agent = manager.getAgent(id)

    res.json(agent)
  } catch (error: any) {
    logger.error('Failed to trigger agent:', error)
    if (error.message.includes('not found') || error.message.includes('not connected')) {
      res.status(400).json({ error: error.message })
    } else {
      res.status(500).json({ error: error.message })
    }
  }
})

/**
 * GET /api/agents/by-project/:encodedPath
 * Get agents connected to a specific project
 */
agentsRouter.get('/by-project/:encodedPath', async (req, res) => {
  try {
    const { encodedPath } = req.params
    const projectPath = Buffer.from(encodedPath, 'base64').toString('utf-8')

    const manager = await getAgentManager()
    const agents = manager.getAgentsByProject(projectPath)

    res.json(agents)
  } catch (error: any) {
    logger.error('Failed to get agents by project:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/agents/running
 * Get all running agents
 */
agentsRouter.get('/status/running', async (_req, res) => {
  try {
    const manager = await getAgentManager()
    const agents = manager.getRunningAgents()
    res.json(agents)
  } catch (error: any) {
    logger.error('Failed to get running agents:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/agents/:id/status
 * Get agent status summary (current phase, last decision, terminal snapshot, stats)
 */
agentsRouter.get('/:id/status', async (req, res) => {
  try {
    const { id } = req.params
    const manager = await getAgentManager()
    const status = manager.getAgentStatus(id)

    if (!status) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }

    res.json(status)
  } catch (error: any) {
    logger.error('Failed to get agent status:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/agents/improve-prompt
 * Send a prompt to Claude to get a refined version
 * Body: { prompt: string }
 */
agentsRouter.post('/improve-prompt', async (req, res) => {
  try {
    const { prompt, instructions } = req.body

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' })
      return
    }

    // Dynamic import to avoid issues if SDK is not available
    const { query } = await import('@anthropic-ai/claude-agent-sdk')

    const systemPrompt = `You are an expert prompt engineer. The user will give you a "master prompt" used to instruct an AI agent that monitors and responds to Claude Code terminal sessions.

Your job is to return an IMPROVED version of this prompt. Improvements should:
- Make instructions clearer and more specific
- Add structure with markdown headings, bullet points, numbered steps
- Remove ambiguity
- Add edge-case handling (what to do on errors, when stuck, etc.)
- Ensure the prompt covers the full workflow the user seems to intend
- Keep the user's original intent and goals intact
- Use markdown formatting for readability

The user may also provide specific instructions for how to improve the prompt. If provided, prioritize those instructions over general improvements.

Return ONLY the improved prompt text in markdown. Do not add any preamble, explanation, or commentary outside the prompt itself.`

    const userInstructions = instructions && typeof instructions === 'string' && instructions.trim()
      ? `\n\nUSER INSTRUCTIONS FOR THIS IMPROVEMENT:\n${instructions.trim()}`
      : ''

    const conversation = query({
      prompt: `Here is the current master prompt to improve:\n\n---\n${prompt}\n---${userInstructions}\n\nReturn the improved version:`,
      options: {
        systemPrompt,
        model: 'sonnet',
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
      },
    })

    let result = ''
    for await (const message of conversation) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if ('text' in block) {
            result += block.text
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success' && message.result) {
          result = message.result
        }
        break
      }
    }

    res.json({ improvedPrompt: result.trim() })
  } catch (error: any) {
    logger.error('Failed to improve prompt:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/agents/:id/logs
 * Get logs for a specific agent
 */
agentsRouter.get('/:id/logs', async (req, res) => {
  try {
    const { id } = req.params
    const manager = await getAgentManager()
    const logs = manager.getAgentLogs(id)
    res.json({ logs })
  } catch (error: any) {
    logger.error('Failed to get agent logs:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /api/agents/:id/logs
 * Clear logs for a specific agent
 */
agentsRouter.delete('/:id/logs', async (req, res) => {
  try {
    const { id } = req.params
    const manager = await getAgentManager()
    manager.clearAgentLogs(id)
    res.json({ success: true })
  } catch (error: any) {
    logger.error('Failed to clear agent logs:', error)
    res.status(500).json({ error: error.message })
  }
})
