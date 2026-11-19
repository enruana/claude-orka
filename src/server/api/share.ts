import { Router } from 'express'
import { ShareManager } from '../../core/ShareManager'
import { logger } from '../../utils'
import { getShareServerPort, getShareServerProtocol } from '../share-server'
import { getTunnelManager } from '../../core/TunnelManager'

export const shareRouter = Router()

shareRouter.get('/port', (_req, res) => {
  res.json({ port: getShareServerPort(), protocol: getShareServerProtocol() })
})

shareRouter.get('/tunnel', (_req, res) => {
  res.json(getTunnelManager().getState())
})

shareRouter.post('/tunnel', async (_req, res) => {
  const port = getShareServerPort()
  if (!port) { res.status(503).json({ error: 'share server not running' }); return }
  try {
    const state = await getTunnelManager().start(port, getShareServerProtocol())
    res.json(state)
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) })
  }
})

shareRouter.delete('/tunnel', async (_req, res) => {
  try {
    await getTunnelManager().stop()
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) })
  }
})

function decodeProject(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

function projectFromReq(req: { query: { project?: string }; body?: { project?: string } }): string {
  const encoded = (req.query.project as string) || (req.body?.project as string)
  if (!encoded) throw new Error('project query param is required (base64 path)')
  return decodeProject(encoded)
}

function sharePublicShape(share: {
  id: string; token: string; filePath: string; createdAt: string;
  expiresAt: string; revokedAt?: string; options: { allowComments: boolean; allowAsk: boolean };
  createdBy?: string;
}) {
  return {
    id: share.id,
    token: share.token,
    filePath: share.filePath,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    options: share.options,
    createdBy: share.createdBy,
  }
}

shareRouter.get('/', async (req, res) => {
  try {
    const projectPath = projectFromReq(req as any)
    const includeExpired = req.query.includeExpired === '1' || req.query.includeExpired === 'true'
    const mgr = new ShareManager(projectPath)
    const shares = await mgr.list(includeExpired)
    res.json({ shares: shares.map(sharePublicShape) })
  } catch (err: any) {
    res.status(400).json({ error: err?.message || String(err) })
  }
})

shareRouter.post('/', async (req, res) => {
  try {
    const projectPath = projectFromReq(req as any)
    const { filePath, ttlMs, allowComments, allowAsk, createdBy } = req.body || {}
    if (typeof filePath !== 'string' || !filePath.trim()) {
      res.status(400).json({ error: 'filePath required' }); return
    }
    const ttl = Number(ttlMs)
    if (!Number.isFinite(ttl) || ttl < 60_000 || ttl > 30 * 24 * 60 * 60 * 1000) {
      res.status(400).json({ error: 'ttlMs must be between 60s and 30 days' }); return
    }
    const mgr = new ShareManager(projectPath)
    const share = await mgr.create({
      filePath,
      ttlMs: ttl,
      options: {
        allowComments: allowComments !== false,
        allowAsk: allowAsk === true,
      },
      createdBy: typeof createdBy === 'string' ? createdBy : undefined,
    })
    res.status(201).json(sharePublicShape(share))
  } catch (err: any) {
    logger.error('[share] create failed:', err)
    res.status(500).json({ error: err?.message || String(err) })
  }
})

shareRouter.post('/:id/revoke', async (req, res) => {
  try {
    const projectPath = projectFromReq(req as any)
    const mgr = new ShareManager(projectPath)
    await mgr.revoke(req.params.id)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) })
  }
})

shareRouter.post('/:id/extend', async (req, res) => {
  try {
    const projectPath = projectFromReq(req as any)
    const extraMs = Number(req.body?.extraMs)
    if (!Number.isFinite(extraMs) || extraMs <= 0) {
      res.status(400).json({ error: 'extraMs must be a positive number' }); return
    }
    const mgr = new ShareManager(projectPath)
    const share = await mgr.extend(req.params.id, extraMs)
    res.json(sharePublicShape(share))
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) })
  }
})
