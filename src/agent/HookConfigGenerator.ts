/**
 * HookConfigGenerator - Generates Claude Code hook configurations for projects
 */

import fs from 'fs-extra'
import path from 'path'
import { logger } from '../utils'
import { AgentHookTrigger } from '../models/Agent'

/**
 * Hook entry structure
 */
interface HookEntry {
  matcher?: string
  hooks: Array<{
    type: 'command'
    command: string
  }>
}

/**
 * Claude Code hook configuration structure
 */
interface ClaudeHookConfig {
  hooks?: {
    Stop?: HookEntry[]
    Notification?: HookEntry[]
    SubagentStop?: HookEntry[]
    PreCompact?: HookEntry[]
    SessionStart?: HookEntry[]
    SessionEnd?: HookEntry[]
    PreToolUse?: HookEntry[]
    PostToolUse?: HookEntry[]
  }
}

/**
 * Full Claude settings.json structure (partial, we only care about hooks)
 */
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

  /**
   * Generate hook command for an agent
   */
  private generateHookCommand(agentId: string): string {
    // Use curl to POST the stdin (hook payload) to our hook server
    // The $(cat) captures stdin from Claude Code's hook system
    return `curl -s -X POST http://${this.hookServerHost}:${this.hookServerPort}/api/hooks/${agentId} -H 'Content-Type: application/json' -d "$(cat)"`
  }

  /**
   * Generate hook configuration for an agent
   */
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

  /**
   * Get the path to a project's Claude settings.json
   */
  getSettingsPath(projectPath: string): string {
    return path.join(projectPath, '.claude', 'settings.json')
  }

  /**
   * Read existing Claude settings for a project
   */
  async readSettings(projectPath: string): Promise<ClaudeSettings> {
    const settingsPath = this.getSettingsPath(projectPath)

    if (await fs.pathExists(settingsPath)) {
      try {
        return await fs.readJson(settingsPath)
      } catch (error) {
        logger.warn(`Failed to parse Claude settings at ${settingsPath}, starting fresh`)
        return {}
      }
    }

    return {}
  }

  /**
   * Write Claude settings for a project
   */
  async writeSettings(projectPath: string, settings: ClaudeSettings): Promise<void> {
    const settingsPath = this.getSettingsPath(projectPath)
    const settingsDir = path.dirname(settingsPath)

    await fs.ensureDir(settingsDir)
    await fs.writeJson(settingsPath, settings, { spaces: 2 })

    logger.info(`Wrote Claude settings to ${settingsPath}`)
  }

  /**
   * Install hooks for an agent in a project
   */
  async installHooks(
    projectPath: string,
    agentId: string,
    hookEvents: AgentHookTrigger[]
  ): Promise<void> {
    // Always include SessionStart for session tracking after compact/clear.
    // Without it, the agent can't detect session_id changes and gets stuck.
    const effectiveEvents = [...new Set([...hookEvents, 'SessionStart' as AgentHookTrigger])] as AgentHookTrigger[]

    const settings = await this.readSettings(projectPath)
    const hookConfig = this.generateHookConfig(agentId, effectiveEvents)

    // Merge hooks into existing settings
    if (!settings.hooks) {
      settings.hooks = {}
    }

    // Add our hooks to each event type
    for (const event of effectiveEvents) {
      if (!settings.hooks[event]) {
        settings.hooks[event] = []
      }

      // Remove any existing hooks for this agent (by checking command)
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

  /**
   * Uninstall hooks for an agent from a project
   */
  async uninstallHooks(projectPath: string, agentId: string): Promise<void> {
    const settings = await this.readSettings(projectPath)

    if (!settings.hooks) {
      return
    }

    const agentHookPattern = `/api/hooks/${agentId}`

    // Remove hooks for this agent from all event types
    for (const eventType of Object.keys(settings.hooks) as AgentHookTrigger[]) {
      if (settings.hooks[eventType]) {
        settings.hooks[eventType] = settings.hooks[eventType]!.filter(
          hookGroup => !hookGroup.hooks.some(h => h.command.includes(agentHookPattern))
        )

        // Remove empty arrays
        if (settings.hooks[eventType]!.length === 0) {
          delete settings.hooks[eventType]
        }
      }
    }

    // Remove hooks object if empty
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks
    }

    await this.writeSettings(projectPath, settings)
    logger.info(`Uninstalled hooks for agent ${agentId} from ${projectPath}`)
  }

  /**
   * Check if hooks are installed for an agent in a project
   */
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
