import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, Mic, Pause, RefreshCw, Loader2, AlertCircle,
  Gauge, Zap, Clock, Hourglass, Sparkles, Check,
} from 'lucide-react'
import { api, type PacePassage, type PaceDrillResult } from '../api/client'
import { useClipsHost } from '../hooks/useClipsHost'
import '../styles/articulation.css'

type View =
  | { kind: 'home' }
  | { kind: 'pace' }
  | { kind: 'tongue' }
  | { kind: 'pause' }

interface Props {
  onBack: () => void
}

export function ArticulationDrills({ onBack }: Props) {
  const [view, setView] = useState<View>({ kind: 'home' })

  if (view.kind === 'home') {
    return <DrillHome onBack={onBack} onPick={(v) => setView(v)} />
  }
  if (view.kind === 'pace') {
    return <PaceDrillView onBack={() => setView({ kind: 'home' })} />
  }
  if (view.kind === 'tongue') {
    return <ComingSoonView
      title="Tongue twisters"
      onBack={() => setView({ kind: 'home' })}
      icon={<Zap size={24} />}
      description={
        'A catalog of graded twisters. The coach says one at the right pace, you repeat it, '
        + 'Whisper transcribes you and we diff against the original — same mechanic as Shadowing '
        + 'but with built-in texts, so you can drill clarity any time without needing a clip.'
      }
    />
  }
  return <ComingSoonView
    title="Pause drill"
    onBack={() => setView({ kind: 'home' })}
    icon={<Hourglass size={24} />}
    description={
      "Jefferson Fisher's 3-second pause before you reply. The coach asks a question, we measure "
      + 'the silence before your first word using Whisper segment timestamps, and show you whether '
      + 'you held the pause or jumped in. Builds the habit of landing a beat before you speak.'
    }
  />
}

/* ---------------- Home: 3 drills + back ---------------- */

function DrillHome({ onBack, onPick }: {
  onBack: () => void
  onPick: (v: View) => void
}) {
  return (
    <div className="ad-home">
      <header className="ad-topbar">
        <button className="ad-back-btn" onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </button>
        <div className="ad-topbar-text">
          <div className="ad-topbar-title">Articulation</div>
          <div className="ad-topbar-subtitle">Short drills that sharpen one dimension at a time.</div>
        </div>
      </header>

      <div className="ad-drill-grid">
        <DrillCard
          icon={<Gauge size={22} />}
          title="Pace drill"
          desc="Read a short passage at a target WPM. We measure your delivered pace and tell you to speed up, slow down, or hold steady."
          onClick={() => onPick({ kind: 'pace' })}
          tint="mint"
        />
        <DrillCard
          icon={<Zap size={22} />}
          title="Tongue twisters"
          desc="Daily reps for the face/tongue/lip muscles. A catalog of graded twisters, Shadow-style grading. Coming soon."
          onClick={() => onPick({ kind: 'tongue' })}
          tint="amber"
          badge="Coming soon"
        />
        <DrillCard
          icon={<Hourglass size={22} />}
          title="Pause drill"
          desc="Build the habit of a 3-second pause before you reply. The coach asks, you hold, we measure. Coming soon."
          onClick={() => onPick({ kind: 'pause' })}
          tint="purple"
          badge="Coming soon"
        />
      </div>
    </div>
  )
}

function DrillCard({ icon, title, desc, onClick, tint, badge }: {
  icon: React.ReactNode
  title: string
  desc: string
  onClick: () => void
  tint: 'mint' | 'amber' | 'purple'
  badge?: string
}) {
  return (
    <button
      className={`ad-drill ad-drill-${tint}${badge ? ' ad-drill-skeleton' : ''}`}
      onClick={onClick}
    >
      <div className={`ad-drill-icon ad-drill-icon-${tint}`}>{icon}</div>
      <div className="ad-drill-head">
        <span className="ad-drill-title">{title}</span>
        {badge && <span className="ad-drill-badge">{badge}</span>}
      </div>
      <div className="ad-drill-desc">{desc}</div>
    </button>
  )
}

/* ---------------- Coming-soon placeholder ---------------- */

function ComingSoonView({ title, icon, description, onBack }: {
  title: string
  icon: React.ReactNode
  description: string
  onBack: () => void
}) {
  return (
    <div className="ad-mode-view">
      <TopBar title={title} onBack={onBack} />
      <div className="ad-coming-soon">
        <div className="ad-coming-icon">{icon}</div>
        <div className="ad-coming-badge">Coming soon</div>
        <p className="ad-coming-desc">{description}</p>
        <p className="ad-coming-hint">
          The skeleton is wired — the backend hook and this view are in place; the drill logic
          will land in a follow-up iteration.
        </p>
      </div>
    </div>
  )
}

function TopBar({ title, onBack, subtitle }: { title: string; onBack: () => void; subtitle?: string }) {
  return (
    <header className="ad-topbar">
      <button className="ad-back-btn" onClick={onBack}>
        <ArrowLeft size={14} /> Back
      </button>
      <div className="ad-topbar-text">
        <div className="ad-topbar-title">{title}</div>
        {subtitle && <div className="ad-topbar-subtitle">{subtitle}</div>}
      </div>
    </header>
  )
}

/* ---------------- Pace drill (functional) ---------------- */

const PACE_TARGETS = [
  { wpm: 120, label: 'Slow', hint: 'Conversational — presentations' },
  { wpm: 140, label: 'Steady', hint: 'Target for most meetings' },
  { wpm: 160, label: 'Fast', hint: 'Lively — small talk' },
]

function PaceDrillView({ onBack }: { onBack: () => void }) {
  const clipsHost = useClipsHost()
  const [passages, setPassages] = useState<PacePassage[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [targetWpm, setTargetWpm] = useState<number>(140)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState<number>(0)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<PaceDrillResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const tickRef = useRef<number | null>(null)
  const startedAtRef = useRef<number>(0)

  const selected = useMemo(
    () => (passages && selectedId ? passages.find((p) => p.id === selectedId) || null : null),
    [passages, selectedId]
  )

  useEffect(() => {
    let cancelled = false
    api.listPacePassages(clipsHost.url)
      .then((list) => { if (!cancelled) setPassages(list) })
      .catch((err) => { if (!cancelled) setLoadErr(err?.message || 'could not load passages') })
    return () => { cancelled = true }
  }, [clipsHost.url])

  const targetSeconds = useMemo(() => {
    if (!selected || targetWpm <= 0) return 0
    return Math.round((selected.wordCount / targetWpm) * 60 * 10) / 10
  }, [selected, targetWpm])

  const stopTicker = () => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current)
      tickRef.current = null
    }
  }

  useEffect(() => () => stopTicker(), [])

  const start = useCallback(async () => {
    if (!selected) return
    setError(null); setResult(null); setElapsed(0)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunksRef.current = []
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      mr.onstop = async () => {
        stopTicker()
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
        setSubmitting(true)
        try {
          const r = await api.submitPaceDrill(
            { passageId: selected.id, targetWpm, audio: blob },
            clipsHost.url,
          )
          setResult(r)
        } catch (err: any) {
          setError(err?.message || 'submit failed')
        } finally {
          setSubmitting(false)
        }
      }
      recorderRef.current = mr
      mr.start()
      startedAtRef.current = Date.now()
      tickRef.current = window.setInterval(() => {
        setElapsed(Math.round((Date.now() - startedAtRef.current) / 100) / 10)
      }, 100)
      setRecording(true)
    } catch (err: any) {
      setError(err?.message || 'microphone denied')
    }
  }, [selected, targetWpm, clipsHost.url])

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.stop()
    }
    setRecording(false)
  }, [])

  return (
    <div className="ad-mode-view">
      <TopBar title="Pace drill" onBack={onBack} subtitle="Read a passage at a target speed." />

      {loadErr && <div className="ad-error-banner"><AlertCircle size={14} /> {loadErr}</div>}

      <section className="ad-pace-config">
        <div className="ad-section-title">Target pace</div>
        <div className="ad-target-row">
          {PACE_TARGETS.map((t) => (
            <button
              key={t.wpm}
              className={`ad-target-chip${targetWpm === t.wpm ? ' ad-target-chip-active' : ''}`}
              onClick={() => setTargetWpm(t.wpm)}
              title={t.hint}
            >
              <span className="ad-target-wpm">{t.wpm}</span>
              <span className="ad-target-unit">WPM</span>
              <span className="ad-target-label">{t.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="ad-pace-config">
        <div className="ad-section-title">Pick a passage</div>
        {passages === null && !loadErr && (
          <div className="ad-empty"><Loader2 size={14} className="ad-spin" /> Loading…</div>
        )}
        {passages && (
          <ul className="ad-passage-list">
            {passages.map((p) => {
              const estSec = Math.round((p.wordCount / targetWpm) * 60)
              return (
                <li
                  key={p.id}
                  className={`ad-passage-row${selectedId === p.id ? ' ad-passage-row-active' : ''}`}
                  onClick={() => { setSelectedId(p.id); setResult(null); setError(null) }}
                >
                  <div className="ad-passage-dot" />
                  <div className="ad-passage-body">
                    <div className="ad-passage-title">{p.title}</div>
                    <div className="ad-passage-meta">
                      <span className="ad-passage-chip">{p.category}</span>
                      <span>{p.wordCount} words · ~{estSec}s at {targetWpm}</span>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {selected && (
        <>
          <section className="ad-passage-text">
            <div className="ad-section-title">Read this out loud</div>
            <p>{selected.text}</p>
          </section>

          <div className="ad-pace-timer-row">
            <div className="ad-pace-timer">
              <Clock size={14} />
              <span className="ad-pace-timer-value">
                {recording ? `${elapsed.toFixed(1)}s` : (result ? `${result.durationSec}s` : '0.0s')}
              </span>
              <span className="ad-pace-timer-target">target ~{targetSeconds}s</span>
            </div>
            {!recording && !submitting && (
              <button className="ad-primary-btn" onClick={start}>
                <Mic size={14} /> {result ? 'Try again' : 'Record attempt'}
              </button>
            )}
            {recording && (
              <button className="ad-danger-btn" onClick={stop}>
                <Pause size={14} /> Stop & score
              </button>
            )}
            {submitting && (
              <span className="ad-empty-inline">
                <Loader2 size={14} className="ad-spin" /> Scoring…
              </span>
            )}
          </div>
        </>
      )}

      {error && <div className="ad-error-banner"><AlertCircle size={14} /> {error}</div>}

      {result && <PaceResult result={result} />}
    </div>
  )
}

function PaceResult({ result }: { result: PaceDrillResult }) {
  const bandColor = result.band === 'on-target' ? 'ok' : (
    result.band === 'too-slow' || result.band === 'too-fast' ? 'bad' : 'warn'
  )
  // Scale the two bars against a shared max so the eye reads deltas easily.
  const max = Math.max(result.userWpm, result.targetWpm, 1) * 1.15
  const userPct = (result.userWpm / max) * 100
  const targetPct = (result.targetWpm / max) * 100

  return (
    <section className="ad-pace-result">
      <div className="ad-section-title">Result</div>
      <div className={`ad-pace-badge ad-pace-badge-${bandColor}`}>
        {result.band === 'on-target' ? <Check size={14} /> : <Sparkles size={14} />}
        {result.band.replace('-', ' ')}
      </div>

      <div className="ad-wpm-bars">
        <div className="ad-wpm-row">
          <span className="ad-wpm-label">You</span>
          <div className="ad-wpm-track">
            <div className={`ad-wpm-fill ad-wpm-fill-${bandColor}`} style={{ width: `${userPct}%` }} />
          </div>
          <span className="ad-wpm-value">{result.userWpm}</span>
        </div>
        <div className="ad-wpm-row">
          <span className="ad-wpm-label">Target</span>
          <div className="ad-wpm-track">
            <div className="ad-wpm-fill ad-wpm-fill-target" style={{ width: `${targetPct}%` }} />
          </div>
          <span className="ad-wpm-value">{result.targetWpm}</span>
        </div>
      </div>

      <p className="ad-pace-note">{result.note}</p>

      <div className="ad-pace-detail">
        <div className="ad-section-title">You said</div>
        <p>{result.userTranscript || '(nothing heard)'}</p>
        <div className="ad-pace-stats">
          {result.coverage}% of passage delivered · {result.durationSec}s
        </div>
      </div>
    </section>
  )
}
