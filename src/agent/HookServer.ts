/**
 * HookServer - HTTP server that receives Claude Code hook events
 *
 * Phase 1: Simplified Express server with POST /api/hooks/:agentId
 */

import express, { Express, Request, Response } from 'express'
import cors from 'cors'
import { Server } from 'http'
import { logger } from '../utils'
import { HookEventPayload, ProcessedHookEvent } from '../models/HookEvent'
import { getAgentStateManager } from './AgentStateManager'

export type HookEventHandler = (event: ProcessedHookEvent) => Promise<void>

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
        let rawPayload: Record<string, unknown> = {}

        if (typeof req.body === 'string') {
          try {
            rawPayload = JSON.parse(req.body)
          } catch {
            rawPayload = { raw_stdin: req.body }
          }
        } else {
          rawPayload = req.body
        }

        // Normalize the payload - Claude Code uses hook_event_name
        const eventType = (rawPayload.hook_event_name || rawPayload.event_type || 'Stop') as string

        const payload: HookEventPayload = {
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
          case 'PostToolUseFailure':
            payload.tool_failure_data = {
              tool_name: rawPayload.tool_name as string || 'unknown',
              tool_input: rawPayload.tool_input as Record<string, unknown>,
              tool_use_id: rawPayload.tool_use_id as string,
              error: rawPayload.error as string || 'unknown error',
              is_interrupt: rawPayload.is_interrupt as boolean ?? false,
            }
            break
          case 'PermissionRequest':
            payload.permission_request_data = {
              tool_name: rawPayload.tool_name as string || 'unknown',
              tool_input: rawPayload.tool_input as Record<string, unknown>,
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

        logger.info(`[HookServer] ${eventType} for ${agentId} [session: ${(payload.session_id || 'none').slice(0, 8)}]`)

        // Dispatch to handlers
        await this.dispatchEvent(processedEvent)

        res.json({
          status: 'received',
          agentId,
          eventType: payload.event_type,
          timestamp: processedEvent.receivedAt,
        })
      } catch (error: any) {
        logger.error(`[HookServer] Error processing hook for ${agentId}: ${error.message}`)
        res.status(500).json({ error: error.message })
      }
    })
  }

  private async dispatchEvent(event: ProcessedHookEvent): Promise<void> {
    event.status = 'processing'

    try {
      const agentHandlers = this.eventHandlers.get(event.agentId) || []
      for (const handler of agentHandlers) {
        await handler(event)
      }

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

  onAgentEvent(agentId: string, handler: HookEventHandler): void {
    if (!this.eventHandlers.has(agentId)) {
      this.eventHandlers.set(agentId, [])
    }
    this.eventHandlers.get(agentId)!.push(handler)
  }

  removeAgentHandlers(agentId: string): void {
    this.eventHandlers.delete(agentId)
  }

  onEvent(handler: HookEventHandler): void {
    this.globalHandlers.push(handler)
  }

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

  isRunning(): boolean {
    return this.server !== null
  }

  getPort(): number {
    return this.port
  }

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
