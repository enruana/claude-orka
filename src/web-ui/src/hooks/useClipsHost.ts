import { useCallback, useEffect, useState } from 'react'

/**
 * Where the English clips library lives.
 *
 * Shares the same registered-host pool as voice (orka.voice.speechHosts),
 * since those are Orka instances and any registered one can host clips too.
 * The SELECTION is independent of the voice-TTS selection — someone might
 * want their recordings on the MacBook (whisper runs there anyway) while
 * keeping TTS on the server.
 *
 * `null` means "this server", the host that served this page. Everything
 * else is a registered remote Orka instance addressed by its tailnet URL.
 */

const HOSTS_KEY = 'orka.voice.speechHosts'
const SELECTED_KEY = 'orka.clips.host.selected'

export interface ClipsHost {
  url: string
  label: string
}

export type HostReachability = 'unknown' | 'checking' | 'ok' | 'unreachable'

export interface UseClipsHostResult {
  hosts: ClipsHost[]
  selected: string | null
  /** True when clips go to a host that isn't the one serving this page. */
  enabled: boolean
  /** Base URL to use (e.g. "https://my-mac.ts.net:3456"). Empty string means "this server". */
  url: string
  reachability: Record<string, HostReachability>
  error: string | null
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
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* drop */ }
}

function labelFor(url: string): string {
  try { return new URL(url).hostname.split('.')[0] || url } catch { return url }
}

function describeFailure(url: string, err: unknown): string {
  const e = err as { name?: string }
  if (e?.name === 'TimeoutError') return 'No answer from that host.'
  if (/localhost|127\.0\.0\.1|^https?:\/\/\d/.test(url)) {
    return "localhost and IP addresses can't be verified over HTTPS — use the machine's tailnet name, like https://my-mac.your-tailnet.ts.net:3456"
  }
  return 'Could not reach it — check the URL is https and its certificate is valid.'
}

export function useClipsHost(): UseClipsHostResult {
  const [hosts, setHosts] = useState<ClipsHost[]>(() => read<ClipsHost[]>(HOSTS_KEY, []))
  const [selected, setSelected] = useState<string | null>(() => read<string | null>(SELECTED_KEY, null))
  const [reachability, setReachability] = useState<Record<string, HostReachability>>({})
  const [error, setError] = useState<string | null>(null)

  const probeOne = useCallback(async (url: string): Promise<boolean> => {
    setReachability(r => ({ ...r, [url]: 'checking' }))
    try {
      // Any Orka server exposes /api/health. If the clips endpoints aren't
      // available there, the user will see that when they try to upload —
      // keeping the probe generic avoids false-negatives on older servers.
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setReachability(r => ({ ...r, [url]: 'ok' }))
      return true
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

  useEffect(() => {
    if (!selected) return
    void (async () => {
      const ok = await probeOne(selected)
      if (!ok) {
        setSelected(null)
        write(SELECTED_KEY, null)
        setError('That host stopped answering, so clips are back on this server.')
      }
    })()
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
