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

/** tmux pane arrangement — mirrors `tmux select-layout` names. */
export type SessionLayout = 'tiled' | 'even-horizontal' | 'even-vertical' | 'main-vertical'

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

  /** tmux pane arrangement — one of tiled / even-horizontal /
   *  even-vertical / main-vertical. */
  layout?: SessionLayout

  /** True when Claude is blocked on user input (permission/decision prompt).
   *  Updated by the session-watcher hook receiver and cleared on resume or
   *  manual ack from the UI. */
  waitingForInput?: boolean
  waitingSince?: string
  waitingMessage?: string
  waitingBranch?: string
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

// Pin types — KB entity shortcuts surfaced in the floating action button.
// Denormalized so the FAB can render without touching the KB every time.
export interface ProjectPin {
  entityId: string
  title: string
  type: string
  folderPath: string
  pinnedAt: string
}

// Knowledge Base types
export interface KBEdge {
  relation: string
  target: string
  since: string
  eventRef?: string
}

export interface KBEntityHistoryEntry {
  ts: string
  event: string
  summary: string
}

export interface KBEntity {
  id: string
  type: string
  title: string
  status: string
  created: string
  updated: string
  properties: Record<string, unknown>
  edges: KBEdge[]
  tags: string[]
  history: KBEntityHistoryEntry[]
}

export interface KBEvent {
  id: string
  ts: string
  type: string
  entityId?: string
  actor: string
  data: Record<string, unknown>
  refs?: string[]
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

// Detailed views returned by GET /api/system/details?category=...
export interface SystemProcessInfo {
  pid: number
  user: string
  cpuPercent: number
  memPercent: number
  rssBytes: number
  comm: string
  args: string
}

export interface SystemCpuDetails {
  cores: number
  model: string
  loadAvg: [number, number, number]
  perCore: Array<{ core: number; usagePercent: number; speedMHz: number }>
  processes: SystemProcessInfo[]
}

export interface SystemMemoryDetails {
  detail: {
    totalBytes: number
    freeBytes: number
    availableBytes: number
    usedBytes: number
    buffersBytes: number
    cachedBytes: number
    swapTotalBytes: number
    swapFreeBytes: number
    swapUsedBytes: number
  }
  processes: SystemProcessInfo[]
}

export interface SystemDiskDetails {
  disks: Array<{
    mount: string
    filesystem: string
    totalBytes: number
    usedBytes: number
    freeBytes: number
    usedPercent: number
  }>
}

// System metrics returned by GET /api/system/metrics — mirror of the
// backend `SystemMetrics` interface in src/server/api/system.ts. Kept
// in sync manually; both files are small.
export interface SystemMetrics {
  hostname: string
  platform: string
  arch: string
  uptimeSeconds: number
  cpu: {
    usagePercent: number
    cores: number
    model: string
    loadAvg: [number, number, number]
  }
  memory: {
    totalBytes: number
    freeBytes: number
    usedBytes: number
    usedPercent: number
  }
  disks: Array<{
    mount: string
    filesystem: string
    totalBytes: number
    usedBytes: number
    freeBytes: number
    usedPercent: number
  }>
  sampledAt: string
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

  async captureSystemTerminal(opts: { lines?: number; ansi?: boolean } = {}): Promise<{ text: string; target: string; ansi: boolean }> {
    const params = new URLSearchParams()
    if (opts.lines) params.set('lines', String(opts.lines))
    if (opts.ansi) params.set('ansi', '1')
    const qs = params.toString()
    const url = `${API_BASE}/projects/system-terminal/capture${qs ? `?${qs}` : ''}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  // Live host metrics for the launcher widget
  async getSystemMetrics(): Promise<SystemMetrics> {
    const res = await fetch(`${API_BASE}/system/metrics`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /**
   * Details for a single system-widget category. Consumers narrow the
   * return type by category — TypeScript overloads didn't survive
   * esbuild's transformer, so the union is manually asserted at the
   * call sites (in `SystemDetailsModal`).
   */
  async getSystemDetails(
    category: 'cpu' | 'memory' | 'disk'
  ): Promise<SystemCpuDetails | SystemMemoryDetails | SystemDiskDetails> {
    const res = await fetch(`${API_BASE}/system/details?category=${category}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /**
   * Send a signal (SIGTERM by default, SIGKILL if `force`) to a process
   * on the host. Returns the sent signal on success, throws with the
   * server's error message on failure so the modal can toast it.
   */
  async killProcess(pid: number, force: boolean = false): Promise<{ pid: number; signal: string }> {
    const signal = force ? 'KILL' : 'TERM'
    const res = await fetch(`${API_BASE}/system/processes/${pid}/kill?signal=${signal}`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
    return data
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

  /** Save a lossless snapshot of ONE session so it can be resumed later
   *  without state drift. Non-destructive: live processes keep running. */
  async saveSession(
    projectPath: string,
    sessionId: string
  ): Promise<{
    sessionId: string
    name: string
    branchesSaved: number
    summariesRefreshed: number
    untrackedPanes: number
  }> {
    const res = await fetch(
      `${API_BASE}/sessions/${sessionId}/save?project=${encodeProjectPath(projectPath)}`,
      { method: 'POST' }
    )
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /** Save every session of one project. Failures on individual sessions
   *  are reported in the response's `errors` array; the run keeps going. */
  async saveAllSessions(
    projectPath: string
  ): Promise<{
    total: number
    saved: number
    failed: number
    results: Array<{
      sessionId: string
      name: string
      branchesSaved: number
      summariesRefreshed: number
      untrackedPanes: number
    }>
    errors: Array<{ sessionId: string; name: string; error: string }>
  }> {
    const res = await fetch(
      `${API_BASE}/sessions/save-all?project=${encodeProjectPath(projectPath)}`,
      { method: 'POST' }
    )
    if (!res.ok) throw new Error(await res.text())
    return res.json()
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

  /** Change the session's tmux pane arrangement (grid / columns / rows /
   *  main). Persisted server-side and re-applied on every resume. */
  async setSessionLayout(
    projectPath: string,
    sessionId: string,
    layout: SessionLayout
  ): Promise<{ ok: boolean; layout: SessionLayout }> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: encodeProjectPath(projectPath), layout }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /** Rename a tmux pane's label (shown in the pane border). When `paneId`
   *  is omitted, the session's currently-active pane is relabeled. */
  async renamePaneLabel(
    projectPath: string,
    sessionId: string,
    label: string,
    paneId?: string
  ): Promise<{ ok: boolean; paneId: string; label: string }> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/pane-label`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: encodeProjectPath(projectPath), label, paneId }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /** Toggle zoom on a tmux pane (server-side `prefix + z`). When `paneId`
   *  is omitted, the session's active pane is targeted. Response carries
   *  the new state so the caller can flip its UI icon. */
  async togglePaneZoom(
    projectPath: string,
    sessionId: string,
    paneId?: string
  ): Promise<{ ok: boolean; paneId: string; zoomed: boolean }> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/pane-zoom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: encodeProjectPath(projectPath), paneId }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /** Clear the `waitingForInput` flag for a session. Called when the user
   *  opens the session in the UI, complementing the automatic clear via
   *  UserPromptSubmit / PreToolUse hooks. Fire-and-forget; errors are
   *  swallowed because the flag will also clear on the next Claude event. */
  async acknowledgeWaiting(projectPath: string, sessionId: string): Promise<void> {
    try {
      await fetch(
        `${API_BASE}/sessions/${sessionId}/acknowledge-waiting?project=${encodeProjectPath(projectPath)}`,
        { method: 'POST' }
      )
    } catch {
      /* non-critical */
    }
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

  // ------------------------------------------------------------------
  // Pins — KB entity shortcuts surfaced in the floating action button
  // ------------------------------------------------------------------

  async listPins(projectPath: string): Promise<ProjectPin[]> {
    const res = await fetch(`${API_BASE}/projects/pins?project=${encodeProjectPath(projectPath)}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /** Pin (or re-pin) a KB entity. `folderPath` should be a
   *  project-relative folder path (no leading `/`). */
  async addPin(
    projectPath: string,
    payload: { entityId: string; title: string; type: string; folderPath: string }
  ): Promise<ProjectPin> {
    const res = await fetch(`${API_BASE}/projects/pins?project=${encodeProjectPath(projectPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async deletePin(projectPath: string, entityId: string): Promise<void> {
    const res = await fetch(
      `${API_BASE}/projects/pins/${encodeURIComponent(entityId)}?project=${encodeProjectPath(projectPath)}`,
      { method: 'DELETE' }
    )
    if (!res.ok) throw new Error(await res.text())
  },

  // Terminal interaction
  async sendTextToSession(projectPath: string, sessionId: string, text: string, branch?: string): Promise<{ success: boolean }> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/send-text?project=${encodeProjectPath(projectPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, branch }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  // Knowledge Base
  async getKBStatus(projectPath: string): Promise<{ initialized: boolean; stats?: { entities: number; edges: number; events: number; byType: Record<string, number> } }> {
    const res = await fetch(`${API_BASE}/kb/status?project=${encodeProjectPath(projectPath)}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async getKBEntities(projectPath: string, filter?: { type?: string; status?: string }): Promise<KBEntity[]> {
    const params = new URLSearchParams({ project: encodeProjectPath(projectPath) })
    if (filter?.type) params.set('type', filter.type)
    if (filter?.status) params.set('status', filter.status)
    const res = await fetch(`${API_BASE}/kb/entities?${params}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async getKBEntity(projectPath: string, id: string): Promise<KBEntity> {
    const res = await fetch(`${API_BASE}/kb/entities/${id}?project=${encodeProjectPath(projectPath)}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async getKBTimeline(projectPath: string, since?: string, limit?: number): Promise<KBEvent[]> {
    const params = new URLSearchParams({ project: encodeProjectPath(projectPath) })
    if (since) params.set('since', since)
    if (limit) params.set('limit', String(limit))
    const res = await fetch(`${API_BASE}/kb/timeline?${params}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async getKBSchema(): Promise<{
    statuses: Record<string, string[]>
    transitions: Record<string, Record<string, string[]>>
  }> {
    const res = await fetch(`${API_BASE}/kb/schema`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  // Update a KB entity (status / title / properties / tags). The server runs
  // the same validated mutation as `orka kb update`, logging an entity.updated
  // event so the change is recorded in the KB timeline.
  async updateKBEntity(
    projectPath: string,
    id: string,
    patch: {
      status?: string
      title?: string
      properties?: Record<string, unknown>
      addTags?: string[]
      removeTags?: string[]
    },
  ): Promise<KBEntity> {
    const res = await fetch(
      `${API_BASE}/kb/entities/${id}?project=${encodeProjectPath(projectPath)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    )
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      throw new Error(data?.error || (await res.text().catch(() => 'Update failed')))
    }
    return res.json()
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

  /** Ask Claude to generate a natural-language summary of a KB entity in
   *  the requested language. Uses the entity's properties + 1-hop
   *  neighborhood as context. Returns plain prose (no markdown fences). */
  async aiKBSummary(
    projectPath: string,
    entityId: string,
    language: 'es' | 'en'
  ): Promise<{ summary: string; language: 'es' | 'en' }> {
    const res = await fetch(`${API_BASE}/ai/kb-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, entityId, language }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'KB summary failed' }))
      throw new Error(data.error || 'KB summary failed')
    }
    return res.json()
  },

  // ---------- Boards ----------

  async listBoards(projectPath: string): Promise<BoardIndexEntry[]> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board?project=${p}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async createBoard(
    projectPath: string,
    payload: { name: string; jiraUrl: string; jql?: string; columns?: string[] }
  ): Promise<BoardConfig> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board?project=${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async getBoard(projectPath: string, boardId: string): Promise<BoardConfig> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}?project=${p}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async updateBoard(
    projectPath: string,
    boardId: string,
    patch: Partial<BoardConfig>
  ): Promise<BoardConfig> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}?project=${p}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async deleteBoard(projectPath: string, boardId: string): Promise<void> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}?project=${p}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(await res.text())
  },

  async listBoardTasks(projectPath: string, boardId: string, status?: string): Promise<BoardTask[]> {
    const p = encodeProjectPath(projectPath)
    const q = status ? `&status=${encodeURIComponent(status)}` : ''
    const res = await fetch(`${API_BASE}/board/${boardId}/tasks?project=${p}${q}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async updateBoardTask(
    projectPath: string,
    boardId: string,
    key: string,
    patch: Partial<BoardTask>
  ): Promise<BoardTask> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}/tasks/${key}?project=${p}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async startBoardMaster(
    projectPath: string,
    boardId: string
  ): Promise<{ tmuxSessionId: string; paneId: string; ttydPort: number; ttydPid: number; claudeSessionId: string }> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}/master/start?project=${p}`, { method: 'POST' })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async syncBoardMaster(projectPath: string, boardId: string): Promise<void> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}/master/sync?project=${p}`, { method: 'POST' })
    if (!res.ok) throw new Error(await res.text())
  },

  /**
   * Spawn (or resume) a Board task terminal.
   *
   * `changeStatusTo` is opt-in: pass a column name to move the card at
   * the same time (Kanban drag → in-progress does this); omit to keep
   * the task in whatever column it's already in (modal Start button
   * uses this so a Review task keeps its column when you attach a
   * terminal to it).
   */
  async startBoardTask(
    projectPath: string,
    boardId: string,
    key: string,
    template: string = 'full',
    changeStatusTo?: string,
  ): Promise<{ tmuxSessionId: string; paneId: string; ttydPort: number; ttydPid: number; claudeSessionId: string; template: string; reopen: boolean; statusChanged: boolean }> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}/tasks/${key}/start?project=${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template, changeStatusTo }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /** Revive a task's terminal after a server restart. Returns:
   *   `alive`      — tmux survived, we spawned a fresh ttyd (handles updated).
   *   `dead`       — tmux is gone; UI should offer to `startBoardTask` again.
   *   `no-handles` — this task never had a terminal.
   */
  async resumeBoardTask(
    projectPath: string,
    boardId: string,
    key: string,
  ): Promise<{ status: 'alive' | 'dead' | 'no-handles'; handles?: { tmuxSessionId: string; paneId: string; ttydPort: number; ttydPid: number } }> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}/tasks/${key}/resume?project=${p}`, { method: 'POST' })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  /** Silent close — only status change + optional terminal action, NO
   *  prompt sent to Claude. Safe as the default of drag & drop. */
  async closeBoardTask(
    projectPath: string,
    boardId: string,
    key: string,
    opts: { status?: string; terminal?: 'keep' | 'detach' | 'shutdown' } = {}
  ): Promise<void> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}/tasks/${key}/close?project=${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    })
    if (!res.ok) throw new Error(await res.text())
  },

  /** Full wrap-up ritual — sends the close-template prompt so Claude
   *  runs push + PR + Jira comment + Jira transition + KB update. Use
   *  when the user explicitly opts in (button + confirm dialog). */
  async wrapUpBoardTask(
    projectPath: string,
    boardId: string,
    key: string,
    opts: { template?: string; status?: string; terminal?: 'keep' | 'detach' | 'shutdown' } = {}
  ): Promise<void> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}/tasks/${key}/wrap-up?project=${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    })
    if (!res.ok) throw new Error(await res.text())
  },

  /** Re-send the init prompt to a running terminal. Picks up updated
   *  skills or template body without losing the current Claude context. */
  /** Capture the tmux pane content of a Board task terminal. Analog of
   *  `captureTerminalPane` but routes through BoardManager because board
   *  task sessions live in `.boards/<id>/tasks.json`, not `state.json`. */
  async captureBoardTaskPane(
    projectPath: string,
    boardId: string,
    key: string,
    opts: { lines?: number; ansi?: boolean } = {}
  ): Promise<{ text: string; paneId: string; ansi: boolean }> {
    const p = encodeProjectPath(projectPath)
    const params = new URLSearchParams({ project: p })
    if (opts.lines) params.set('lines', String(opts.lines))
    if (opts.ansi) params.set('ansi', '1')
    const res = await fetch(`${API_BASE}/board/${boardId}/tasks/${key}/capture?${params.toString()}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async reinitBoardTask(
    projectPath: string,
    boardId: string,
    key: string,
    template: string = 'full'
  ): Promise<void> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}/tasks/${key}/reinit?project=${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template }),
    })
    if (!res.ok) throw new Error(await res.text())
  },

  async listBoardDrifts(projectPath: string, boardId: string): Promise<BoardDrift[]> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}/drifts?project=${p}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async ackBoardDrift(projectPath: string, boardId: string, key: string): Promise<void> {
    const p = encodeProjectPath(projectPath)
    const res = await fetch(`${API_BASE}/board/${boardId}/drifts/${key}?project=${p}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(await res.text())
  },

  async listBoardTemplates(): Promise<BoardPromptTemplate[]> {
    const res = await fetch(`${API_BASE}/board/-/templates`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async upsertBoardTemplate(t: BoardPromptTemplate): Promise<BoardPromptTemplate> {
    const res = await fetch(`${API_BASE}/board/-/templates/${t.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(t),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async deleteBoardTemplate(id: string): Promise<void> {
    const res = await fetch(`${API_BASE}/board/-/templates/${id}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(await res.text())
  },

  async getJiraConfig(): Promise<{ instanceUrl?: string; email?: string; apiTokenSet: boolean }> {
    const res = await fetch(`${API_BASE}/board/-/jira`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async setJiraConfig(cfg: { instanceUrl?: string; email?: string; apiToken?: string }): Promise<void> {
    const res = await fetch(`${API_BASE}/board/-/jira`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
    if (!res.ok) throw new Error(await res.text())
  },
}

// ---------- Board types (client-side mirror) ----------

export interface BoardIndexEntry {
  id: string
  name: string
  jiraUrl: string
  createdAt: string
}

export interface BoardConfig {
  id: string
  name: string
  jiraUrl: string
  jql?: string
  columns: string[]
  masterPromptId?: string
  syncPromptId?: string
  lastSyncedAt?: string
  createdAt: string
  schemaVersion: string
}

export interface BoardTask {
  key: string
  title: string
  description?: string
  status: string
  priority?: string
  assignee?: string
  reporter?: string
  labels?: string[]
  jiraUrl: string
  kbEntityId?: string
  terminalPaneId?: string
  terminalTmuxSessionId?: string
  ttydPort?: number
  ttydPid?: number
  worktreePath?: string
  branchName?: string
  createdAt: string
  updatedAt: string
  raw?: unknown
}

export interface BoardDrift {
  taskKey: string
  fromStatus: string
  toStatus: string
  detectedAt: string
}

export interface BoardPromptTemplate {
  id: string
  name: string
  description?: string
  kind: 'master' | 'sync' | 'task-init' | 'task-close'
  body: string
  requiresWorktree?: boolean
  removesWorktree?: boolean
  builtin?: boolean
}
