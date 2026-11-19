import path from 'path'
import { randomBytes } from 'crypto'
import fs from 'fs-extra'
import { Share, ShareIndex, ShareOptions, SHARE_TOKEN_BYTES, ProjectComment } from '../models'
import { StateManager } from './StateManager'
import { logger } from '../utils'

const SHARE_DIR_NAME = '.claude-orka/shares'
const INDEX_FILE = 'index.json'
const SNAPSHOT_FILE = 'content.html'
const ASSETS_DIR = 'assets'
const MAX_ASSET_BYTES = 20 * 1024 * 1024

function toUrlSafeB64(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generateToken(): string {
  return toUrlSafeB64(randomBytes(SHARE_TOKEN_BYTES))
}

function generateId(): string {
  return `shr-${toUrlSafeB64(randomBytes(8))}`
}

interface CreateInput {
  filePath: string
  ttlMs: number
  options: ShareOptions
  createdBy?: string
}

export class ShareManager {
  private projectPath: string
  private sharesRoot: string

  constructor(projectPath: string) {
    this.projectPath = projectPath
    this.sharesRoot = path.join(projectPath, SHARE_DIR_NAME)
  }

  private shareDir(id: string): string {
    return path.join(this.sharesRoot, id)
  }

  private indexFile(): string {
    return path.join(this.sharesRoot, INDEX_FILE)
  }

  private async readIndex(): Promise<ShareIndex> {
    try {
      return await fs.readJson(this.indexFile())
    } catch {
      return { shares: [] }
    }
  }

  private async writeIndex(idx: ShareIndex): Promise<void> {
    await fs.ensureDir(this.sharesRoot)
    await fs.writeJson(this.indexFile(), idx, { spaces: 2 })
  }

  /**
   * Resolve a project-relative path and reject anything that climbs
   * outside the project root. Paths are stored relative on disk so
   * revokes + sweeps don't need to know the project's absolute path.
   */
  private resolveInsideProject(relFilePath: string): string {
    const normalized = path.normalize(relFilePath).replace(/^(\.\.(\/|\\|$))+/, '')
    const abs = path.resolve(this.projectPath, normalized)
    const projectAbs = path.resolve(this.projectPath)
    if (!abs.startsWith(projectAbs + path.sep) && abs !== projectAbs) {
      throw new Error(`Path escapes project root: ${relFilePath}`)
    }
    return abs
  }

  async create(input: CreateInput): Promise<Share> {
    const sourceAbs = this.resolveInsideProject(input.filePath)
    if (!(await fs.pathExists(sourceAbs))) {
      throw new Error(`File not found: ${input.filePath}`)
    }
    const stat = await fs.stat(sourceAbs)
    if (!stat.isFile()) {
      throw new Error(`Not a regular file: ${input.filePath}`)
    }

    const id = generateId()
    const token = generateToken()
    const now = new Date()
    const share: Share = {
      id,
      token,
      projectPath: this.projectPath,
      filePath: input.filePath.replace(/^\.\//, ''),
      snapshotPath: path.join(SHARE_DIR_NAME, id, SNAPSHOT_FILE),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      options: { ...input.options },
      createdBy: input.createdBy,
    }

    const dir = this.shareDir(id)
    await fs.ensureDir(dir)
    await fs.copyFile(sourceAbs, path.join(dir, SNAPSHOT_FILE))
    await this.copyNeighboringAssets(sourceAbs, path.join(dir, ASSETS_DIR))

    const idx = await this.readIndex()
    idx.shares.push(share)
    await this.writeIndex(idx)
    logger.info(`[share] created ${id} for ${share.filePath} (expires ${share.expiresAt})`)
    return share
  }

  /**
   * Copy small sibling + nested assets that the HTML snapshot likely
   * references (images, css, js). Bounded in size + depth to avoid
   * cloning entire projects. Non-fatal on failure.
   */
  private async copyNeighboringAssets(sourceHtml: string, destAssets: string): Promise<void> {
    try {
      const html = await fs.readFile(sourceHtml, 'utf8')
      const srcDir = path.dirname(sourceHtml)
      const projectAbs = path.resolve(this.projectPath)
      const urls = new Set<string>()
      const attrRe = /(?:src|href)\s*=\s*["']([^"'#?]+)["']/gi
      let m: RegExpExecArray | null
      while ((m = attrRe.exec(html)) !== null) {
        const u = m[1].trim()
        if (!u) continue
        if (/^(https?:|data:|mailto:|tel:|javascript:|#|\/\/)/i.test(u)) continue
        if (u.startsWith('/')) continue
        urls.add(u)
      }
      await fs.ensureDir(destAssets)
      for (const rel of urls) {
        try {
          const abs = path.resolve(srcDir, rel)
          if (!abs.startsWith(projectAbs + path.sep) && abs !== projectAbs) continue
          if (!(await fs.pathExists(abs))) continue
          const s = await fs.stat(abs)
          if (!s.isFile() || s.size > MAX_ASSET_BYTES) continue
          const dest = path.join(destAssets, rel)
          await fs.ensureDir(path.dirname(dest))
          await fs.copyFile(abs, dest)
        } catch { /* skip asset */ }
      }
    } catch (err) {
      logger.warn(`[share] asset snapshot failed: ${(err as Error).message}`)
    }
  }

  async list(includeExpired = false): Promise<Share[]> {
    const idx = await this.readIndex()
    const now = Date.now()
    return idx.shares.filter((s) => {
      if (s.revokedAt) return includeExpired
      if (!includeExpired && new Date(s.expiresAt).getTime() <= now) return false
      return true
    })
  }

  async findByToken(token: string): Promise<Share | null> {
    const idx = await this.readIndex()
    const s = idx.shares.find((x) => x.token === token) || null
    if (!s) return null
    if (s.revokedAt) return null
    if (new Date(s.expiresAt).getTime() <= Date.now()) return null
    return s
  }

  async findById(id: string): Promise<Share | null> {
    const idx = await this.readIndex()
    return idx.shares.find((x) => x.id === id) || null
  }

  async revoke(id: string): Promise<void> {
    const idx = await this.readIndex()
    const s = idx.shares.find((x) => x.id === id)
    if (!s) throw new Error(`Share not found: ${id}`)
    s.revokedAt = new Date().toISOString()
    await this.writeIndex(idx)
    await fs.remove(this.shareDir(id)).catch(() => {})
    logger.info(`[share] revoked ${id}`)
  }

  async extend(id: string, extraMs: number): Promise<Share> {
    const idx = await this.readIndex()
    const s = idx.shares.find((x) => x.id === id)
    if (!s) throw new Error(`Share not found: ${id}`)
    if (s.revokedAt) throw new Error(`Share is revoked: ${id}`)
    const base = Math.max(Date.now(), new Date(s.expiresAt).getTime())
    s.expiresAt = new Date(base + extraMs).toISOString()
    await this.writeIndex(idx)
    return s
  }

  async readSnapshotHtml(share: Share): Promise<string> {
    return fs.readFile(path.join(this.shareDir(share.id), SNAPSHOT_FILE), 'utf8')
  }

  async readAsset(share: Share, relAsset: string): Promise<{ data: Buffer; abs: string } | null> {
    const assetsDir = path.join(this.shareDir(share.id), ASSETS_DIR)
    const abs = path.resolve(assetsDir, relAsset)
    if (!abs.startsWith(assetsDir + path.sep)) return null
    if (!(await fs.pathExists(abs))) return null
    const stat = await fs.stat(abs)
    if (!stat.isFile()) return null
    return { data: await fs.readFile(abs), abs }
  }

  /**
   * Store a comment coming from a reviewer back on the project's live
   * comment store. Anchors by locating selectedText in the current
   * file; marks orphan when nothing matches so the author sees the
   * intent even if the file moved on.
   */
  async ingestReviewerComment(
    share: Share,
    input: { selectedText: string; startLine: number; endLine: number; body: string; reviewerName?: string },
  ): Promise<ProjectComment> {
    const stateMgr = new StateManager(this.projectPath)
    await stateMgr.initialize()

    let startLine = input.startLine
    let endLine = input.endLine
    let orphan = false
    try {
      const liveAbs = this.resolveInsideProject(share.filePath)
      if (await fs.pathExists(liveAbs)) {
        const live = await fs.readFile(liveAbs, 'utf8')
        const anchor = anchorByText(live, input.selectedText, input.startLine)
        if (anchor) {
          startLine = anchor.startLine
          endLine = anchor.endLine
        } else {
          orphan = true
        }
      } else {
        orphan = true
      }
    } catch {
      orphan = true
    }

    const comment: ProjectComment = {
      id: `cmt-${toUrlSafeB64(randomBytes(6))}`,
      filePath: share.filePath,
      startLine,
      endLine,
      selectedText: input.selectedText,
      body: input.body,
      resolved: false,
      createdAt: new Date().toISOString(),
      source: `share:${share.id}`,
      reviewerName: input.reviewerName?.trim() || undefined,
      snapshotPath: share.snapshotPath,
      orphan: orphan || undefined,
    }
    await stateMgr.addComment(comment)
    return comment
  }
}

export function anchorByText(
  liveContent: string,
  selectedText: string,
  originalStartLine: number,
): { startLine: number; endLine: number } | null {
  const needle = selectedText
  if (!needle) return null
  const lines = liveContent.split('\n')

  const matches: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      matches.push({ startLine: i + 1, endLine: i + 1 })
    }
  }
  if (matches.length === 0) {
    const idx = liveContent.indexOf(needle)
    if (idx === -1) return null
    const before = liveContent.slice(0, idx)
    const startLine = (before.match(/\n/g) || []).length + 1
    const spannedNewlines = (needle.match(/\n/g) || []).length
    return { startLine, endLine: startLine + spannedNewlines }
  }
  if (matches.length === 1) return matches[0]
  matches.sort((a, b) =>
    Math.abs(a.startLine - originalStartLine) - Math.abs(b.startLine - originalStartLine))
  return matches[0]
}
