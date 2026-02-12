/**
 * HookConfigGenerator - Generates Claude Code hook configurations for projects
 *
 * Phase 1: Core hook generation and installation (no auto-approve PreToolUse)
 */

import fs from 'fs-extra'
import path from 'path'
import { logger } from '../utils'
import { AgentHookTrigger } from '../models/Agent'

interface HookEntry {
  matcher?: string
  hooks: Array<{
    type: 'command'
    command: string
  }>
}

interface ClaudeHookConfig {
  hooks?: Partial<Record<AgentHookTrigger, HookEntry[]>>
}

interface ClaudeSettings {
  hooks?: ClaudeHookConfig['hooks']
  [key: string]: unknown
}

export class HookConfigGenerator {
  private hookServerPort: number
  private hookServerHost: string

  constructor(hookServerPort: number = 9999, hookServerHost: string = 'localhost') {
    this.hookServerPort = hookServerPort
    this.hookServerHost = hookServerHost
  }

  private generateHookCommand(agentId: string): string {
    return `curl -s -X POST http://${this.hookServerHost}:${this.hookServerPort}/api/hooks/${agentId} -H 'Content-Type: application/json' --data-binary @-`
  }

  generateHookConfig(agentId: string, hookEvents: AgentHookTrigger[]): ClaudeHookConfig {
    const config: ClaudeHookConfig = {
      hooks: {},
    }

    for (const event of hookEvents) {
      if (!config.hooks![event]) {
        config.hooks![event] = []
      }

      config.hooks![event]!.push({
        hooks: [
          {
            type: 'command',
            command: this.generateHookCommand(agentId),
          },
        ],
      })
    }

    return config
  }

  getSettingsPath(projectPath: string): string {
    return path.join(projectPath, '.claude', 'settings.json')
  }

  async readSettings(projectPath: string): Promise<ClaudeSettings> {
    const settingsPath = this.getSettingsPath(projectPath)

    if (await fs.pathExists(settingsPath)) {
      try {
        return await fs.readJson(settingsPath)
      } catch {
        logger.warn(`Failed to parse Claude settings at ${settingsPath}, starting fresh`)
        return {}
      }
    }

    return {}
  }

  async writeSettings(projectPath: string, settings: ClaudeSettings): Promise<void> {
    const settingsPath = this.getSettingsPath(projectPath)
    const settingsDir = path.dirname(settingsPath)

    await fs.ensureDir(settingsDir)
    await fs.writeJson(settingsPath, settings, { spaces: 2 })

    logger.info(`Wrote Claude settings to ${settingsPath}`)
  }

  async installHooks(
    projectPath: string,
    agentId: string,
    hookEvents: AgentHookTrigger[]
  ): Promise<void> {
    // Always include SessionStart for session tracking after compact/clear
    const effectiveEvents = [...new Set([...hookEvents, 'SessionStart' as AgentHookTrigger])] as AgentHookTrigger[]

    const settings = await this.readSettings(projectPath)
    const hookConfig = this.generateHookConfig(agentId, effectiveEvents)

    if (!settings.hooks) {
      settings.hooks = {}
    }

    // Add our hooks to each event type
    for (const event of effectiveEvents) {
      if (!settings.hooks[event]) {
        settings.hooks[event] = []
      }

      // Remove any existing hooks for this agent
      const agentHookPattern = `/api/hooks/${agentId}`
      settings.hooks[event] = settings.hooks[event]!.filter(
        hookGroup => !hookGroup.hooks.some(h => h.command.includes(agentHookPattern))
      )

      // Add new hooks
      const newHooks = hookConfig.hooks![event]
      if (newHooks) {
        settings.hooks[event]!.push(...newHooks)
      }
    }

    await this.writeSettings(projectPath, settings)
    logger.info(`Installed hooks for agent ${agentId} in ${projectPath}`)
  }

  async uninstallHooks(projectPath: string, agentId: string): Promise<void> {
    const settings = await this.readSettings(projectPath)

    if (!settings.hooks) {
      return
    }

    const agentHookPattern = `/api/hooks/${agentId}`

    for (const eventType of Object.keys(settings.hooks) as AgentHookTrigger[]) {
      if (settings.hooks[eventType]) {
        settings.hooks[eventType] = settings.hooks[eventType]!.filter(
          hookGroup => !hookGroup.hooks.some(h => h.command.includes(agentHookPattern))
        )

        if (settings.hooks[eventType]!.length === 0) {
          delete settings.hooks[eventType]
        }
      }
    }

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks
    }

    await this.writeSettings(projectPath, settings)
    logger.info(`Uninstalled hooks for agent ${agentId} from ${projectPath}`)
  }

  async hasHooksInstalled(projectPath: string, agentId: string): Promise<boolean> {
    const settings = await this.readSettings(projectPath)

    if (!settings.hooks) {
      return false
    }

    const agentHookPattern = `/api/hooks/${agentId}`

    for (const eventType of Object.keys(settings.hooks) as AgentHookTrigger[]) {
      const hooks = settings.hooks[eventType]
      if (hooks?.some(hookGroup => hookGroup.hooks.some(h => h.command.includes(agentHookPattern)))) {
        return true
      }
    }

    return false
  }
}
