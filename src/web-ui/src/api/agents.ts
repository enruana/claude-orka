/**
 * Agents API Client
 */

import { API_BASE, apiFetch } from './config'

/**
 * Agent status
 */
export type AgentStatus = 'idle' | 'active' | 'paused' | 'waiting_human' | 'error'

/**
 * Agent hook trigger types
 */
export type AgentHookTrigger =
  | 'Stop'
  | 'Notification'
  | 'SubagentStop'
  | 'PreCompact'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreToolUse'
  | 'PostToolUse'

/**
 * Notification configuration
 */
export interface NotificationConfig {
  telegram?: {
    enabled: boolean
    botToken?: string
    chatId?: string
  }
  webPush?: {
    enabled: boolean
    endpoint?: string
    p256dh?: string
    auth?: string
  }
}

/**
 * Agent connection to a project
 */
export interface AgentConnection {
  projectPath: string
  sessionId?: string
  tmuxPaneId?: string
  connectedAt: string
}

/**
 * Agent interface
 */
export interface Agent {
  id: string
  name: string
  status: AgentStatus
  masterPrompt: string
  connection?: AgentConnection
  claudeSessionId?: string
  tmuxSessionId?: string
  tmuxPaneId?: string
  hookEvents: AgentHookTrigger[]
  notifications: NotificationConfig
  autoApprove: boolean
  maxConsecutiveResponses: number
  consecutiveResponses: number
  decisionHistorySize: number
  createdAt: string
  lastActivity?: string
  lastError?: string
}

/**
 * Create agent options
 */
export interface CreateAgentOptions {
  name: string
  masterPrompt: string
  hookEvents?: AgentHookTrigger[]
  notifications?: NotificationConfig
  autoApprove?: boolean
  maxConsecutiveResponses?: number
  decisionHistorySize?: number
}

/**
 * Agents API
 */
export const agentsApi = {
  /**
   * List all agents
   */
  async list(): Promise<Agent[]> {
    const res = await fetch(`${API_BASE}/agents`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /**
   * Get a specific agent
   */
  async get(agentId: string): Promise<Agent> {
    const res = await fetch(`${API_BASE}/agents/${agentId}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /**
   * Create a new agent
   */
  async create(options: CreateAgentOptions): Promise<Agent> {
    const res = await fetch(`${API_BASE}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /**
   * Update an agent
   */
  async update(agentId: string, updates: Partial<Agent>): Promise<Agent> {
    const res = await fetch(`${API_BASE}/agents/${agentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /**
   * Delete an agent
   */
  async delete(agentId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/agents/${agentId}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(await res.text())
  },

  /**
   * Start an agent
   */
  async start(agentId: string): Promise<Agent> {
    return apiFetch<Agent>(`/agents/${agentId}/start`, { method: 'POST' })
  },

  /**
   * Stop an agent
   */
  async stop(agentId: string): Promise<Agent> {
    return apiFetch<Agent>(`/agents/${agentId}/stop`, { method: 'POST' })
  },

  /**
   * Pause an agent
   */
  async pause(agentId: string): Promise<Agent> {
    return apiFetch<Agent>(`/agents/${agentId}/pause`, { method: 'POST' })
  },

  /**
   * Resume an agent
   */
  async resume(agentId: string): Promise<Agent> {
    return apiFetch<Agent>(`/agents/${agentId}/resume`, { method: 'POST' })
  },

  /**
   * Connect an agent to a project
   */
  async connect(
    agentId: string,
    projectPath: string,
    sessionId?: string,
    tmuxPaneId?: string
  ): Promise<Agent> {
    return apiFetch<Agent>(`/agents/${agentId}/connect`, {
      method: 'POST',
      body: JSON.stringify({ projectPath, sessionId, tmuxPaneId }),
    })
  },

  /**
   * Disconnect an agent
   */
  async disconnect(agentId: string): Promise<Agent> {
    return apiFetch<Agent>(`/agents/${agentId}/disconnect`, { method: 'POST' })
  },

  /**
   * Manually trigger an agent to analyze and act
   */
  async trigger(agentId: string): Promise<Agent> {
    return apiFetch<Agent>(`/agents/${agentId}/trigger`, { method: 'POST' })
  },

  /**
   * Get agents by project
   */
  async getByProject(projectPath: string): Promise<Agent[]> {
    const encoded = btoa(projectPath)
    const res = await fetch(`${API_BASE}/agents/by-project/${encoded}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /**
   * Get running agents
   */
  async getRunning(): Promise<Agent[]> {
    const res = await fetch(`${API_BASE}/agents/status/running`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },
}
