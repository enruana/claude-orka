/**
 * API Client for Claude Orka Web UI
 */

export interface RegisteredProject {
  path: string
  name: string
  addedAt: string
  lastOpened?: string
  initialized?: boolean
  sessionCount?: number
  activeSessions?: number
}

export interface Session {
  id: string
  name: string
  status: 'active' | 'saved'
  projectPath: string
  createdAt: string
  lastActivity?: string
  tmuxSessionId?: string
  ttydPort?: number
  ttydPid?: number
  main: {
    claudeSessionId?: string
    tmuxPaneId?: string
  }
  forks: Fork[]
  nodePositions?: Record<string, { x: number; y: number }>
}

export interface Fork {
  id: string
  name: string
  parentId: string
  claudeSessionId?: string
  tmuxPaneId?: string
  status: 'active' | 'saved' | 'closed' | 'merged'
  contextPath?: string
  createdAt: string
  closedAt?: string
}

const API_BASE = '/api'

function encodeProjectPath(path: string): string {
  return btoa(path)
}

export const api = {
  // Projects
  async listProjects(): Promise<RegisteredProject[]> {
    const res = await fetch(`${API_BASE}/projects`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async registerProject(path: string, name?: string): Promise<RegisteredProject> {
    const res = await fetch(`${API_BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, name }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async getProject(path: string): Promise<RegisteredProject & { sessions: Session[] }> {
    const res = await fetch(`${API_BASE}/projects/${encodeProjectPath(path)}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async unregisterProject(path: string): Promise<void> {
    const res = await fetch(`${API_BASE}/projects/${encodeProjectPath(path)}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(await res.text())
  },

  // Sessions
  async listSessions(projectPath: string): Promise<Session[]> {
    const res = await fetch(`${API_BASE}/sessions?project=${encodeProjectPath(projectPath)}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async createSession(projectPath: string, name?: string, continueFromClaudeSession?: string): Promise<Session> {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: encodeProjectPath(projectPath), name, continueFromClaudeSession }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async getSession(projectPath: string, sessionId: string): Promise<Session> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}?project=${encodeProjectPath(projectPath)}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async resumeSession(projectPath: string, sessionId: string): Promise<Session> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/resume?project=${encodeProjectPath(projectPath)}`, {
      method: 'POST',
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async closeSession(projectPath: string, sessionId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/close?project=${encodeProjectPath(projectPath)}`, {
      method: 'POST',
    })
    if (!res.ok) throw new Error(await res.text())
  },

  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}?project=${encodeProjectPath(projectPath)}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(await res.text())
  },

  // Forks
  async createFork(projectPath: string, sessionId: string, name?: string, parentId?: string): Promise<Fork> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/forks?project=${encodeProjectPath(projectPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parentId }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async closeFork(projectPath: string, sessionId: string, forkId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/forks/${forkId}/close?project=${encodeProjectPath(projectPath)}`, {
      method: 'POST',
    })
    if (!res.ok) throw new Error(await res.text())
  },

  async exportFork(projectPath: string, sessionId: string, forkId: string): Promise<string> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/forks/${forkId}/export?project=${encodeProjectPath(projectPath)}`, {
      method: 'POST',
    })
    if (!res.ok) throw new Error(await res.text())
    const data = await res.json()
    return data.exportPath
  },

  async mergeFork(projectPath: string, sessionId: string, forkId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/forks/${forkId}/merge?project=${encodeProjectPath(projectPath)}`, {
      method: 'POST',
    })
    if (!res.ok) throw new Error(await res.text())
  },

  // Branch selection
  async selectBranch(projectPath: string, sessionId: string, branchId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/select-branch?project=${encodeProjectPath(projectPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branchId }),
    })
    if (!res.ok) throw new Error(await res.text())
  },

  async getActiveBranch(projectPath: string, sessionId: string): Promise<string | null> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/active-branch?project=${encodeProjectPath(projectPath)}`)
    if (!res.ok) throw new Error(await res.text())
    const data = await res.json()
    return data.activeBranch
  },
}
