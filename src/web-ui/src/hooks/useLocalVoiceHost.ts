import { useCallback, useEffect, useState } from 'react'

/**
 * Where the voice agent's speech models run.
 *
 * By default: on the server serving the page. Opening a remote Orka
 * from a laptop that also runs Orka means whisper and Kokoro run
 * remotely while the laptop sits idle with the same models installed,
 * so the browser can send its speech work to another host instead. The
 * conversation, the sessions and the terminals stay where they are;
 * only the voice moves.
 *
 * Hosts are REGISTERED rather than typed each time, because the address
 * is not guessable and not memorable: a browser cannot discover its own
 * machine's address, and a Tailscale certificate covers the tailnet
 * name only — `localhost` and raw IPs fail hostname verification even
 * when the host is right there and healthy. Registering once and
 * picking from a list is the difference between a usable setting and a
 * URL the user re-derives every time.
 *
 * `null` selection means the serving host, which is always available
 * and always the fallback.
 */

const HOSTS_KEY = 'orka.voice.speechHosts'
const SELECTED_KEY = 'orka.voice.speechHost.selected'

export interface SpeechHost {
  url: string
  /** Short name for the picker; defaults to the URL's hostname. */
  label: string
}

export type HostReachability = 'unknown' | 'checking' | 'ok' | 'unreachable'

export interface LocalVoiceHost {
  /** Registered hosts, not including the serving host. */
  hosts: SpeechHost[]
  /** Selected host URL, or null for "this server". */
  selected: string | null
  /** True when speech should go somewhere other than the serving host. */
  enabled: boolean
  /** Base URL to send speech work to — only meaningful when enabled. */
  url: string
  reachability: Record<string, HostReachability>
  error: string | null
  /** Pick a registered host, or null to go back to this server. */
  select: (url: string | null) => void
  addHost: (url: string) => Promise<boolean>
  removeHost: (url: string) => void
  probeAll: () => Promise<void>
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch { return fallback }
}

function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* blocked storage */ }
}

function labelFor(url: string): string {
  try { return new URL(url).hostname.split('.')[0] || url } catch { return url }
}

/** Why a host is unreachable, in terms the user can act on. */
function describeFailure(url: string, err: unknown): string {
  const e = err as { name?: string }
  if (e?.name === 'TimeoutError') return 'No answer from that host.'
  if (/localhost|127\.0\.0\.1|^https?:\/\/\d/.test(url)) {
    return "localhost and IP addresses can't be verified over HTTPS — use the machine's tailnet name, like https://my-mac.your-tailnet.ts.net:3456"
  }
  return 'Could not reach it — check the URL is https and its certificate is valid.'
}

export function useLocalVoiceHost(): LocalVoiceHost {
  const [hosts, setHosts] = useState<SpeechHost[]>(() => read<SpeechHost[]>(HOSTS_KEY, []))
  const [selected, setSelected] = useState<string | null>(() => read<string | null>(SELECTED_KEY, null))
  const [reachability, setReachability] = useState<Record<string, HostReachability>>({})
  const [error, setError] = useState<string | null>(null)

  const probeOne = useCallback(async (url: string): Promise<boolean> => {
    setReachability(r => ({ ...r, [url]: 'checking' }))
    try {
      const res = await fetch(`${url}/api/voice/capabilities`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const caps = await res.json()
      const ok = !!caps.tts
      setReachability(r => ({ ...r, [url]: ok ? 'ok' : 'unreachable' }))
      if (!ok) setError('That host has no speech models installed.')
      return ok
    } catch (err) {
      setReachability(r => ({ ...r, [url]: 'unreachable' }))
      setError(describeFailure(url, err))
      return false
    }
  }, [])

  const probeAll = useCallback(async () => {
    setError(null)
    await Promise.all(hosts.map(h => probeOne(h.url)))
  }, [hosts, probeOne])

  // A selected host that stopped answering must not silently swallow the
  // microphone — fall back to the serving host and say why.
  useEffect(() => {
    if (!selected) return
    void (async () => {
      const ok = await probeOne(selected)
      if (!ok) {
        setSelected(null)
        write(SELECTED_KEY, null)
        setError('That host stopped answering, so speech is back on the server.')
      }
    })()
    // Intentionally only on mount / when the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const select = useCallback((url: string | null) => {
    setSelected(url)
    write(SELECTED_KEY, url)
    setError(null)
  }, [])

  const addHost = useCallback(async (raw: string): Promise<boolean> => {
    const url = raw.trim().replace(/\/+$/, '')
    if (!url) return false
    if (url === window.location.origin) {
      setError('That is this server — it is already the default.')
      return false
    }
    const ok = await probeOne(url)
    if (!ok) return false
    setHosts(prev => {
      if (prev.some(h => h.url === url)) return prev
      const next = [...prev, { url, label: labelFor(url) }]
      write(HOSTS_KEY, next)
      return next
    })
    setError(null)
    return true
  }, [probeOne])

  const removeHost = useCallback((url: string) => {
    setHosts(prev => {
      const next = prev.filter(h => h.url !== url)
      write(HOSTS_KEY, next)
      return next
    })
    setSelected(cur => {
      if (cur !== url) return cur
      write(SELECTED_KEY, null)
      return null
    })
  }, [])

  return {
    hosts,
    selected,
    enabled: !!selected,
    url: selected || '',
    reachability,
    error,
    select,
    addHost,
    removeHost,
    probeAll,
  }
}
