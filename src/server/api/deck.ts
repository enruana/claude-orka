import { Router } from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'http'
import type { Server as HttpsServer } from 'https'
import type { Duplex } from 'stream'
import { randomUUID } from 'crypto'
import { logger } from '../../utils'

/**
 * Stream Deck presence + command bus.
 *
 * Each mounted web-ui opens a WebSocket to /api/deck/live on boot with
 * a clientId persisted in localStorage. The server keeps presence in
 * an in-memory Map — one Orka daemon serves every tab on this machine,
 * no cluster to coordinate, and every browser reconnects within
 * seconds of a restart so evaporating state on restart is fine.
 *
 * To drive another tab, the deck POSTs a command to
 * /api/deck/clients/:id/command; the server relays it over the
 * target's WS.
 */

export type DeckDevice =
  | 'ipad' | 'iphone' | 'mac' | 'linux' | 'windows' | 'android' | 'unknown'

interface ClientRecord {
  clientId: string
  name: string
  device: DeckDevice
  userAgent: string
  currentRoute: string
  connectedAt: number
  lastSeen: number
  hidden: boolean
  ws: WebSocket
}

export interface ClientPublic {
  clientId: string
  name: string
  device: DeckDevice
  userAgent: string
  currentRoute: string
  connectedAt: number
  lastSeen: number
  self?: boolean
}

/**
 * `sendText`: the controlled client performs the POST to the
 * send-text endpoint itself, so we don't need to track which session
 * is "active" on the controller side.
 */
export type DeckCommand =
  | { type: 'navigate'; path: string; commandId: string }
  | { type: 'sendText'; sessionId: string; projectPath: string; text: string; pressEnter?: boolean; commandId: string }
  | { type: 'flash'; commandId: string }

const clients = new Map<string, ClientRecord>()

type ServerMessage =
  | { type: 'hello'; clientId: string; roster: ClientPublic[] }
  | { type: 'roster'; roster: ClientPublic[] }
  | { type: 'command'; command: DeckCommand }

function toPublic(rec: ClientRecord, selfId?: string): ClientPublic {
  return {
    clientId: rec.clientId,
    name: rec.name,
    device: rec.device,
    userAgent: rec.userAgent,
    currentRoute: rec.currentRoute,
    connectedAt: rec.connectedAt,
    lastSeen: rec.lastSeen,
    self: selfId === rec.clientId,
  }
}

function currentRoster(selfId?: string): ClientPublic[] {
  return [...clients.values()]
    .filter((c) => !c.hidden)
    .sort((a, b) => a.connectedAt - b.connectedAt)
    .map((c) => toPublic(c, selfId))
}

function broadcastRoster(): void {
  for (const rec of clients.values()) {
    if (rec.ws.readyState !== WebSocket.OPEN) continue
    const msg: ServerMessage = { type: 'roster', roster: currentRoster(rec.clientId) }
    try { rec.ws.send(JSON.stringify(msg)) } catch { /* drop */ }
  }
}

/** iPad on iPadOS 13+ reports "Macintosh"; trust the client's own hint over UA. */
function detectDevice(ua: string, hint?: string): DeckDevice {
  const trusted = (hint || '').toLowerCase()
  if (trusted === 'ipad' || trusted === 'iphone' || trusted === 'mac'
      || trusted === 'linux' || trusted === 'windows' || trusted === 'android') {
    return trusted as DeckDevice
  }
  const u = (ua || '').toLowerCase()
  if (u.includes('ipad')) return 'ipad'
  if (u.includes('iphone')) return 'iphone'
  if (u.includes('android')) return 'android'
  if (u.includes('macintosh') || u.includes('mac os x')) return 'mac'
  if (u.includes('linux')) return 'linux'
  if (u.includes('windows')) return 'windows'
  return 'unknown'
}

function defaultName(device: DeckDevice): string {
  const labels: Record<DeckDevice, string> = {
    ipad: 'iPad', iphone: 'iPhone', mac: 'Mac',
    linux: 'Linux', windows: 'Windows', android: 'Android',
    unknown: 'Device',
  }
  return labels[device]
}

export const deckRouter = Router()

deckRouter.get('/clients', (_req, res) => {
  res.json({ clients: currentRoster() })
})

deckRouter.patch('/clients/:id', (req, res) => {
  const rec = clients.get(req.params.id)
  if (!rec) { res.status(404).json({ error: 'Client not found' }); return }
  const name = String(req.body?.name || '').trim().slice(0, 40)
  if (!name) { res.status(400).json({ error: 'Empty name' }); return }
  rec.name = name
  broadcastRoster()
  res.json({ ok: true, client: toPublic(rec) })
})

/** Body is a DeckCommand without commandId; server assigns one and returns it. */
deckRouter.post('/clients/:id/command', (req, res) => {
  const rec = clients.get(req.params.id)
  if (!rec) { res.status(404).json({ error: 'Client not found' }); return }
  if (rec.hidden) { res.status(403).json({ error: 'Client is not registered as controllable' }); return }
  if (rec.ws.readyState !== WebSocket.OPEN) {
    res.status(410).json({ error: 'Client not currently connected' }); return
  }
  const commandId = randomUUID()
  let command: DeckCommand
  const kind = String(req.body?.type || '')
  if (kind === 'navigate') {
    const path = String(req.body?.path || '')
    if (!path.startsWith('/')) { res.status(400).json({ error: 'path must start with /' }); return }
    command = { type: 'navigate', path, commandId }
  } else if (kind === 'sendText') {
    const sessionId = String(req.body?.sessionId || '')
    const projectPath = String(req.body?.projectPath || '')
    const text = String(req.body?.text || '')
    if (!sessionId || !projectPath || !text) {
      res.status(400).json({ error: 'sessionId, projectPath and text are required' }); return
    }
    const pressEnter = !!req.body?.pressEnter
    command = { type: 'sendText', sessionId, projectPath, text, pressEnter, commandId }
  } else if (kind === 'flash') {
    command = { type: 'flash', commandId }
  } else {
    res.status(400).json({ error: `Unknown command type: ${kind}` }); return
  }
  const msg: ServerMessage = { type: 'command', command }
  try { rec.ws.send(JSON.stringify(msg)) } catch (err: any) {
    res.status(500).json({ error: `Failed to relay: ${err.message}` }); return
  }
  res.json({ ok: true, commandId })
})

/**
 * Shares its upgrade listener with the transcribe and voice sockets;
 * filters on path so all three can coexist on the same server.
 */
export function attachDeckWS(server: HttpServer | HttpsServer): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url || !req.url.startsWith('/api/deck/live')) return
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', 'http://x')
    const requestedId = url.searchParams.get('clientId') || ''
    const deviceHint = url.searchParams.get('device') || ''
    const rawName = url.searchParams.get('name') || ''
    const hiddenParam = url.searchParams.get('hidden') !== '0'
    const ua = req.headers['user-agent'] || ''
    const device = detectDevice(ua, deviceHint)

    let clientId = requestedId && /^[A-Za-z0-9_-]{8,64}$/.test(requestedId)
      ? requestedId
      : randomUUID()
    const existing = clients.get(clientId)
    if (existing) {
      try { existing.ws.close(4000, 'replaced by new connection') } catch { /* drop */ }
      clients.delete(clientId)
    }

    const now = Date.now()
    const rec: ClientRecord = {
      clientId,
      name: (rawName.trim().slice(0, 40)) || defaultName(device),
      device,
      userAgent: String(ua),
      currentRoute: '/',
      connectedAt: now,
      lastSeen: now,
      hidden: hiddenParam,
      ws,
    }
    clients.set(clientId, rec)
    logger.info(`[deck] client connected: ${rec.name} (${rec.device}, ${clientId})`)

    const hello: ServerMessage = { type: 'hello', clientId, roster: currentRoster(clientId) }
    try { ws.send(JSON.stringify(hello)) } catch { /* drop */ }
    broadcastRoster()

    ws.on('message', (raw) => {
      let msg: any
      try { msg = JSON.parse(String(raw)) } catch { return }
      rec.lastSeen = Date.now()
      switch (msg?.type) {
        case 'route': {
          const path = String(msg.path || '')
          if (path && path !== rec.currentRoute) {
            rec.currentRoute = path
            broadcastRoster()
          }
          break
        }
        case 'rename': {
          const name = String(msg.name || '').trim().slice(0, 40)
          if (name && name !== rec.name) {
            rec.name = name
            broadcastRoster()
          }
          break
        }
        case 'setHidden': {
          const next = !!msg.hidden
          if (next !== rec.hidden) {
            rec.hidden = next
            broadcastRoster()
          }
          break
        }
        case 'ping':
        case 'ack':
          break
      }
    })

    ws.on('close', () => {
      const stored = clients.get(clientId)
      if (stored && stored.ws === ws) {
        clients.delete(clientId)
        logger.info(`[deck] client disconnected: ${rec.name} (${clientId})`)
        broadcastRoster()
      }
    })

    ws.on('error', (err) => {
      logger.warn(`[deck] ws error for ${rec.name} (${clientId}): ${err.message}`)
    })
  })

  setInterval(() => {
    const cutoff = Date.now() - 90_000
    let removed = 0
    for (const [id, rec] of clients.entries()) {
      if (rec.lastSeen < cutoff && rec.ws.readyState !== WebSocket.OPEN) {
        clients.delete(id); removed++
      }
    }
    if (removed > 0) broadcastRoster()
  }, 45_000).unref()
}
