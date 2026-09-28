import {
  createContext, useCallback, useContext, useEffect, useMemo,
  useRef, useState, type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export type DeckDevice =
  | 'ipad' | 'iphone' | 'mac' | 'linux' | 'windows' | 'android' | 'unknown'

export interface DeckClientPublic {
  clientId: string
  name: string
  device: DeckDevice
  userAgent: string
  currentRoute: string
  connectedAt: number
  lastSeen: number
  self?: boolean
}

const CLIENT_ID_KEY = 'orka-deck-client-id'
const CLIENT_NAME_KEY = 'orka-deck-client-name'
const ACTIVE_KEY = 'orka-deck-active'
const KEEPALIVE_MS = 25_000
const SILENT_TIMEOUT_MS = 55_000

function newClientId(): string {
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** iPadOS 13+ reports "Macintosh"; sniff touch to disambiguate. */
function detectDevice(): DeckDevice {
  const ua = navigator.userAgent
  const platform = (navigator as any).platform || ''
  const maxTouch = (navigator as any).maxTouchPoints || 0
  if (/iPad/.test(ua)) return 'ipad'
  if (/iPhone/.test(ua)) return 'iphone'
  if (/Android/.test(ua)) return 'android'
  if (/Macintosh|Mac OS X/.test(ua)) {
    if (maxTouch > 1 && /Mac/.test(platform)) return 'ipad'
    return 'mac'
  }
  if (/Linux/.test(ua)) return 'linux'
  if (/Windows/.test(ua)) return 'windows'
  return 'unknown'
}

/** clientId is per-tab so two tabs on the same device don't share
 *  a registration (last one in would evict the earlier). Nombre queda
 *  en localStorage — es el mismo dispositivo, mismo nombre por default. */
export function getTabClientId(): string {
  try {
    const stored = sessionStorage.getItem(CLIENT_ID_KEY)
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored
    const fresh = newClientId()
    sessionStorage.setItem(CLIENT_ID_KEY, fresh)
    return fresh
  } catch {
    return newClientId()
  }
}

export function getPersistentClientName(): string | null {
  try { return localStorage.getItem(CLIENT_NAME_KEY) } catch { return null }
}
export function setPersistentClientName(name: string): void {
  try { localStorage.setItem(CLIENT_NAME_KEY, name) } catch { /* drop */ }
}

interface CommandNavigate { type: 'navigate'; path: string; commandId: string }
interface CommandSendText { type: 'sendText'; sessionId: string; projectPath: string; text: string; pressEnter?: boolean; commandId: string }
interface CommandFlash { type: 'flash'; commandId: string }
type DeckCommand = CommandNavigate | CommandSendText | CommandFlash

export type DeckConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

interface DeckContextValue {
  active: boolean
  setActive: (next: boolean) => void
  clientId: string
  roster: DeckClientPublic[]
  status: DeckConnStatus
}

const DeckContext = createContext<DeckContextValue | null>(null)

export function useDeck(): DeckContextValue {
  const ctx = useContext(DeckContext)
  if (!ctx) throw new Error('useDeck must be used inside <DeckProvider>')
  return ctx
}

export function useDeckRoster(): DeckClientPublic[] {
  return useDeck().roster
}

export function useDeckActive(): [boolean, (v: boolean) => void] {
  const { active, setActive } = useDeck()
  return [active, setActive]
}

/**
 * Owns the single WebSocket per tab. Mount once at the app root.
 *
 * Registration:
 *   - Every tab connects on mount (needed to read the roster from the
 *     Stream Deck), but starts `hidden=true` so it does NOT appear as
 *     controllable to other tabs.
 *   - Flipping active flips `hidden` server-side and echoes back in
 *     the next roster broadcast. The flag lives in sessionStorage so
 *     it dies with the tab and does NOT bleed to other tabs.
 *   - Skipped entirely when running inside an iframe (`window !== top`)
 *     so embedded terminals / voice widgets don't ghost-register.
 *
 * Resilience:
 *   - Exponential backoff up to 15s on close.
 *   - `visibilitychange` / `online` / `pageshow` force an immediate
 *     reconnect when the tab wakes up or the network returns.
 *   - Silence timeout — if the server hasn't sent anything in 55s
 *     (including roster echoes), we cut the socket and reconnect.
 */
export function DeckProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()

  const isEmbedded = typeof window !== 'undefined' && window.top !== window.self
  const clientId = useMemo(() => getTabClientId(), [])

  const [active, setActiveState] = useState<boolean>(() => {
    try { return sessionStorage.getItem(ACTIVE_KEY) === '1' } catch { return false }
  })
  const [roster, setRoster] = useState<DeckClientPublic[]>([])
  const [status, setStatus] = useState<DeckConnStatus>('idle')

  const wsRef = useRef<WebSocket | null>(null)
  const backoffRef = useRef(500)
  const closedRef = useRef(false)
  const lastRouteRef = useRef<string>('')
  const lastServerMsgRef = useRef<number>(0)
  const silenceTimerRef = useRef<number | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  const setActive = useCallback((next: boolean) => {
    try {
      if (next) sessionStorage.setItem(ACTIVE_KEY, '1')
      else sessionStorage.removeItem(ACTIVE_KEY)
    } catch { /* drop */ }
    setActiveState(next)
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'setHidden', hidden: !next })) } catch { /* drop */ }
    }
  }, [])

  const runCommand = useCallback(async (cmd: DeckCommand) => {
    switch (cmd.type) {
      case 'navigate': {
        navigate(cmd.path)
        showFlash('navigate')
        break
      }
      case 'sendText': {
        try {
          await fetch(
            `/api/sessions/${cmd.sessionId}/send-text?project=${encodeURIComponent(btoa(cmd.projectPath))}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: cmd.text, pressEnter: cmd.pressEnter ?? true }),
            },
          )
          showFlash('sendText')
        } catch (err) {
          console.warn('[deck] sendText failed', err)
        }
        break
      }
      case 'flash': {
        showFlash('flash')
        break
      }
    }
    try { wsRef.current?.send(JSON.stringify({ type: 'ack', commandId: cmd.commandId })) } catch { /* drop */ }
  }, [navigate])

  const armSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) window.clearTimeout(silenceTimerRef.current)
    silenceTimerRef.current = window.setTimeout(() => {
      const ws = wsRef.current
      if (!ws) return
      try { ws.close(4001, 'silence timeout') } catch { /* drop */ }
    }, SILENT_TIMEOUT_MS)
  }, [])

  const connect = useCallback(() => {
    if (closedRef.current || isEmbedded) return
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) return

    const device = detectDevice()
    const storedName = getPersistentClientName() || ''
    const params = new URLSearchParams()
    params.set('clientId', clientId)
    params.set('device', device)
    if (storedName) params.set('name', storedName)
    params.set('hidden', activeRef.current ? '0' : '1')

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/api/deck/live?${params}`
    setStatus((s) => s === 'open' ? s : 'connecting')
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      backoffRef.current = 500
      lastServerMsgRef.current = Date.now()
      setStatus('open')
      armSilenceTimer()
      if (lastRouteRef.current) {
        try { ws.send(JSON.stringify({ type: 'route', path: lastRouteRef.current })) } catch { /* drop */ }
      }
    }

    ws.onmessage = (ev) => {
      lastServerMsgRef.current = Date.now()
      armSilenceTimer()
      let msg: any
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg?.type === 'hello' || msg?.type === 'roster') {
        setRoster((msg.roster || []) as DeckClientPublic[])
      } else if (msg?.type === 'command' && msg.command) {
        void runCommand(msg.command as DeckCommand)
      }
    }

    ws.onclose = (ev) => {
      wsRef.current = null
      if (silenceTimerRef.current !== null) {
        window.clearTimeout(silenceTimerRef.current)
        silenceTimerRef.current = null
      }
      if (closedRef.current) { setStatus('closed'); return }
      if (ev.code === 4000) { setStatus('closed'); return }
      setStatus('reconnecting')
      const delay = Math.min(backoffRef.current, 15_000)
      backoffRef.current = Math.min(backoffRef.current * 2, 15_000)
      window.setTimeout(connect, delay)
    }

    ws.onerror = () => { try { ws.close() } catch { /* drop */ } }
  }, [clientId, runCommand, armSilenceTimer, isEmbedded])

  useEffect(() => {
    if (isEmbedded) return
    closedRef.current = false
    connect()

    const keepalive = window.setInterval(() => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'ping' })) } catch { /* drop */ }
      }
    }, KEEPALIVE_MS)

    const forceReconnect = () => {
      const ws = wsRef.current
      const stale = Date.now() - lastServerMsgRef.current > SILENT_TIMEOUT_MS
      if (!ws || ws.readyState !== WebSocket.OPEN || stale) {
        try { ws?.close(4002, 'wakeup') } catch { /* drop */ }
        wsRef.current = null
        backoffRef.current = 500
        connect()
      }
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') forceReconnect() }
    const onOnline = () => forceReconnect()
    const onPageShow = () => forceReconnect()

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('pageshow', onPageShow)

    return () => {
      closedRef.current = true
      window.clearInterval(keepalive)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pageshow', onPageShow)
      if (silenceTimerRef.current !== null) window.clearTimeout(silenceTimerRef.current)
      try { wsRef.current?.close() } catch { /* drop */ }
    }
  }, [connect, isEmbedded])

  useEffect(() => {
    const route = location.pathname + location.search
    lastRouteRef.current = route
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'route', path: route })) } catch { /* drop */ }
    }
  }, [location.pathname, location.search])

  const value = useMemo<DeckContextValue>(
    () => ({ active, setActive, clientId, roster, status }),
    [active, setActive, clientId, roster, status],
  )

  return <DeckContext.Provider value={value}>{children}</DeckContext.Provider>
}

let flashTimer: number | null = null

/** Small overlay so the person at the controlled tab sees when it gets poked. */
function showFlash(kind: string): void {
  try {
    let node = document.getElementById('orka-deck-flash')
    if (!node) {
      node = document.createElement('div')
      node.id = 'orka-deck-flash'
      node.style.cssText = [
        'position:fixed', 'top:16px', 'right:16px', 'z-index:99999',
        'padding:8px 14px', 'border-radius:999px',
        'background:rgba(203,166,247,0.16)', 'color:#cba6f7',
        'font:600 12px system-ui,sans-serif',
        'border:1px solid rgba(203,166,247,0.4)',
        'backdrop-filter:blur(10px)',
        'pointer-events:none',
        'opacity:0', 'transition:opacity 0.15s ease',
      ].join(';')
      document.body.appendChild(node)
    }
    node.textContent = kind === 'sendText' ? '⌨︎ typed from Stream Deck'
      : kind === 'navigate' ? '↗ navigated from Stream Deck'
      : '● poked from Stream Deck'
    node.style.opacity = '1'
    if (flashTimer !== null) window.clearTimeout(flashTimer)
    flashTimer = window.setTimeout(() => { if (node) node.style.opacity = '0' }, 1400)
  } catch { /* drop */ }
}
