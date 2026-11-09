import { useEffect, useMemo, useRef, useState } from 'react'
import { Pin, Smartphone, Tablet, Monitor, HardDrive, HelpCircle } from 'lucide-react'
import { api, type DeckClientPublic, type DeckDevice, type DeckPinPayload } from '../api/client'
import { useDeck } from '../utils/deckClient'
import './pin-to-deck.css'

interface Props {
  /** Favorite row sent to the target client's Stream Deck. The target
   *  writes it to its own `orka-deck-favorites` localStorage and the
   *  Stream Deck page refreshes from there. */
  favorite: DeckPinPayload
  className?: string
  title?: string
}

export function PinToDeckButton({ favorite, className, title }: Props) {
  const deck = useDeck()
  const [restRoster, setRestRoster] = useState<DeckClientPublic[] | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | 'all' | null>(null)
  const [status, setStatus] = useState<'idle' | 'ok' | 'err'>('idle')
  const [errText, setErrText] = useState<string>('')
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const roster = useMemo(() => {
    const wsList = deck.roster
    const restList = restRoster || []
    const merged = new Map<string, DeckClientPublic>()
    for (const c of restList) merged.set(c.clientId, c)
    for (const c of wsList) merged.set(c.clientId, c)
    return [...merged.values()].filter((c) => !c.self && c.clientId !== deck.clientId)
  }, [deck.roster, deck.clientId, restRoster])

  useEffect(() => {
    if (!open) return
    let stopped = false
    const pull = async () => {
      try {
        const res = await api.getDeckClients()
        if (!stopped) setRestRoster(res.clients)
      } catch { /* drop */ }
    }
    void pull()
    const iv = window.setInterval(pull, 3000)
    return () => { stopped = true; window.clearInterval(iv) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pinTo = async (clientId: string | 'all') => {
    setBusy(clientId)
    setStatus('idle')
    setErrText('')
    try {
      const targets = clientId === 'all' ? roster.map((c) => c.clientId) : [clientId]
      if (targets.length === 0) throw new Error('No reachable Stream Deck clients')
      await Promise.all(targets.map((id) =>
        api.sendDeckCommand(id, { type: 'pin', favorite }),
      ))
      setStatus('ok')
      window.setTimeout(() => setOpen(false), 650)
    } catch (err: any) {
      setStatus('err')
      setErrText(err?.message || 'Failed to pin')
    } finally {
      setBusy(null)
    }
  }

  const hasClients = roster.length > 0
  const buttonTitle = title
    || (hasClients ? 'Pin to Stream Deck' : 'No Stream Deck clients registered')

  return (
    <div className={`pin-to-deck ${className || ''}`} ref={wrapRef}>
      <button
        className={`pin-to-deck-trigger ${open ? 'open' : ''} ${status === 'ok' ? 'ok' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={buttonTitle}
        aria-label="Pin to Stream Deck"
        disabled={!hasClients && !open}
      >
        <Pin size={14} />
      </button>
      {open && (
        <div className="pin-to-deck-pop" role="menu">
          <div className="pin-to-deck-pop-head">
            Pin to Stream Deck
          </div>
          {!hasClients && (
            <div className="pin-to-deck-empty">
              No other Stream Deck clients are registered. Open Orka in
              another device / tab and tap Register.
            </div>
          )}
          {hasClients && (
            <>
              <button
                className="pin-to-deck-opt"
                onClick={() => void pinTo('all')}
                disabled={busy !== null}
                role="menuitem"
              >
                <span className="pin-to-deck-icon"><HelpCircle size={14} /></span>
                <span className="pin-to-deck-opt-label">
                  All clients
                  <span className="pin-to-deck-opt-sub">{roster.length} registered</span>
                </span>
                {busy === 'all' && <span className="pin-to-deck-dot" />}
              </button>
              <div className="pin-to-deck-sep" />
              {roster.map((c) => (
                <button
                  key={c.clientId}
                  className="pin-to-deck-opt"
                  onClick={() => void pinTo(c.clientId)}
                  disabled={busy !== null}
                  role="menuitem"
                >
                  <span className="pin-to-deck-icon">{deckIcon(c.device)}</span>
                  <span className="pin-to-deck-opt-label">
                    {c.name}
                    <span className="pin-to-deck-opt-sub">{c.device}</span>
                  </span>
                  {busy === c.clientId && <span className="pin-to-deck-dot" />}
                </button>
              ))}
            </>
          )}
          {status === 'err' && (
            <div className="pin-to-deck-err">{errText}</div>
          )}
        </div>
      )}
    </div>
  )
}

function deckIcon(device: DeckDevice) {
  switch (device) {
    case 'iphone': return <Smartphone size={14} />
    case 'ipad': return <Tablet size={14} />
    case 'mac': return <Monitor size={14} />
    case 'linux':
    case 'windows': return <HardDrive size={14} />
    default: return <HelpCircle size={14} />
  }
}
