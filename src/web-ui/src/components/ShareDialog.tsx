import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type Share } from '../api/client'
import { X, Copy, Check, Trash2, Clock, Globe, PowerOff, Loader2 } from 'lucide-react'
import './share-dialog.css'

interface TunnelState {
  running: boolean
  url?: string
  error?: string
}

interface Props {
  projectPath: string
  filePath: string
  onClose: () => void
}

const TTL_PRESETS: Array<{ label: string; ms: number }> = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '2 days', ms: 2 * 24 * 60 * 60 * 1000 },
  { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
]

export function ShareDialog({ projectPath, filePath, onClose }: Props) {
  const [ttlMs, setTtlMs] = useState<number>(TTL_PRESETS[2].ms)
  const [allowComments, setAllowComments] = useState(true)
  const [allowAsk, setAllowAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sharePort, setSharePort] = useState<number>(0)
  const [shareProto, setShareProto] = useState<'http' | 'https'>('http')
  const [shares, setShares] = useState<Share[]>([])
  const [latestId, setLatestId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [tunnel, setTunnel] = useState<TunnelState>({ running: false })
  const [tunnelBusy, setTunnelBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      const list = await api.listShares(projectPath)
      setShares(list)
    } catch (err: any) {
      setError(err?.message || 'Could not load shares')
    }
  }, [projectPath])

  useEffect(() => {
    void reload()
    void api.getShareServerInfo().then((info) => {
      setSharePort(info.port)
      setShareProto(info.protocol)
    }).catch(() => {})
    void api.getShareTunnel().then(setTunnel).catch(() => {})
  }, [reload])

  const filteredShares = useMemo(
    () => shares.filter((s) => s.filePath === filePath),
    [shares, filePath],
  )

  const shareBase = useMemo(() => {
    if (tunnel.running && tunnel.url) return tunnel.url.replace(/\/$/, '') + '/s/'
    if (!sharePort) return ''
    return `${shareProto}://${window.location.hostname}:${sharePort}/s/`
  }, [sharePort, shareProto, tunnel])

  const startTunnel = async () => {
    setTunnelBusy(true)
    setError(null)
    try {
      const state = await api.startShareTunnel()
      setTunnel(state)
    } catch (err: any) {
      setError(err?.message || 'Tunnel failed to start')
    } finally {
      setTunnelBusy(false)
    }
  }

  const stopTunnel = async () => {
    setTunnelBusy(true)
    try {
      await api.stopShareTunnel()
      setTunnel({ running: false })
    } catch (err: any) {
      setError(err?.message || 'Tunnel stop failed')
    } finally {
      setTunnelBusy(false)
    }
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const share = await api.createShare(projectPath, {
        filePath,
        ttlMs,
        allowComments,
        allowAsk,
      })
      setLatestId(share.id)
      await reload()
    } catch (err: any) {
      setError(err?.message || 'Share creation failed')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    if (!confirm('Revoke this share? The link will stop working immediately.')) return
    try {
      await api.revokeShare(projectPath, id)
      await reload()
    } catch (err: any) {
      setError(err?.message || 'Revoke failed')
    }
  }

  const copyUrl = async (share: Share) => {
    if (!shareBase) return
    const url = shareBase + share.token + '/view'
    try {
      await navigator.clipboard.writeText(url)
      setCopiedId(share.id)
      window.setTimeout(() => setCopiedId((prev) => (prev === share.id ? null : prev)), 1500)
    } catch {
      setError('Clipboard blocked by browser')
    }
  }

  return createPortal(
    <div className="share-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="share-dialog" role="dialog" aria-modal="true">
        <header>
          <div>
            <h2>Share for review</h2>
            <div className="share-dialog-subtitle">{filePath}</div>
          </div>
          <button className="share-dialog-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <section className="share-dialog-section">
          <label className="share-dialog-label">Expires after</label>
          <div className="share-dialog-ttl">
            {TTL_PRESETS.map((p) => (
              <button
                key={p.ms}
                type="button"
                className={`share-ttl-chip ${ttlMs === p.ms ? 'active' : ''}`}
                onClick={() => setTtlMs(p.ms)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <label className="share-dialog-label">Reviewer can</label>
          <div className="share-dialog-toggles">
            <label className="share-dialog-toggle">
              <input
                type="checkbox"
                checked={allowComments}
                onChange={(e) => setAllowComments(e.target.checked)}
              />
              <span>Leave comments</span>
            </label>
            <label className="share-dialog-toggle">
              <input
                type="checkbox"
                checked={allowAsk}
                onChange={(e) => setAllowAsk(e.target.checked)}
              />
              <span>Ask questions (uses your Claude)</span>
            </label>
          </div>

          <div className="share-dialog-actions">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={busy || !allowComments} onClick={create}>
              {busy ? 'Creating…' : 'Create share link'}
            </button>
          </div>
          {error && <div className="share-dialog-error">{error}</div>}
        </section>

        <section className="share-dialog-section">
          <label className="share-dialog-label">Public tunnel</label>
          <div className={`share-tunnel-panel ${tunnel.running ? 'on' : 'off'}`}>
            <div className="share-tunnel-info">
              <span className={`share-tunnel-dot ${tunnel.running ? 'on' : 'off'}`} />
              {tunnel.running && tunnel.url ? (
                <code className="share-tunnel-url" title={tunnel.url}>{tunnel.url}</code>
              ) : (
                <span className="share-tunnel-hint">
                  Links only work on your device until you open a public tunnel.
                </span>
              )}
            </div>
            <div className="share-tunnel-actions">
              {tunnel.running ? (
                <button className="btn-ghost" onClick={stopTunnel} disabled={tunnelBusy}>
                  <PowerOff size={13} /> {tunnelBusy ? 'Stopping…' : 'Stop tunnel'}
                </button>
              ) : (
                <button className="btn-primary" onClick={startTunnel} disabled={tunnelBusy}>
                  {tunnelBusy ? <Loader2 size={13} className="spin" /> : <Globe size={13} />}
                  {tunnelBusy ? 'Starting…' : 'Start public tunnel'}
                </button>
              )}
            </div>
          </div>
        </section>

        {filteredShares.length > 0 && (
          <section className="share-dialog-section">
            <label className="share-dialog-label">
              Active shares for this file
              {!sharePort && <span className="share-dialog-port-warn"> · share server offline</span>}
            </label>
            <ul className="share-dialog-list">
              {filteredShares.map((share) => {
                const url = shareBase ? shareBase + share.token + '/view' : ''
                const isLatest = share.id === latestId
                const remainingMs = Math.max(0, new Date(share.expiresAt).getTime() - Date.now())
                return (
                  <li key={share.id} className={`share-row ${isLatest ? 'highlight' : ''}`}>
                    <div className="share-row-top">
                      <code className="share-row-url">{url || '(share server offline)'}</code>
                      <div className="share-row-actions">
                        <button className="share-row-btn" onClick={() => copyUrl(share)} title="Copy link" disabled={!url}>
                          {copiedId === share.id ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                        <button className="share-row-btn danger" onClick={() => revoke(share.id)} title="Revoke">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="share-row-meta">
                      <span><Clock size={11} /> {humanRemaining(remainingMs)}</span>
                      <span>
                        {share.options.allowComments ? 'comments' : 'read-only'}
                        {share.options.allowAsk ? ' · ask' : ''}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </div>,
    document.body,
  )
}

function humanRemaining(ms: number): string {
  if (ms <= 0) return 'expired'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m left`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m left`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h left`
}
