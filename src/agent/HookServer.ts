/**
 * HookServer - HTTP server that receives Claude Code hook events
 */

import express, { Express, Request, Response } from 'express'
import cors from 'cors'
import { Server } from 'http'
import { logger } from '../utils'
import { HookEventPayload, ProcessedHookEvent } from '../models/HookEvent'
import { getAgentStateManager } from './AgentStateManager'

/**
 * Hook event handler function type
 */
export type HookEventHandler = (event: ProcessedHookEvent) => Promise<void>

/**
 * HookServer receives hook events from Claude Code sessions
 */
export class HookServer {
  private app: Express
  private server: Server | null = null
  private port: number
  private eventHandlers: Map<string, HookEventHandler[]> = new Map()
  private globalHandlers: HookEventHandler[] = []

  constructor(port: number = 9999) {
    this.port = port
    this.app = express()
    this.setupMiddleware()
    this.setupRoutes()
  }

  private setupMiddleware(): void {
    this.app.use(cors())
    this.app.use(express.json())
    this.app.use(express.text({ type: '*/*' }))
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        service: 'hook-server',
        timestamp: new Date().toISOString(),
      })
    })

    // Receive hook events for a specific agent
    this.app.post('/api/hooks/:agentId', async (req: Request, res: Response) => {
      const agentId = req.params.agentId as string

      try {
        // Parse the payload - could be JSON string or already parsed
        let payload: HookEventPayload
        let rawPayload: Record<string, unknown> = {}

        if (typeof req.body === 'string') {
          try {
            rawPayload = JSON.parse(req.body)
          } catch {
            // If not valid JSON, wrap it
            rawPayload = { raw_stdin: req.body }
          }
        } else {
          rawPayload = req.body
        }

        // Normalize the payload - Claude Code uses hook_event_name
        const eventType = (rawPayload.hook_event_name || rawPayload.event_type || 'Stop') as string

        payload = {
          event_type: eventType as HookEventPayload['event_type'],
          timestamp: (rawPayload.timestamp as string) || new Date().toISOString(),
          session_id: rawPayload.session_id as string,
          cwd: rawPayload.cwd as string,
          raw_stdin: typeof req.body === 'string' ? req.body : undefined,
        }

        // Extract type-specific data based on event type
        switch (eventType) {
          case 'PreCompact':
            payload.compact_data = {
              trigger: (rawPayload.trigger as 'manual' | 'auto') || 'manual',
              custom_instructions: rawPayload.custom_instructions as string | null,
            }
            break
          case 'SessionStart':
            payload.session_start_data = {
              source: (rawPayload.source as 'startup' | 'resume' | 'clear' | 'compact') || 'startup',
            }
            break
          case 'SessionEnd':
            payload.session_end_data = {
              reason: (rawPayload.reason as string) || 'unknown',
            }
            break
          case 'Notification':
            payload.notification_data = {
              title: rawPayload.title as string,
              body: rawPayload.message as string || rawPayload.body as string,
              type: rawPayload.notification_type as 'info' | 'warning' | 'error',
            }
            break
          case 'PreToolUse':
          case 'PostToolUse':
            payload.tool_data = {
              tool_name: rawPayload.tool_name as string,
              tool_input: rawPayload.tool_input as Record<string, unknown>,
            }
            break
          case 'Stop':
            payload.stop_data = {
              stop_hook_active: rawPayload.stop_hook_active as boolean ?? true,
            }
            break
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

        logger.info(`Hook received for agent ${agentId}: ${payload.event_type}`)
        logger.debug('Hook payload:', JSON.stringify(payload, null, 2))

        // Call handlers
        await this.dispatchEvent(processedEvent)

        res.json({
          status: 'received',
          agentId,
          eventType: payload.event_type,
          timestamp: processedEvent.receivedAt,
        })
      } catch (error: any) {
        logger.error(`Error processing hook for agent ${agentId}:`, error)
        res.status(500).json({ error: error.message })
      }
    })

    // Generic hook endpoint (for testing)
    this.app.post('/api/hooks', async (req: Request, res: Response) => {
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
        })
      } catch (error: any) {
        logger.error('Error processing generic hook:', error)
        res.status(500).json({ error: error.message })
      }
    })
  }

  /**
   * Dispatch event to handlers
   */
  private async dispatchEvent(event: ProcessedHookEvent): Promise<void> {
    event.status = 'processing'

    try {
      // Call agent-specific handlers
      const agentHandlers = this.eventHandlers.get(event.agentId) || []
      for (const handler of agentHandlers) {
        await handler(event)
      }

      // Call global handlers
      for (const handler of this.globalHandlers) {
        await handler(event)
      }

      event.status = 'completed'
    } catch (error: any) {
      event.status = 'failed'
      event.error = error.message
      throw error
    }
  }

  /**
   * Register a handler for a specific agent
   */
  onAgentEvent(agentId: string, handler: HookEventHandler): void {
    if (!this.eventHandlers.has(agentId)) {
      this.eventHandlers.set(agentId, [])
    }
    this.eventHandlers.get(agentId)!.push(handler)
  }

  /**
   * Remove handlers for an agent
   */
  removeAgentHandlers(agentId: string): void {
    this.eventHandlers.delete(agentId)
  }

  /**
   * Register a global handler (receives all events)
   */
  onEvent(handler: HookEventHandler): void {
    this.globalHandlers.push(handler)
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, () => {
          logger.info(`Hook server running at http://localhost:${this.port}`)
          resolve()
        })

        this.server.on('error', (error: any) => {
          if (error.code === 'EADDRINUSE') {
            logger.error(`Port ${this.port} is already in use`)
          }
          reject(error)
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server!.close((error) => {
          if (error) {
            reject(error)
          } else {
            logger.info('Hook server stopped')
            this.server = null
            resolve()
          }
        })
      })
    }
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== null
  }

  /**
   * Get server port
   */
  getPort(): number {
    return this.port
  }

  /**
   * Get Express app (for testing)
   */
  getApp(): Express {
    return this.app
  }
}

// Singleton instance
let hookServer: HookServer | null = null

export async function getHookServer(port?: number): Promise<HookServer> {
  if (!hookServer) {
    const stateManager = await getAgentStateManager()
    const serverPort = port || stateManager.getHookServerPort()
    hookServer = new HookServer(serverPort)
  }
  return hookServer
}
