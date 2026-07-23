import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { logger } from '../utils'

/**
 * Registered project in global state
 */
export interface RegisteredProject {
  path: string
  name: string
  addedAt: string
  lastOpened?: string
  group?: string
}

/**
 * Global Orka configuration
 */
export interface SystemTerminalInfo {
  tmuxSessionId: string
  ttydPort: number
  ttydPid: number
}

/**
 * A KB entity the user has "pinned" to the ProjectDock as a quick shortcut.
 * The whole thing is denormalized (title/type/folderPath all captured at
 * pin time) so the dock can render without hitting the KB on every draw —
 * and so a pin still resolves to *something* if the entity is later
 * deleted/renamed. Re-pin to refresh.
 */
export interface PinnedEntity {
  /** KB entity id, e.g. "prj-0DoR4EtJ". Unique across all projects. */
  entityId: string
  /** KB entity title at pin time. */
  title: string
  /** KB entity type ("project", "initiative", "task", …) — used for the
   *  dock icon color and tooltip. */
  type: string
  /** Absolute project path (matches `RegisteredProject.path`). Needed so
   *  the dock click can navigate to the right project's Finder. */
  projectPath: string
  /** Project-relative folder path — what the dock click navigates to
   *  via `/projects/<encoded>/files?path=<folderPath>`. Resolved from
   *  the entity's path-like properties at pin time. */
  folderPath: string
  /** ISO timestamp — dock renders most-recent first. */
  pinnedAt: string
}

/**
 * A prompt template used by Board sessions — global so the same templates
 * are available across every project. Body is a plain string with
 * `{{placeholder}}` markers the server fills in at spawn time.
 */
export interface BoardPromptTemplate {
  id: string
  name: string
  description?: string
  kind: 'master' | 'sync' | 'task-init' | 'task-close'
  body: string
  /** Init-only: whether the task should get a git worktree. */
  requiresWorktree?: boolean
  /** Close-only: whether the worktree should be removed. */
  removesWorktree?: boolean
  /** Built-in templates ship with the package and can't be deleted, only
   *  overridden by a user-created template with the same id. */
  builtin?: boolean
}

/**
 * Jira instance credentials + defaults. Optional — env vars
 * (JIRA_URL / JIRA_EMAIL / JIRA_API_TOKEN) take precedence when set, so
 * the user can leave the config empty if they prefer shell-managed
 * secrets.
 */
export interface JiraGlobalConfig {
  instanceUrl?: string
  email?: string
  apiToken?: string
}

export interface GlobalConfig {
  projects: RegisteredProject[]
  serverPort: number
  /** http | https — set by the server on startup; read by the hook
   *  installer so the curl commands emitted into .claude/settings.json use
   *  the right scheme. Default 'http' for the first run before any server
   *  has booted. */
  serverProtocol?: 'http' | 'https'
  ttydBasePort: number
  lastUpdated: string
  systemTerminal?: SystemTerminalInfo
  /** KB entities the user pinned to the ProjectDock. Global (not per-
   *  project) so pins from different projects live side-by-side in the
   *  dock — the projectPath on each entry disambiguates. */
  pinnedEntities?: PinnedEntity[]
  /** Jira default credentials. Env vars win when both are present. */
  jira?: JiraGlobalConfig
  /** All board prompt templates (master / sync / task-init / task-close).
   *  Ships with a small set of `builtin: true` defaults; the user may add
   *  more or override existing ones by id. */
  boardPromptTemplates?: BoardPromptTemplate[]
}

const DEFAULT_CONFIG: GlobalConfig = {
  projects: [],
  serverPort: 3456,
  ttydBasePort: 4444,
  lastUpdated: new Date().toISOString(),
}

/**
 * Manages global Orka state stored in ~/.orka/config.json
 * This handles multi-project registration and global settings
 */
export class GlobalStateManager {
  private configDir: string
  private configPath: string
  private config: GlobalConfig | null = null

  constructor() {
    this.configDir = path.join(os.homedir(), '.orka')
    this.configPath = path.join(this.configDir, 'config.json')
  }

  /**
   * Initialize the global state manager
   */
  async initialize(): Promise<void> {
    // Ensure config directory exists
    await fs.ensureDir(this.configDir)

    // Load or create config
    if (await fs.pathExists(this.configPath)) {
      try {
        this.config = await fs.readJson(this.configPath)
        logger.debug('Loaded global config from ~/.orka/config.json')
      } catch (error) {
        logger.warn('Failed to parse global config, creating new one')
        this.config = { ...DEFAULT_CONFIG }
        await this.save()
      }
    } else {
      this.config = { ...DEFAULT_CONFIG }
      await this.save()
      logger.info('Created new global config at ~/.orka/config.json')
    }
  }

  /**
   * Save config to disk
   */
  private async save(): Promise<void> {
    if (!this.config) return
    this.config.lastUpdated = new Date().toISOString()
    await fs.writeJson(this.configPath, this.config, { spaces: 2 })
  }

  /**
   * Get the current config
   */
  getConfig(): GlobalConfig {
    if (!this.config) {
      throw new Error('GlobalStateManager not initialized')
    }
    return this.config
  }

  /**
   * Get all registered projects
   */
  getProjects(): RegisteredProject[] {
    return this.getConfig().projects
  }

  /**
   * Get a project by path
   */
  getProject(projectPath: string): RegisteredProject | null {
    const normalizedPath = path.resolve(projectPath)
    return this.getConfig().projects.find(p => path.resolve(p.path) === normalizedPath) || null
  }

  /**
   * Register a new project
   */
  async registerProject(projectPath: string, name?: string): Promise<RegisteredProject> {
    const normalizedPath = path.resolve(projectPath)

    // Check if already registered
    const existing = this.getProject(normalizedPath)
    if (existing) {
      logger.info(`Project already registered: ${existing.name}`)
      return existing
    }

    // Validate path exists
    if (!await fs.pathExists(normalizedPath)) {
      throw new Error(`Project path does not exist: ${normalizedPath}`)
    }

    // Create project entry
    const project: RegisteredProject = {
      path: normalizedPath,
      name: name || path.basename(normalizedPath),
      addedAt: new Date().toISOString(),
    }

    this.config!.projects.push(project)
    await this.save()

    logger.info(`Registered project: ${project.name} at ${project.path}`)
    return project
  }

  /**
   * Unregister a project
   */
  async unregisterProject(projectPath: string): Promise<boolean> {
    const normalizedPath = path.resolve(projectPath)
    const index = this.config!.projects.findIndex(p => path.resolve(p.path) === normalizedPath)

    if (index === -1) {
      return false
    }

    const removed = this.config!.projects.splice(index, 1)[0]
    await this.save()

    logger.info(`Unregistered project: ${removed.name}`)
    return true
  }

  /**
   * Update a project's metadata (name, group)
   */
  async updateProject(projectPath: string, updates: { name?: string; group?: string | null }): Promise<RegisteredProject | null> {
    const normalizedPath = path.resolve(projectPath)
    const project = this.config!.projects.find(p => path.resolve(p.path) === normalizedPath)

    if (!project) return null

    if (updates.name !== undefined) project.name = updates.name
    if (updates.group === null) {
      delete project.group
    } else if (updates.group !== undefined) {
      project.group = updates.group
    }

    await this.save()
    return project
  }

  /**
   * Update last opened timestamp for a project
   */
  async touchProject(projectPath: string): Promise<void> {
    const normalizedPath = path.resolve(projectPath)
    const project = this.config!.projects.find(p => path.resolve(p.path) === normalizedPath)

    if (project) {
      project.lastOpened = new Date().toISOString()
      await this.save()
    }
  }

  /**
   * Get server port
   */
  getServerPort(): number {
    return this.getConfig().serverPort
  }

  /**
   * Set server port
   */
  async setServerPort(port: number): Promise<void> {
    this.config!.serverPort = port
    await this.save()
  }

  /** Scheme the running server is using (http when no certs, https with
   *  certs). Used by the hook installer to emit a curl that can actually
   *  reach the local server. */
  getServerProtocol(): 'http' | 'https' {
    return this.getConfig().serverProtocol || 'http'
  }

  async setServerProtocol(protocol: 'http' | 'https'): Promise<void> {
    this.config!.serverProtocol = protocol
    await this.save()
  }

  /**
   * Get base port for ttyd instances
   */
  getTtydBasePort(): number {
    return this.getConfig().ttydBasePort
  }

  /**
   * Set base port for ttyd instances
   */
  async setTtydBasePort(port: number): Promise<void> {
    this.config!.ttydBasePort = port
    await this.save()
  }

  /**
   * Get next available ttyd port
   * Scans from base port to find an unused one
   */
  async getNextTtydPort(): Promise<number> {
    const basePort = this.getTtydBasePort()
    const execa = (await import('execa')).default

    for (let port = basePort; port < basePort + 100; port++) {
      try {
        await execa('lsof', ['-i', `:${port}`])
        // Port is in use, continue
      } catch {
        // Port is free
        return port
      }
    }

    throw new Error('No available ports found for ttyd')
  }

  /**
   * Get config directory path
   */
  getConfigDir(): string {
    return this.configDir
  }

  /**
   * Get config file path
   */
  getConfigPath(): string {
    return this.configPath
  }

  /**
   * Get system terminal info
   */
  getSystemTerminal(): SystemTerminalInfo | null {
    return this.config?.systemTerminal || null
  }

  /**
   * Set system terminal info
   */
  async setSystemTerminal(info: SystemTerminalInfo): Promise<void> {
    this.config!.systemTerminal = info
    await this.save()
    logger.info(`System terminal saved: port=${info.ttydPort}, pid=${info.ttydPid}`)
  }

  /**
   * Clear system terminal info
   */
  async clearSystemTerminal(): Promise<void> {
    delete this.config!.systemTerminal
    await this.save()
    logger.info('System terminal cleared')
  }

  // ---------- Board prompt templates ----------

  /**
   * Merge user-defined templates with the built-in defaults. User entries
   * with the same id override the built-in (so the user can customize a
   * default without losing the ability to reset later).
   */
  getBoardTemplates(): BoardPromptTemplate[] {
    const builtin = getBuiltinBoardTemplates()
    const user = this.config?.boardPromptTemplates ?? []
    const byId = new Map<string, BoardPromptTemplate>()
    for (const t of builtin) byId.set(t.id, t)
    for (const t of user) byId.set(t.id, { ...t, builtin: false })
    return [...byId.values()]
  }

  getBoardTemplate(id: string): BoardPromptTemplate | null {
    return this.getBoardTemplates().find((t) => t.id === id) ?? null
  }

  async upsertBoardTemplate(t: BoardPromptTemplate): Promise<BoardPromptTemplate> {
    this.config!.boardPromptTemplates = this.config!.boardPromptTemplates ?? []
    const idx = this.config!.boardPromptTemplates.findIndex((x) => x.id === t.id)
    const clean: BoardPromptTemplate = { ...t, builtin: false }
    if (idx === -1) this.config!.boardPromptTemplates.push(clean)
    else this.config!.boardPromptTemplates[idx] = clean
    await this.save()
    return clean
  }

  async deleteBoardTemplate(id: string): Promise<void> {
    if (!this.config?.boardPromptTemplates) return
    const before = this.config.boardPromptTemplates.length
    this.config.boardPromptTemplates = this.config.boardPromptTemplates.filter((t) => t.id !== id)
    if (this.config.boardPromptTemplates.length !== before) await this.save()
  }

  // ---------- Jira credentials ----------

  getJiraConfig(): JiraGlobalConfig {
    return this.config?.jira ?? {}
  }

  async setJiraConfig(cfg: JiraGlobalConfig): Promise<void> {
    this.config!.jira = { ...(this.config!.jira ?? {}), ...cfg }
    await this.save()
  }

  async clearJiraConfig(): Promise<void> {
    delete this.config!.jira
    await this.save()
  }
}

/**
 * Hard-coded board prompt template defaults. Editable from Settings —
 * the user override wins via `upsertBoardTemplate`. Kept inline to avoid
 * a build-time file read; body strings are intentionally succinct because
 * they lean on the skill files (`board-guide` / `board-sync` / `board-task-init`
 * / `board-task-close`) for the operational detail.
 */
function getBuiltinBoardTemplates(): BoardPromptTemplate[] {
  return [
    {
      id: 'master-default',
      name: 'Master (default)',
      kind: 'master',
      description: 'Boot prompt for the board master terminal. Sets expectations and points at the sync skill.',
      builtin: true,
      body: [
        'You are the master terminal for board {{boardName}} (id: {{boardId}}).',
        'Storage: {{projectPath}}/.claude-orka/.boards/{{boardId}}/',
        'Jira URL: {{jiraUrl}}',
        '',
        'You NEVER write to Jira — you only pull tickets, comments and docs.',
        'When the user (or the server) sends you `sync`, load the `board-sync` skill and execute it.',
        'For anything else, answer normally.',
        '',
        'Skills to load on demand: board-guide, board-sync, board-jira-api.',
      ].join('\n'),
    },
    {
      id: 'sync-default',
      name: 'Sync (default)',
      kind: 'sync',
      description: 'Ritual the master runs on every "sync" trigger.',
      builtin: true,
      body: [
        'Sync trigger received. Load the `board-sync` skill and execute the ritual for board {{boardId}}.',
        'When done, report a compact summary and stop.',
      ].join('\n'),
    },
    {
      id: 'full',
      name: 'Full setup (worktree + KB + branch)',
      kind: 'task-init',
      description: 'Standard task boot: create worktree via moxikit, register KB entity, move Jira to In Progress.',
      builtin: true,
      requiresWorktree: true,
      body: [
        'You are starting work on Jira ticket {{taskKey}} — {{taskTitle}}.',
        'Board: {{boardId}} | Project: {{projectPath}} | Jira: {{jiraUrl}}',
        '',
        'Load the `board-task-init` skill and follow its steps.',
        'Suggested branch: {{branchName}}',
        'Worktree parent: {{worktreeParent}}',
        '',
        'When ready, print a compact "ready" summary.',
      ].join('\n'),
    },
    {
      id: 'spike',
      name: 'Spike (no worktree)',
      kind: 'task-init',
      description: 'Investigative task — no worktree, just KB registration and Jira transition.',
      builtin: true,
      requiresWorktree: false,
      body: [
        'Spike: {{taskKey}} — {{taskTitle}}.',
        'Board: {{boardId}} | Project: {{projectPath}} | Jira: {{jiraUrl}}',
        '',
        'Load `board-task-init`. Skip the worktree step (this is a spike).',
        'Register the KB entity as `spike` (not `task`) and mark Jira In Progress.',
        'Then answer whatever question the spike is trying to close.',
      ].join('\n'),
    },
    {
      id: 'close-default',
      name: 'Close (default: push + PR + Jira + KB)',
      kind: 'task-close',
      description: 'Push the branch, open the PR, comment on Jira, mark KB done. Worktree stays until PR merges.',
      builtin: true,
      removesWorktree: false,
      body: [
        'Closing task {{taskKey}}. Load the `board-task-close` skill and follow its steps.',
        'Target status: {{nextStatus}}.',
        'Keep the worktree in place — it may be needed for review fixes.',
      ].join('\n'),
    },
    {
      id: 'close-remove-worktree',
      name: 'Close + remove worktree',
      kind: 'task-close',
      description: 'Full close: same as default, plus moxikit worktree remove at the end.',
      builtin: true,
      removesWorktree: true,
      body: [
        'Closing task {{taskKey}}. Load the `board-task-close` skill.',
        'Target status: {{nextStatus}}.',
        'Remove the worktree at the end (moxikit worktree remove) if it is clean.',
      ].join('\n'),
    },
  ]
}

// Singleton instance
let globalStateManager: GlobalStateManager | null = null

export async function getGlobalStateManager(): Promise<GlobalStateManager> {
  if (!globalStateManager) {
    globalStateManager = new GlobalStateManager()
    await globalStateManager.initialize()
  }
  return globalStateManager
}
