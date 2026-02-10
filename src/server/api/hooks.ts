/**
 * Hooks API Router
 * Receives hook events from Claude Code sessions
 * Note: This is a backup receiver - the main hook server runs on port 9999
 */

import { Router } from 'express'
import { getAgentStateManager } from '../../agent/AgentStateManager'
import { logger } from '../../utils'
import { HookEventPayload, ProcessedHookEvent } from '../../models/HookEvent'

export const hooksRouter = Router()

/**
 * POST /api/hooks/:agentId
 * Receive a hook event for a specific agent
 */
hooksRouter.post('/:agentId', async (req, res) => {
  const { agentId } = req.params

  try {
    // Parse the payload
    let payload: HookEventPayload

    if (typeof req.body === 'string') {
      try {
        payload = JSON.parse(req.body)
      } catch {
        // If not valid JSON, wrap it
        payload = {
          event_type: 'Stop',
          timestamp: new Date().toISOString(),
          raw_stdin: req.body,
        }
      }
    } else {
      payload = req.body
    }

    // Add timestamp if missing
    if (!payload.timestamp) {
      payload.timestamp = new Date().toISOString()
    }

    // Get agent info
    const stateManager = await getAgentStateManager()
    const agent = stateManager.getAgent(agentId)

    if (!agent) {
      logger.warn(`Hook received for unknown agent: ${agentId}`)
      res.status(404).json({ error: 'Agent not found' })
      return
    }

    // Create processed event
    const processedEvent: ProcessedHookEvent = {
      payload,
      agentId,
      projectPath: agent.connection?.projectPath || payload.cwd || '',
      orkaSessionId: agent.connection?.sessionId,
      receivedAt: new Date().toISOString(),
      status: 'pending',
    }

    logger.info(`Hook received via API for agent ${agentId}: ${payload.event_type}`)

    // The hook will be processed by the main HookServer
    // Here we just acknowledge receipt
    res.json({
      status: 'received',
      agentId,
      eventType: payload.event_type,
      timestamp: processedEvent.receivedAt,
      message: 'Hook event received and queued for processing',
    })
  } catch (error: any) {
    logger.error(`Error processing hook for agent ${agentId}:`, error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/hooks
 * Generic hook endpoint for testing
 */
hooksRouter.post('/', async (req, res) => {
  try {
    let payload: HookEventPayload

    if (typeof req.body === 'string') {
      try {
        payload = JSON.parse(req.body)
      } catch {
        payload = {
          event_type: 'Stop',
          timestamp: new Date().toISOString(),
          raw_stdin: req.body,
        }
      }
    } else {
      payload = req.body
    }

    logger.info(`Generic hook received: ${payload.event_type}`)
    logger.debug('Hook payload:', JSON.stringify(payload, null, 2))

    res.json({
      status: 'received',
      eventType: payload.event_type,
      timestamp: new Date().toISOString(),
      message: 'Generic hook received (not processed - use /api/hooks/:agentId for agent-specific hooks)',
    })
  } catch (error: any) {
    logger.error('Error processing generic hook:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/hooks/test
 * Test endpoint to verify hook server is working
 */
hooksRouter.get('/test', async (_req, res) => {
  try {
    const stateManager = await getAgentStateManager()
    const hookServerPort = stateManager.getHookServerPort()

    res.json({
      status: 'ok',
      message: 'Hooks API is working',
      hookServerPort,
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    logger.error('Error in hooks test:', error)
    res.status(500).json({ error: error.message })
  }
})
