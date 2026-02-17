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
}

/**
 * Global Orka configuration
 */
export interface GlobalConfig {
  projects: RegisteredProject[]
  serverPort: number
  ttydBasePort: number
  lastUpdated: string
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
