/**
 * API Client for Claude Orka Web UI
 */

export interface RegisteredProject {
  path: string
  name: string
  addedAt: string
  lastOpened?: string
  group?: string
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

// Finder directory listing types
export interface FileListItem {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  modifiedAt: string
  extension: string
  childCount?: number
}

export interface DirectoryListing {
  items: FileListItem[]
  currentPath: string
  parentPath: string | null
}

// Task types
export interface ProjectTask {
  id: string
  title: string
  completed: boolean
  createdAt: string
  completedAt?: string
}

// Comment types
export interface ProjectComment {
  id: string
  filePath: string
  startLine: number
  endLine: number
  selectedText: string
  body: string
  resolved: boolean
  createdAt: string
  resolvedAt?: string
}

// Search types
export interface SearchMatch {
  line: number
  text: string
}

export interface SearchFileResult {
  path: string
  matches: SearchMatch[]
}

export interface SearchResponse {
  results: SearchFileResult[]
  totalMatches: number
  truncated: boolean
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

// AI Query types
export interface AIQueryContext {
  type: 'terminal' | 'code' | 'none'
  projectPath?: string
  terminalPaneId?: string
  fileContent?: string
  filePath?: string
  selection?: string
}

export interface AIQueryResponse {
  answer: string
}

// Use origin-based URL for VPN/remote access compatibility
const API_BASE = `${window.location.origin}/api`

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

  async updateProject(path: string, updates: { name?: string; group?: string | null }): Promise<RegisteredProject> {
    const res = await fetch(`${API_BASE}/projects/${encodeProjectPath(path)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
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

  // System Terminal
  async getSystemTerminal(): Promise<{ port: number }> {
    const res = await fetch(`${API_BASE}/projects/system-terminal`, { method: 'POST' })
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

  async captureTerminalPane(projectPath: string, sessionId: string, opts: { branch?: string; lines?: number; ansi?: boolean } = {}): Promise<{ text: string; paneId: string; branch: string; ansi: boolean }> {
    const params = new URLSearchParams({ project: encodeProjectPath(projectPath) })
    if (opts.branch) params.set('branch', opts.branch)
    if (opts.lines) params.set('lines', String(opts.lines))
    if (opts.ansi) params.set('ansi', '1')
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/capture?${params.toString()}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async getActiveBranch(projectPath: string, sessionId: string): Promise<string | null> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/active-branch?project=${encodeProjectPath(projectPath)}`)
    if (!res.ok) throw new Error(await res.text())
    const data = await res.json()
    return data.activeBranch
  },

  // File operations
  async listDirectory(projectEncoded: string, dirPath: string = ''): Promise<DirectoryListing> {
    const params = new URLSearchParams({ project: projectEncoded })
    if (dirPath) params.set('path', dirPath)
    const res = await fetch(`${API_BASE}/files/list?${params}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

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

  async createFile(projectEncoded: string, filePath: string, type: 'file' | 'directory'): Promise<void> {
    const res = await fetch(`${API_BASE}/files/create?project=${projectEncoded}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, type }),
    })
    if (!res.ok) throw new Error(await res.text())
  },

  async deleteFile(projectEncoded: string, filePath: string): Promise<void> {
    const res = await fetch(`${API_BASE}/files?project=${projectEncoded}&path=${encodeURIComponent(filePath)}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(await res.text())
  },

  async moveFile(projectEncoded: string, from: string, to: string): Promise<void> {
    const res = await fetch(`${API_BASE}/files/move?project=${projectEncoded}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Move failed' }))
      throw new Error(data.error || 'Move failed')
    }
  },

  async uploadFiles(projectEncoded: string, files: File[], destination: string = ''): Promise<{ success: boolean; uploaded: { name: string; path: string }[] }> {
    const formData = new FormData()
    for (const file of files) {
      formData.append('files', file)
    }
    formData.append('destination', destination)
    const res = await fetch(`${API_BASE}/files/upload?project=${projectEncoded}`, {
      method: 'POST',
      body: formData,
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Upload failed' }))
      throw new Error(data.error || 'Upload failed')
    }
    return res.json()
  },

  async searchFiles(projectEncoded: string, query: string, options?: { caseSensitive?: boolean; regex?: boolean }): Promise<SearchResponse> {
    const params = new URLSearchParams({
      project: projectEncoded,
      query,
      caseSensitive: String(options?.caseSensitive ?? false),
      regex: String(options?.regex ?? false),
    })
    const res = await fetch(`${API_BASE}/files/search?${params}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
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

  async generateCommitMessage(projectEncoded: string): Promise<string> {
    const res = await fetch(`${API_BASE}/git/generate-commit-message?project=${projectEncoded}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      const error = await res.json()
      throw new Error(error.error || 'Failed to generate commit message')
    }
    const data = await res.json()
    return data.message
  },

  // Tasks (uses ?project= query param, same as sessions/files/git)
  async listTasks(projectPath: string): Promise<ProjectTask[]> {
    const res = await fetch(`${API_BASE}/projects/tasks?project=${encodeProjectPath(projectPath)}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async createTask(projectPath: string, title: string): Promise<ProjectTask> {
    const res = await fetch(`${API_BASE}/projects/tasks?project=${encodeProjectPath(projectPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async updateTask(projectPath: string, taskId: string, updates: { title?: string; completed?: boolean }): Promise<ProjectTask> {
    const res = await fetch(`${API_BASE}/projects/tasks/${taskId}?project=${encodeProjectPath(projectPath)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async deleteTask(projectPath: string, taskId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/projects/tasks/${taskId}?project=${encodeProjectPath(projectPath)}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(await res.text())
  },

  // Comments
  async listComments(projectPath: string): Promise<ProjectComment[]> {
    const res = await fetch(`${API_BASE}/projects/comments?project=${encodeProjectPath(projectPath)}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async createComment(projectPath: string, data: { filePath: string; startLine: number; endLine: number; selectedText: string; body: string }): Promise<ProjectComment> {
    const res = await fetch(`${API_BASE}/projects/comments?project=${encodeProjectPath(projectPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async updateComment(projectPath: string, commentId: string, updates: { body?: string; resolved?: boolean }): Promise<ProjectComment> {
    const res = await fetch(`${API_BASE}/projects/comments/${commentId}?project=${encodeProjectPath(projectPath)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async deleteComment(projectPath: string, commentId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/projects/comments/${commentId}?project=${encodeProjectPath(projectPath)}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(await res.text())
  },

  // AI Query
  async aiQuery(question: string, context?: AIQueryContext): Promise<AIQueryResponse> {
    const res = await fetch(`${API_BASE}/ai/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, context }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'AI query failed' }))
      throw new Error(data.error || 'AI query failed')
    }
    return res.json()
  },
}
