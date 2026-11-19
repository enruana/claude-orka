import express, { Request, Response } from 'express'
import http from 'http'
import https from 'https'
import fs from 'fs'
import { getGlobalStateManager } from '../core/GlobalStateManager'
import { ShareManager } from '../core/ShareManager'
import { Share } from '../models'
import { buildReviewerOverlay } from './api/files'
import { askDocument } from './api/ai'
import { logger } from '../utils'
import path from 'path'

const DEFAULT_SHARE_PORT = 3476

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
}

function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] || 'application/octet-stream'
}

interface ResolvedShare {
  share: Share
  manager: ShareManager
}

function getToken(raw: unknown): string {
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0] || '') : ''
}

async function findShareByToken(token: string): Promise<ResolvedShare | null> {
  if (!token) return null
  const global = await getGlobalStateManager()
  const projects = global.getProjects()
  for (const p of projects) {
    const mgr = new ShareManager(p.path)
    const share = await mgr.findByToken(token)
    if (share) return { share, manager: mgr }
  }
  return null
}

function expiredHtml(token: string): string {
  const safe = token.replace(/[<>]/g, '')
  return `<!doctype html><meta charset="utf-8"><title>Share expired</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; background: linear-gradient(180deg, #11131f, #0a0b14);
    color: #ecf0fe; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 24px; }
  .card { max-width: 420px; text-align: center; background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 28px 24px; }
  h1 { font-size: 20px; margin: 0 0 12px; color: #fab387; }
  p { color: #a6adc8; line-height: 1.5; font-size: 14px; margin: 0; }
  code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
</style>
<div class="card">
  <h1>This share has expired</h1>
  <p>The link <code>${safe.slice(0, 10)}…</code> is no longer active. Ask the author to reshare.</p>
</div>`
}

let currentServer: http.Server | https.Server | null = null
let currentPort: number | null = null
let currentProtocol: 'http' | 'https' = 'http'

interface ShareServerOptions {
  port?: number
  certPath?: string
  keyPath?: string
}

export async function startShareServer(opts: ShareServerOptions = {}): Promise<number> {
  if (currentServer) return currentPort as number
  const port = opts.port || DEFAULT_SHARE_PORT

  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.disable('x-powered-by')

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', role: 'share' })
  })

  app.get('/s/:token/view', async (req: Request, res: Response) => {
    try {
      const resolved = await findShareByToken(getToken(req.params.token))
      if (!resolved) {
        res.status(410).type('html').send(expiredHtml(getToken(req.params.token)))
        return
      }
      const html = await resolved.manager.readSnapshotHtml(resolved.share)
      const overlay = buildReviewerOverlay({
        token: resolved.share.token,
        allowComments: resolved.share.options.allowComments,
        allowAsk: resolved.share.options.allowAsk,
        filePath: resolved.share.filePath,
      })
      const injected = injectOverlay(html, overlay)
      res.type('html').send(injected)
    } catch (err: any) {
      logger.error('[share-server] view failed:', err)
      res.status(500).send('share view failed')
    }
  })

  app.get('/s/:token/download', async (req, res) => {
    try {
      const resolved = await findShareByToken(getToken(req.params.token))
      if (!resolved) { res.status(410).send('expired'); return }
      const html = await resolved.manager.readSnapshotHtml(resolved.share)
      const base = (resolved.share.filePath.split('/').pop() || 'document.html').replace(/[\r\n"\\]/g, '')
      const asciiFallback = base.replace(/[^\w.\-() ]/g, '_')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(base)}`,
      )
      res.send(html)
    } catch (err: any) {
      logger.error('[share-server] download failed:', err)
      res.status(500).send('download failed')
    }
  })

  app.get('/s/:token/meta', async (req, res) => {
    const resolved = await findShareByToken(getToken(req.params.token))
    if (!resolved) {
      res.status(410).json({ error: 'expired' }); return
    }
    res.json({
      filePath: resolved.share.filePath,
      expiresAt: resolved.share.expiresAt,
      options: resolved.share.options,
    })
  })

  app.get(/^\/s\/([^/]+)\/asset\/(.+)$/, async (req, res) => {
    const token = String((req.params as unknown as string[])[0] || '')
    const rel = String((req.params as unknown as string[])[1] || '')
    const resolved = await findShareByToken(token)
    if (!resolved) { res.status(410).send('expired'); return }
    const file = await resolved.manager.readAsset(resolved.share, rel)
    if (!file) { res.status(404).send('not found'); return }
    res.type(mimeForExt(path.extname(rel))).send(file.data)
  })

  app.get('/s/:token/comments', async (req, res) => {
    const resolved = await findShareByToken(getToken(req.params.token))
    if (!resolved) { res.status(410).json({ error: 'expired' }); return }
    if (!resolved.share.options.allowComments) { res.json({ comments: [] }); return }
    const { StateManager } = await import('../core/StateManager')
    const sm = new StateManager(resolved.share.projectPath)
    await sm.initialize()
    const all = await sm.listComments()
    const own = all.filter((c) => c.source === `share:${resolved.share.id}`)
    res.json({
      comments: own.map((c) => ({
        id: c.id, startLine: c.startLine, endLine: c.endLine,
        selectedText: c.selectedText, body: c.body,
        reviewerName: c.reviewerName, createdAt: c.createdAt,
        resolved: c.resolved,
      })),
    })
  })

  app.post('/s/:token/comments', async (req, res) => {
    try {
      const resolved = await findShareByToken(getToken(req.params.token))
      if (!resolved) { res.status(410).json({ error: 'expired' }); return }
      if (!resolved.share.options.allowComments) {
        res.status(403).json({ error: 'comments disabled' }); return
      }
      const { selectedText, startLine, endLine, body, reviewerName } = req.body || {}
      if (typeof selectedText !== 'string' || !selectedText.trim()) {
        res.status(400).json({ error: 'selectedText required' }); return
      }
      if (typeof body !== 'string' || !body.trim()) {
        res.status(400).json({ error: 'body required' }); return
      }
      const stored = await resolved.manager.ingestReviewerComment(resolved.share, {
        selectedText,
        startLine: Number(startLine) || 1,
        endLine: Number(endLine) || 1,
        body,
        reviewerName: typeof reviewerName === 'string' ? reviewerName : undefined,
      })
      res.status(201).json({ id: stored.id, createdAt: stored.createdAt, orphan: !!stored.orphan })
    } catch (err: any) {
      logger.error('[share-server] post comment failed:', err)
      res.status(500).json({ error: err?.message || String(err) })
    }
  })

  app.post('/s/:token/ask', async (req, res) => {
    try {
      const resolved = await findShareByToken(getToken(req.params.token))
      if (!resolved) { res.status(410).json({ error: 'expired' }); return }
      if (!resolved.share.options.allowAsk) {
        res.status(403).json({ error: 'ask disabled for this share' }); return
      }
      const { question, selectedText, history } = req.body || {}
      if (typeof question !== 'string' || !question.trim()) {
        res.status(400).json({ error: 'question required' }); return
      }
      if (typeof selectedText !== 'string' || !selectedText.trim()) {
        res.status(400).json({ error: 'selectedText required' }); return
      }
      const docHtml = await resolved.manager.readSnapshotHtml(resolved.share)
      const docText = htmlToPlainText(docHtml)
      const result = await askDocument({
        question,
        selectedText,
        documentText: docText,
        filePath: resolved.share.filePath,
        history: Array.isArray(history) ? history : undefined,
      })
      res.json({ answer: result.answer })
    } catch (err: any) {
      logger.error('[share-server] ask failed:', err)
      if (err?.code === 'ENOENT') {
        res.status(500).json({ error: 'Claude CLI not found on the host machine.' })
        return
      }
      if (err?.timedOut) {
        res.status(500).json({ error: 'Request timed out. Try a shorter question.' })
        return
      }
      res.status(500).json({ error: err?.message || String(err) })
    }
  })

  app.use((_req, res) => {
    res.status(404).send('not found')
  })

  let server: http.Server | https.Server
  let protocol: 'http' | 'https' = 'http'
  if (opts.certPath && opts.keyPath) {
    try {
      const cert = fs.readFileSync(opts.certPath)
      const key = fs.readFileSync(opts.keyPath)
      server = https.createServer({ cert, key }, app)
      protocol = 'https'
    } catch (err: any) {
      logger.warn(`[share-server] cert load failed (${err?.message || err}), falling back to HTTP`)
      server = http.createServer(app)
    }
  } else {
    server = http.createServer(app)
  }

  return new Promise((resolve) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`[share-server] port ${port} in use, share server not started`)
        currentServer = null
        resolve(0)
      }
    })
    server.listen(port, () => {
      currentServer = server
      currentPort = port
      currentProtocol = protocol
      logger.info(`[share-server] listening on ${protocol}://localhost:${port}`)
      resolve(port)
    })
  })
}

export function getShareServerProtocol(): 'http' | 'https' {
  return currentProtocol
}

export function getShareServerPort(): number {
  return currentPort || 0
}

export async function stopShareServer(): Promise<void> {
  const srv = currentServer
  if (!srv) return
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  currentServer = null
  currentPort = null
}

const CSP_META_RE = /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi

function htmlToPlainText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function injectOverlay(html: string, overlay: string): string {
  const stripped = html.replace(CSP_META_RE, '')
  const lower = stripped.toLowerCase()
  const bodyClose = lower.lastIndexOf('</body>')
  if (bodyClose !== -1) {
    return stripped.slice(0, bodyClose) + overlay + stripped.slice(bodyClose)
  }
  return stripped + overlay
}
