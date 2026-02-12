/**
 * Agents API Router
 *
 * Phase 1: Minimal REST endpoints for agent CRUD and lifecycle
 */

import { Router } from 'express'
import { getAgentManager } from '../../agent/AgentManager'
import { logger } from '../../utils'
import { AgentHookTrigger } from '../../models/Agent'

export const agentsRouter = Router()

/**
 * GET /api/agents - List all agents
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
 * POST /api/agents - Create a new agent
 */
agentsRouter.post('/', async (req, res) => {
  try {
    const { name, masterPrompt, hookEvents, autoApprove } = req.body

    if (!name || !masterPrompt) {
      res.status(400).json({ error: 'name and masterPrompt are required' })
      return
    }

    const manager = await getAgentManager()
    const agent = await manager.createAgent(name, masterPrompt, {
      hookEvents: hookEvents as AgentHookTrigger[],
      autoApprove,
    })

    res.status(201).json(agent)
  } catch (error: any) {
    logger.error('Failed to create agent:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/agents/:id - Get a specific agent
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
 * PUT /api/agents/:id - Update an agent
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
 * DELETE /api/agents/:id - Delete an agent
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
 * POST /api/agents/:id/start - Start an agent daemon
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
 * POST /api/agents/:id/stop - Stop an agent daemon
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
 * POST /api/agents/:id/connect - Connect an agent to a project
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
 * POST /api/agents/:id/disconnect - Disconnect an agent from its project
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
 * GET /api/agents/:id/logs - Get logs for a specific agent
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
 * DELETE /api/agents/:id/logs - Clear logs for a specific agent
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
