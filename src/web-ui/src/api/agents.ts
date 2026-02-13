/**
 * Agents API Client
 *
 * Phase 1: Minimal agent type and CRUD methods
 */

import { API_BASE, apiFetch } from './config'

export type AgentStatus = 'idle' | 'active' | 'error'

export type AgentHookTrigger =
  | 'Stop'
  | 'Notification'
  | 'SubagentStop'
  | 'PreCompact'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreToolUse'
  | 'PostToolUse'

export interface AgentConnection {
  projectPath: string
  sessionId?: string
  tmuxPaneId?: string
  claudeSessionId?: string
  branchId?: string
  connectedAt: string
}

export interface TelegramConfig {
  botToken: string
  chatId: number
  enabled: boolean
}

export interface WatchdogConfig {
  enabled: boolean
  pollIntervalSec: number
  actionCooldownSec: number
  attentionThreshold: number
}

export interface Agent {
  id: string
  name: string
  status: AgentStatus
  masterPrompt: string
  connection?: AgentConnection
  hookEvents: AgentHookTrigger[]
  autoApprove: boolean
  telegram?: TelegramConfig
  watchdog?: WatchdogConfig
  createdAt: string
  lastActivity?: string
  lastError?: string
}

export interface AgentLogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug' | 'action'
  message: string
  details?: Record<string, unknown>
}

export interface CreateAgentOptions {
  name: string
  masterPrompt: string
  hookEvents?: AgentHookTrigger[]
  autoApprove?: boolean
  telegram?: TelegramConfig
  watchdog?: WatchdogConfig
}

export const agentsApi = {
  async list(): Promise<Agent[]> {
    const res = await fetch(`${API_BASE}/agents`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async get(agentId: string): Promise<Agent> {
    const res = await fetch(`${API_BASE}/agents/${agentId}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async create(options: CreateAgentOptions): Promise<Agent> {
    const res = await fetch(`${API_BASE}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async update(agentId: string, updates: Partial<Agent>): Promise<Agent> {
    const res = await fetch(`${API_BASE}/agents/${agentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async delete(agentId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/agents/${agentId}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(await res.text())
  },

  async start(agentId: string): Promise<Agent> {
    return apiFetch<Agent>(`/agents/${agentId}/start`, { method: 'POST' })
  },

  async stop(agentId: string): Promise<Agent> {
    return apiFetch<Agent>(`/agents/${agentId}/stop`, { method: 'POST' })
  },

  async connect(
    agentId: string,
    projectPath: string,
    sessionId?: string,
    tmuxPaneId?: string,
    branchId?: string
  ): Promise<Agent> {
    return apiFetch<Agent>(`/agents/${agentId}/connect`, {
      method: 'POST',
      body: JSON.stringify({ projectPath, sessionId, tmuxPaneId, branchId }),
    })
  },

  async disconnect(agentId: string): Promise<Agent> {
    return apiFetch<Agent>(`/agents/${agentId}/disconnect`, { method: 'POST' })
  },
}
