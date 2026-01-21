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

// File tree types
export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
}

// Git types
export interface GitFileChange {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
  oldPath?: string
}

export interface GitStatus {
  branch: string
  changes: GitFileChange[]
  stagedCount: number
  unstagedCount: number
  isClean: boolean
}

export interface GitDiff {
  diff: string
  original: string
  modified: string
  path: string
  staged: boolean
}

export interface GitCommitLog {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  relativeDate: string
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

  async checkProjectVersion(path: string): Promise<{
    isOutdated: boolean
    currentVersion: string
    projectVersion: string
  }> {
    const res = await fetch(`${API_BASE}/projects/${encodeProjectPath(path)}/version`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async reinitializeProject(path: string): Promise<{
    success: boolean
    version: string
    message: string
  }> {
    const res = await fetch(`${API_BASE}/projects/${encodeProjectPath(path)}/reinitialize`, {
      method: 'POST',
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
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

  async detachSession(projectPath: string, sessionId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/detach?project=${encodeProjectPath(projectPath)}`, {
      method: 'POST',
    })
    if (!res.ok) throw new Error(await res.text())
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

  // File operations
  async getFileTree(projectEncoded: string): Promise<FileTreeNode[]> {
    const res = await fetch(`${API_BASE}/files/tree?project=${projectEncoded}`)
    if (!res.ok) throw new Error(await res.text())
    const data = await res.json()
    return data.tree
  },

  async expandFileTree(projectEncoded: string, dirPath: string): Promise<FileTreeNode[]> {
    const res = await fetch(`${API_BASE}/files/tree-expand?project=${projectEncoded}&path=${encodeURIComponent(dirPath)}`)
    if (!res.ok) throw new Error(await res.text())
    const data = await res.json()
    return data.children
  },

  async getFileContent(projectEncoded: string, filePath: string): Promise<{ content: string; path: string; size: number }> {
    const res = await fetch(`${API_BASE}/files/content?project=${projectEncoded}&path=${encodeURIComponent(filePath)}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async saveFileContent(projectEncoded: string, filePath: string, content: string): Promise<void> {
    const res = await fetch(`${API_BASE}/files/content?project=${projectEncoded}&path=${encodeURIComponent(filePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (!res.ok) throw new Error(await res.text())
  },

  // Git operations
  async getGitStatus(projectEncoded: string): Promise<GitStatus> {
    const res = await fetch(`${API_BASE}/git/status?project=${projectEncoded}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async getGitDiff(projectEncoded: string, filePath: string, staged: boolean): Promise<GitDiff> {
    const res = await fetch(`${API_BASE}/git/diff?project=${projectEncoded}&path=${encodeURIComponent(filePath)}&staged=${staged}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async gitStage(projectEncoded: string, paths: string[]): Promise<void> {
    const res = await fetch(`${API_BASE}/git/stage?project=${projectEncoded}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    if (!res.ok) throw new Error(await res.text())
  },

  async gitUnstage(projectEncoded: string, paths: string[]): Promise<void> {
    const res = await fetch(`${API_BASE}/git/unstage?project=${projectEncoded}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    if (!res.ok) throw new Error(await res.text())
  },

  async gitCommit(projectEncoded: string, message: string): Promise<{ hash: string }> {
    const res = await fetch(`${API_BASE}/git/commit?project=${projectEncoded}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async getGitLog(projectEncoded: string, limit: number = 50): Promise<GitCommitLog[]> {
    const res = await fetch(`${API_BASE}/git/log?project=${projectEncoded}&limit=${limit}`)
    if (!res.ok) throw new Error(await res.text())
    const data = await res.json()
    return data.commits
  },
}
