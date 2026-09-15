import { useCallback, useEffect, useState } from 'react'

/**
 * Borrow another machine's speech models for the voice agent.
 *
 * Opening a remote Orka from a laptop that also runs Orka means whisper
 * and Kokoro run on the remote host, even though the laptop is sitting
 * there idle with the same models installed. This lets the browser send
 * its audio to the LOCAL host instead — the conversation, the sessions
 * and the terminals stay remote, where they belong; only the voice
 * moves.
 *
 * Off by default, and only offered when a local host actually answers:
 * a phone has no Orka to borrow, and silently failing over to a machine
 * that isn't there would just break the microphone.
 *
 * The URL is configurable because the browser cannot discover its own
 * machine's address. `localhost` is the obvious default and usually the
 * wrong one over HTTPS — a Tailscale certificate is issued for the
 * host's tailnet name, so `https://localhost` fails hostname
 * verification. Plain `http://localhost` is blocked outright as mixed
 * content from an HTTPS page. The working answer is the machine's own
 * tailnet hostname.
 */

const ENABLED_KEY = 'orka.voice.localHost.enabled'
const URL_KEY = 'orka.voice.localHost.url'

export interface LocalVoiceHost {
  /** A reachable local host with speech models, or null. */
  available: boolean
  /** Whether the user turned it on (only meaningful when available). */
  enabled: boolean
  /** Base URL to send speech work to, e.g. https://my-mac.tailnet.ts.net:3456 */
  url: string
  probing: boolean
  error: string | null
  setEnabled: (on: boolean) => void
  setUrl: (url: string) => void
  /** Re-probe after the user edits the URL. */
  probe: () => Promise<void>
}

function readStoredUrl(): string {
  try {
    const saved = localStorage.getItem(URL_KEY)
    if (saved) return saved
  } catch { /* blocked storage */ }
  return 'https://localhost:3456'
}

export function useLocalVoiceHost(): LocalVoiceHost {
  const [url, setUrlState] = useState(readStoredUrl)
  const [enabled, setEnabledState] = useState(() => {
    try { return localStorage.getItem(ENABLED_KEY) === '1' } catch { return false }
  })
  const [available, setAvailable] = useState(false)
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const probe = useCallback(async () => {
    const base = url.replace(/\/+$/, '')
    // Pointing "local" at the page's own origin is a no-op dressed up as
    // a feature — say so instead of pretending it worked.
    if (base === window.location.origin) {
      setAvailable(false)
      setError('That is this server. Point it at your own machine instead.')
      return
    }
    setProbing(true)
    setError(null)
    try {
      const res = await fetch(`${base}/api/voice/capabilities`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const caps = await res.json()
      setAvailable(!!caps.tts)
      if (!caps.tts) setError('That host has no speech models installed.')
    } catch (err: any) {
      setAvailable(false)
      // The common causes are worth naming: an expired or mismatched
      // certificate and a plain-HTTP host both surface as one opaque
      // "failed to fetch", and the user cannot act on that.
      setError(
        err?.name === 'TimeoutError'
          ? 'No answer from that host.'
          : 'Could not reach it — check the URL is https and its certificate is valid.'
      )
    } finally {
      setProbing(false)
    }
  }, [url])

  useEffect(() => { void probe() }, [probe])

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on)
    try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0') } catch { /* blocked */ }
  }, [])

  const setUrl = useCallback((next: string) => {
    setUrlState(next)
    try { localStorage.setItem(URL_KEY, next) } catch { /* blocked */ }
  }, [])

  return {
    available,
    enabled: enabled && available,
    url: url.replace(/\/+$/, ''),
    probing,
    error,
    setEnabled,
    setUrl,
    probe,
  }
}
