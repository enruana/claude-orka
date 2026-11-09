import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, Upload, Trash2, RefreshCw, Loader2, AlertCircle,
  BookOpen, SquareStack, Mic, FileText, Check, X,
  Play, Pause, PenTool, Sparkles, Server, Wifi, WifiOff, Plus,
} from 'lucide-react'
import {
  api,
  type ClipSegment,
  type EnglishClip,
  type VocabCard,
  type ClozeResult,
  type ShadowDiffResult,
  type SummaryGradeResult,
} from '../api/client'
import { useClipsHost, type UseClipsHostResult } from '../hooks/useClipsHost'
import '../styles/english-clips.css'

const ClipsHostContext = createContext<string>('')
const useHost = () => useContext(ClipsHostContext)

type View =
  | { kind: 'library' }
  | { kind: 'detail'; clipId: string }
  | { kind: 'vocab'; clipId: string }
  | { kind: 'cloze'; clipId: string }
  | { kind: 'shadow'; clipId: string }
  | { kind: 'summary'; clipId: string }

interface Props {
  onBack: () => void
  onLaunchSession: (opts: { clipId: string; mode: 'discuss' | 'standup-replay' }) => void
}

export function EnglishClips({ onBack, onLaunchSession }: Props) {
  const clipsHost = useClipsHost()
  const [view, setView] = useState<View>({ kind: 'library' })
  const [clips, setClips] = useState<EnglishClip[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const list = await api.listEnglishClips(clipsHost.url)
      setClips(list)
    } catch (err: any) {
      setError(err?.message || 'could not load clips')
      setClips([])
    }
  }, [clipsHost.url])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    if (view.kind !== 'library') return
    const hasTranscribing = clips?.some((c) => c.status === 'transcribing')
    if (!hasTranscribing) return
    const iv = window.setInterval(() => { void reload() }, 3500)
    return () => window.clearInterval(iv)
  }, [view, clips, reload])

  const activeClip = useMemo(() => {
    if (view.kind === 'library') return null
    return clips?.find((c) => c.id === view.clipId) || null
  }, [view, clips])

  let inner: React.ReactNode
  if (view.kind === 'library') {
    inner = (
      <ClipLibrary
        clips={clips}
        error={error}
        onBack={onBack}
        onOpen={(id) => setView({ kind: 'detail', clipId: id })}
        onReload={reload}
        onError={setError}
        clipsHost={clipsHost}
      />
    )
  } else if (!activeClip) {
    inner = (
      <div className="ec-detail">
        <TopBar onBack={() => setView({ kind: 'library' })} title="Clip not found" />
        <div className="ec-error-banner"><AlertCircle size={14} /> This clip was removed.</div>
      </div>
    )
  } else if (view.kind === 'detail') {
    inner = (
      <ClipDetail
        clip={activeClip}
        remoteHost={clipsHost.enabled}
        onBack={() => setView({ kind: 'library' })}
        onPickMode={(kind) => {
          if (kind === 'discuss' || kind === 'standup-replay') {
            // Voice-live co-locates with the serving host; a clip on a
            // remote host can't be attached. The picker UI already
            // disables these buttons when enabled; this guard is here
            // as a second line of defense.
            if (clipsHost.enabled) return
            onLaunchSession({ clipId: activeClip.id, mode: kind })
          } else {
            setView({ kind, clipId: activeClip.id })
          }
        }}
        onReload={reload}
      />
    )
  } else if (view.kind === 'vocab') {
    inner = <VocabView clip={activeClip} onBack={() => setView({ kind: 'detail', clipId: activeClip.id })} />
  } else if (view.kind === 'cloze') {
    inner = <ClozeView clip={activeClip} onBack={() => setView({ kind: 'detail', clipId: activeClip.id })} />
  } else if (view.kind === 'shadow') {
    inner = <ShadowView clip={activeClip} onBack={() => setView({ kind: 'detail', clipId: activeClip.id })} />
  } else {
    inner = <SummaryView clip={activeClip} onBack={() => setView({ kind: 'detail', clipId: activeClip.id })} />
  }
  return (
    <ClipsHostContext.Provider value={clipsHost.url}>
      {inner}
    </ClipsHostContext.Provider>
  )
}

function TopBar({ onBack, title, subtitle }: { onBack: () => void; title: string; subtitle?: string }) {
  return (
    <header className="ec-topbar">
      <button className="ec-back-btn" onClick={onBack}>
        <ArrowLeft size={14} /> Back
      </button>
      <div className="ec-topbar-text">
        <div className="ec-topbar-title">{title}</div>
        {subtitle && <div className="ec-topbar-subtitle">{subtitle}</div>}
      </div>
    </header>
  )
}

/* ---------------- Library ---------------- */

function ClipLibrary({
  clips, error, onBack, onOpen, onReload, onError, clipsHost,
}: {
  clips: EnglishClip[] | null
  error: string | null
  onBack: () => void
  onOpen: (id: string) => void
  onReload: () => void
  onError: (e: string | null) => void
  clipsHost: UseClipsHostResult
}) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const upload = useCallback(async (file: File) => {
    setUploading(true)
    onError(null)
    try {
      const name = file.name.replace(/\.[^.]+$/, '')
      await api.uploadEnglishClip(file, name, clipsHost.url)
      await onReload()
    } catch (err: any) {
      onError(err?.message || 'upload failed')
    } finally {
      setUploading(false)
    }
  }, [onReload, onError, clipsHost.url])

  return (
    <div className="ec-library">
      <TopBar onBack={onBack} title="Clips" subtitle="Your audio library for listening practice" />

      <ClipsHostPicker clipsHost={clipsHost} />

      <div className="ec-library-actions">
        <button
          className="ec-upload-btn"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading
            ? (<><Loader2 size={14} className="ec-spin" /> Uploading…</>)
            : (<><Upload size={14} /> Upload audio</>)}
        </button>
        <span className="ec-hint">mp3, wav, m4a, ogg, webm — up to 150 MB</span>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload(f)
            e.target.value = ''
          }}
        />
      </div>

      {error && <div className="ec-error-banner"><AlertCircle size={14} /> {error}</div>}

      {clips === null && (
        <div className="ec-empty"><Loader2 size={14} className="ec-spin" /> Loading clips…</div>
      )}

      {clips !== null && clips.length === 0 && (
        <div className="ec-empty">
          No clips yet. Upload a meeting recording, a standup, or any English audio to start practicing.
        </div>
      )}

      {clips !== null && clips.length > 0 && (
        <ul className="ec-clip-list">
          {clips.map((c) => (
            <li key={c.id} className="ec-clip-row">
              <button className="ec-clip-open" onClick={() => onOpen(c.id)}>
                <div className="ec-clip-icon">
                  {c.status === 'transcribing' ? <Loader2 size={16} className="ec-spin" />
                    : c.status === 'failed' ? <AlertCircle size={16} />
                    : <FileText size={16} />}
                </div>
                <div className="ec-clip-body">
                  <div className="ec-clip-name">{c.name}</div>
                  <div className="ec-clip-meta">
                    {formatDuration(c.durationSec)} · {formatBytes(c.bytes)} · {relativeTime(c.createdAt)}
                    {c.status === 'transcribing' && <span className="ec-chip ec-chip-pending"> transcribing…</span>}
                    {c.status === 'failed' && <span className="ec-chip ec-chip-error"> failed</span>}
                  </div>
                  {c.transcript && (
                    <div className="ec-clip-preview">{c.transcript.slice(0, 160)}{c.transcript.length > 160 ? '…' : ''}</div>
                  )}
                </div>
              </button>
              {pendingDelete === c.id ? (
                <div className="ec-row-confirm">
                  <button
                    className="ec-row-confirm-yes"
                    onClick={async () => {
                      try { await api.deleteEnglishClip(c.id, clipsHost.url); setPendingDelete(null); await onReload() }
                      catch (err: any) { onError(err?.message || 'delete failed'); setPendingDelete(null) }
                    }}
                  >Delete</button>
                  <button className="ec-row-confirm-no" onClick={() => setPendingDelete(null)}>
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <button className="ec-row-del" onClick={() => setPendingDelete(c.id)} title="Delete clip">
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ---------------- Clip detail ---------------- */

function ClipDetail({
  clip, onBack, onPickMode, onReload, remoteHost,
}: {
  clip: EnglishClip
  onBack: () => void
  onPickMode: (kind: 'discuss' | 'standup-replay' | 'vocab' | 'cloze' | 'shadow' | 'summary') => void
  onReload: () => void
  remoteHost: boolean
}) {
  const host = useHost()
  const [busy, setBusy] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const { activeIdx, onTimeUpdate, seekTo } = useSegmentFollower(audioRef, clip.segments)
  return (
    <div className="ec-detail">
      <TopBar onBack={onBack} title={clip.name} subtitle={`${formatDuration(clip.durationSec)} · ${relativeTime(clip.createdAt)}`} />

      {clip.hasAudio && (
        <audio
          ref={audioRef}
          className="ec-player"
          controls
          src={api.englishClipAudioUrl(clip.id, host)}
          preload="metadata"
          onTimeUpdate={onTimeUpdate}
        />
      )}

      {clip.status === 'transcribing' && (
        <div className="ec-empty"><Loader2 size={14} className="ec-spin" /> Transcribing… this can take a minute for long clips.</div>
      )}

      {clip.status === 'failed' && (
        <div className="ec-error-banner">
          <AlertCircle size={14} /> Transcription failed: {clip.error || 'unknown error'}.
          <button
            className="ec-inline-btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try { await api.retranscribeEnglishClip(clip.id, host); await onReload() }
              finally { setBusy(false) }
            }}
          >
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {clip.status === 'ready' && (
        <>
          <section className="ec-transcript-wrap">
            <h3 className="ec-section-title">
              Transcript
              {clip.segments && clip.segments.length > 0 && (
                <span className="ec-section-hint"> · tap a line to jump the audio</span>
              )}
            </h3>
            {clip.segments && clip.segments.length > 0 ? (
              <p className="ec-transcript ec-transcript-segmented">
                {clip.segments.map((seg, i) => (
                  <span
                    key={i}
                    data-seg-index={i}
                    className={`ec-seg${i === activeIdx ? ' ec-seg-active' : ''}`}
                    onClick={() => seekTo(seg.start)}
                    title={`${formatTime(seg.start)} → ${formatTime(seg.end)}`}
                  >
                    {seg.text}{' '}
                  </span>
                ))}
              </p>
            ) : (
              <p className="ec-transcript">{clip.transcript || '(empty)'}</p>
            )}
          </section>

          <section className="ec-modes">
            <h3 className="ec-section-title">Practice with this clip</h3>
            <div className="ec-mode-grid">
              <ModeButton icon={<Mic size={18} />} title="Discuss"
                desc="Talk about it with the coach in a voice session."
                onClick={() => onPickMode('discuss')} tint="blue"
                disabled={remoteHost}
                disabledReason="Voice sessions need the clip on this server. Switch host back to 'This server' to use Discuss." />
              <ModeButton icon={<RefreshCw size={18} />} title="Standup replay"
                desc="Re-deliver your own standup with coach feedback."
                onClick={() => onPickMode('standup-replay')} tint="blue"
                disabled={remoteHost}
                disabledReason="Voice sessions need the clip on this server. Switch host back to 'This server' to use Standup replay." />
              <ModeButton icon={<BookOpen size={18} />} title="Vocabulary"
                desc="Mine phrasal verbs, idioms, and useful terms."
                onClick={() => onPickMode('vocab')} tint="amber" />
              <ModeButton icon={<SquareStack size={18} />} title="Fill-in-the-blank"
                desc="Listen and fill in the missing words."
                onClick={() => onPickMode('cloze')} tint="amber" />
              <ModeButton icon={<PenTool size={18} />} title="Shadowing"
                desc="Repeat a segment and see word-level diff."
                onClick={() => onPickMode('shadow')} tint="purple" />
              <ModeButton icon={<Sparkles size={18} />} title="Oral summary"
                desc="Summarize the clip out loud. Get comprehension + language feedback."
                onClick={() => onPickMode('summary')} tint="purple" />
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function ModeButton({ icon, title, desc, onClick, tint, disabled, disabledReason }: {
  icon: React.ReactNode; title: string; desc: string; onClick: () => void
  tint: 'blue' | 'amber' | 'purple'
  disabled?: boolean; disabledReason?: string
}) {
  return (
    <button
      className={`ec-mode ec-mode-${tint}${disabled ? ' ec-mode-disabled' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
    >
      <div className={`ec-mode-icon ec-mode-icon-${tint}`}>{icon}</div>
      <div className="ec-mode-title">{title}</div>
      <div className="ec-mode-desc">{disabled ? (disabledReason || desc) : desc}</div>
    </button>
  )
}

/* ---------------- Vocab ---------------- */

function VocabView({ clip, onBack }: { clip: EnglishClip; onBack: () => void }) {
  const host = useHost()
  const chunks = useMemo(() => buildChunks(clip), [clip])
  const [chunkIdx, setChunkIdx] = useState<number>(-1)
  const [cards, setCards] = useState<VocabCard[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [knownIdx, setKnownIdx] = useState<Set<number>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setCards(null); setError(null)
    const chunk = chunkIdx >= 0 ? chunks[chunkIdx] : null
    api.mineVocab(clip.id, host, chunk ? { startSec: chunk.start, endSec: chunk.end } : undefined)
      .then((list) => { if (!cancelled) { setCards(list); setLoading(false) } })
      .catch((err) => { if (!cancelled) { setError(err?.message || 'failed'); setLoading(false) } })
    return () => { cancelled = true }
  }, [clip.id, host, chunkIdx, chunks])

  return (
    <div className="ec-mode-view">
      <TopBar onBack={onBack} title="Vocabulary" subtitle={clip.name} />
      <ChunkPicker chunks={chunks} selected={chunkIdx} onSelect={setChunkIdx} />
      {loading && <div className="ec-empty"><Loader2 size={14} className="ec-spin" /> Mining vocabulary…</div>}
      {error && <div className="ec-error-banner"><AlertCircle size={14} /> {error}</div>}
      {!loading && cards?.length === 0 && (
        <div className="ec-empty">Nothing worth teaching found in this clip.</div>
      )}
      {cards && cards.length > 0 && (
        <ol className="ec-vocab-list">
          {cards.map((c, i) => {
            const known = knownIdx.has(i)
            return (
              <li key={i} className={`ec-vocab-card ${known ? 'ec-vocab-card-known' : ''}`}>
                <div className="ec-vocab-head">
                  <span className="ec-vocab-term">{c.term}</span>
                  {c.partOfSpeech && <span className="ec-vocab-pos">{c.partOfSpeech}</span>}
                </div>
                <div className="ec-vocab-def">{c.definition}</div>
                {c.example && <div className="ec-vocab-example">{c.example}</div>}
                {c.sourceLine && (
                  <div className="ec-vocab-source">
                    <span className="ec-vocab-source-label">in the clip</span>
                    {c.sourceLine}
                  </div>
                )}
                <button
                  className="ec-vocab-known"
                  onClick={() => setKnownIdx((prev) => {
                    const next = new Set(prev)
                    if (next.has(i)) next.delete(i); else next.add(i)
                    return next
                  })}
                >
                  {known ? (<><Check size={12} /> Known</>) : 'Mark as known'}
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

/* ---------------- Cloze ---------------- */

function ClozeView({ clip, onBack }: { clip: EnglishClip; onBack: () => void }) {
  const host = useHost()
  const chunks = useMemo(() => buildChunks(clip), [clip])
  // Default: first chunk if any, else whole. Shorter cloze is nicer than a wall of text.
  const [chunkIdx, setChunkIdx] = useState<number>(chunks.length > 1 ? 0 : -1)
  const [data, setData] = useState<ClozeResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [graded, setGraded] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const activeChunk = chunkIdx >= 0 ? chunks[chunkIdx] : null

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setData(null); setAnswers({}); setGraded(false); setError(null)
    api.buildCloze(clip.id, host, activeChunk ? { startSec: activeChunk.start, endSec: activeChunk.end } : undefined)
      .then((r) => { if (!cancelled) { setData(r); setLoading(false) } })
      .catch((err) => { if (!cancelled) { setError(err?.message || 'failed'); setLoading(false) } })
    return () => { cancelled = true }
  }, [clip.id, host, chunkIdx, activeChunk])

  // When a chunk is selected, make the audio player cue to that range.
  useEffect(() => {
    if (!activeChunk || !audioRef.current) return
    try { audioRef.current.currentTime = activeChunk.start } catch { /* drop */ }
  }, [activeChunk])

  const pieces = useMemo(() => {
    if (!data) return [] as Array<{ kind: 'text' | 'blank'; value: string; idx?: number }>
    const re = /\{\{(\d+)\}\}/g
    const out: Array<{ kind: 'text' | 'blank'; value: string; idx?: number }> = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(data.text)) !== null) {
      if (m.index > last) out.push({ kind: 'text', value: data.text.slice(last, m.index) })
      out.push({ kind: 'blank', value: '', idx: parseInt(m[1], 10) })
      last = re.lastIndex
    }
    if (last < data.text.length) out.push({ kind: 'text', value: data.text.slice(last) })
    return out
  }, [data])

  const check = (expected: string, got: string): boolean => {
    const n = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, '').trim()
    return n(expected) === n(got)
  }

  return (
    <div className="ec-mode-view">
      <TopBar onBack={onBack} title="Fill in the blank" subtitle={clip.name} />
      <ChunkPicker chunks={chunks} selected={chunkIdx} onSelect={setChunkIdx} />
      {clip.hasAudio && (
        <audio
          ref={audioRef}
          className="ec-player"
          controls
          src={api.englishClipAudioUrl(clip.id, host)}
          preload="metadata"
        />
      )}
      {loading && <div className="ec-empty"><Loader2 size={14} className="ec-spin" /> Preparing the exercise…</div>}
      {error && <div className="ec-error-banner"><AlertCircle size={14} /> {error}</div>}
      {data && (
        <>
          <p className="ec-cloze-text">
            {pieces.map((p, i) => {
              if (p.kind === 'text') return <span key={i}>{p.value}</span>
              const blank = data.blanks.find((b) => b.idx === p.idx)
              const answer = answers[p.idx!] || ''
              const ok = graded && blank ? check(blank.answer, answer) : null
              return (
                <input
                  key={i}
                  className={`ec-cloze-input ${ok === true ? 'ec-cloze-right' : ok === false ? 'ec-cloze-wrong' : ''}`}
                  value={answer}
                  placeholder={blank?.hint || ''}
                  disabled={graded}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [p.idx!]: e.target.value }))}
                  style={{ width: `${Math.max(8, (blank?.answer.length || 6) + 2)}ch` }}
                />
              )
            })}
          </p>
          <div className="ec-cloze-actions">
            {!graded ? (
              <button className="ec-primary-btn" onClick={() => setGraded(true)}>
                <Check size={14} /> Check answers
              </button>
            ) : (
              <>
                <div className="ec-cloze-score">
                  Score: {data.blanks.filter((b) => check(b.answer, answers[b.idx] || '')).length} / {data.blanks.length}
                </div>
                <button className="ec-secondary-btn" onClick={() => { setAnswers({}); setGraded(false) }}>
                  <RefreshCw size={14} /> Try again
                </button>
              </>
            )}
          </div>
          {graded && (
            <ul className="ec-cloze-review">
              {data.blanks.map((b) => {
                const given = answers[b.idx] || ''
                const ok = check(b.answer, given)
                return (
                  <li key={b.idx} className={ok ? 'ec-cloze-review-ok' : 'ec-cloze-review-bad'}>
                    <span className="ec-cloze-review-badge">{ok ? '✓' : '✗'}</span>
                    <span className="ec-cloze-review-you">{given || '—'}</span>
                    <span className="ec-cloze-review-arrow">→</span>
                    <span className="ec-cloze-review-right">{b.answer}</span>
                    {b.hint && <span className="ec-cloze-review-hint">({b.hint})</span>}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/* ---------------- Shadow ---------------- */

function ShadowView({ clip, onBack }: { clip: EnglishClip; onBack: () => void }) {
  const host = useHost()
  const chunks = useMemo(() => buildChunks(clip), [clip])
  // Shadowing a whole meeting is impractical — default to the first chunk.
  const [chunkIdx, setChunkIdx] = useState<number>(chunks.length > 1 ? 0 : -1)
  const [recording, setRecording] = useState(false)
  const [result, setResult] = useState<ShadowDiffResult | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const activeChunk = chunkIdx >= 0 ? chunks[chunkIdx] : null
  const target = activeChunk ? activeChunk.text : clip.transcript

  // Clear the previous attempt when the user picks a new chunk.
  useEffect(() => {
    setResult(null); setError(null)
    if (activeChunk && audioRef.current) {
      try { audioRef.current.currentTime = activeChunk.start } catch { /* drop */ }
    }
  }, [chunkIdx, activeChunk])

  const start = useCallback(async () => {
    setError(null); setResult(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunksRef.current = []
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
        setSubmitting(true)
        try {
          const r = await api.submitShadow(target, blob, host)
          setResult(r)
        } catch (err: any) {
          setError(err?.message || 'submit failed')
        } finally {
          setSubmitting(false)
        }
      }
      recorderRef.current = mr
      mr.start()
      setRecording(true)
    } catch (err: any) {
      setError(err?.message || 'microphone denied')
    }
  }, [target, host])

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.stop()
    }
    setRecording(false)
  }, [])

  return (
    <div className="ec-mode-view">
      <TopBar onBack={onBack} title="Shadowing" subtitle={clip.name} />
      <ChunkPicker chunks={chunks} selected={chunkIdx} onSelect={setChunkIdx} />
      {clip.hasAudio && (
        <audio
          ref={audioRef}
          className="ec-player"
          controls
          src={api.englishClipAudioUrl(clip.id, host)}
          preload="metadata"
        />
      )}
      {activeChunk && (
        <div className="ec-shadow-target">
          <div className="ec-section-title">Read this section</div>
          <p>{activeChunk.text}</p>
        </div>
      )}
      <div className="ec-shadow-hint">
        Play the section, listen, then hit record and repeat it out loud. Stop when done.
      </div>
      <div className="ec-shadow-actions">
        {!recording && !submitting && (
          <button className="ec-primary-btn" onClick={start}>
            <Mic size={14} /> Record attempt
          </button>
        )}
        {recording && (
          <button className="ec-danger-btn" onClick={stop}>
            <Pause size={14} /> Stop & grade
          </button>
        )}
        {submitting && <span className="ec-empty"><Loader2 size={14} className="ec-spin" /> Scoring…</span>}
      </div>
      {error && <div className="ec-error-banner"><AlertCircle size={14} /> {error}</div>}

      {result && (
        <>
          <div className="ec-shadow-score">
            Match score: <strong>{result.score}%</strong>
          </div>
          <div className="ec-shadow-you">
            <div className="ec-section-title">You said</div>
            <p>{result.userText || '(nothing heard)'}</p>
          </div>
          <div className="ec-shadow-diff">
            <div className="ec-section-title">Diff</div>
            <p>
              {result.diff.tokens.map((t, i) => (
                <span key={i} className={`ec-tok ec-tok-${t.status}`}>
                  {t.status === 'missed' && t.original}
                  {t.status === 'extra' && t.spoken}
                  {t.status === 'match' && t.original}
                  {t.status === 'substituted' && (
                    <>{t.original}<span className="ec-tok-arrow">→</span>{t.spoken}</>
                  )}
                  {' '}
                </span>
              ))}
            </p>
            <div className="ec-shadow-legend">
              <span className="ec-tok ec-tok-match">match</span>
              <span className="ec-tok ec-tok-substituted">substituted</span>
              <span className="ec-tok ec-tok-missed">missed</span>
              <span className="ec-tok ec-tok-extra">extra</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ---------------- Oral summary ---------------- */

function SummaryView({ clip, onBack }: { clip: EnglishClip; onBack: () => void }) {
  const host = useHost()
  const [recording, setRecording] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<SummaryGradeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const start = useCallback(async () => {
    setError(null); setResult(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunksRef.current = []
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
        setSubmitting(true)
        try {
          const r = await api.submitSummary(clip.transcript, blob, host)
          setResult(r)
        } catch (err: any) {
          setError(err?.message || 'submit failed')
        } finally {
          setSubmitting(false)
        }
      }
      recorderRef.current = mr
      mr.start()
      setRecording(true)
    } catch (err: any) {
      setError(err?.message || 'microphone denied')
    }
  }, [clip.transcript, host])

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === 'recording') recorderRef.current.stop()
    setRecording(false)
  }, [])

  return (
    <div className="ec-mode-view">
      <TopBar onBack={onBack} title="Oral summary" subtitle={clip.name} />
      {clip.hasAudio && (
        <audio className="ec-player" controls src={api.englishClipAudioUrl(clip.id, host)} preload="metadata" />
      )}
      <div className="ec-shadow-hint">
        Listen to the clip, then record a summary of what you heard in your own English words.
      </div>
      <div className="ec-shadow-actions">
        {!recording && !submitting && (
          <button className="ec-primary-btn" onClick={start}>
            <Mic size={14} /> Record summary
          </button>
        )}
        {recording && (
          <button className="ec-danger-btn" onClick={stop}>
            <Pause size={14} /> Stop & grade
          </button>
        )}
        {submitting && <span className="ec-empty"><Loader2 size={14} className="ec-spin" /> Grading…</span>}
      </div>
      {error && <div className="ec-error-banner"><AlertCircle size={14} /> {error}</div>}

      {result && (
        <div className="ec-summary-result">
          <div className="ec-summary-you">
            <div className="ec-section-title">You said</div>
            <p>{result.userSummary || '(nothing heard)'}</p>
          </div>
          <div className="ec-summary-scores">
            <div className="ec-summary-score">
              <div className="ec-summary-score-label">Comprehension</div>
              <div className="ec-summary-score-value">{result.comprehensionScore}</div>
              <div className="ec-summary-score-note">{result.comprehensionNote}</div>
            </div>
            <div className="ec-summary-score">
              <div className="ec-summary-score-label">English quality</div>
              <div className="ec-summary-score-value">{result.languageScore}</div>
              <div className="ec-summary-score-note">{result.languageNote}</div>
            </div>
          </div>
          {result.topCorrections.length > 0 && (
            <div className="ec-summary-corrections">
              <div className="ec-section-title">Top corrections</div>
              <ul>
                {result.topCorrections.map((c, i) => (
                  <li key={i}>
                    <div className="ec-summary-corr-diff">
                      <span className="ec-summary-quote">{c.quote}</span>
                      <span className="ec-tok-arrow">→</span>
                      <span className="ec-summary-sug">{c.suggestion}</span>
                    </div>
                    <div className="ec-summary-corr-expl">{c.explanation}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------------- helpers ---------------- */

/* ---------------- Audio chunking ---------------- */

const CHUNK_TARGET_SEC = 30

interface AudioChunk {
  start: number
  end: number
  text: string
  idx: number
}

/**
 * Group the clip's whisper segments into ~30s windows. Each window is
 * closed when the accumulated duration from its start crosses the target,
 * keeping sentence/segment boundaries intact (Whisper already splits at
 * natural pauses, so we never cut mid-phrase).
 *
 * If the clip has no segments or is already shorter than the target, we
 * return an empty list — the caller then operates on the whole clip.
 */
function buildChunks(clip: EnglishClip): AudioChunk[] {
  const segs = clip.segments || []
  if (segs.length === 0) return []
  const total = (clip.durationSec || segs[segs.length - 1].end) - segs[0].start
  if (total < CHUNK_TARGET_SEC * 1.4) return []
  const out: AudioChunk[] = []
  let cur: ClipSegment[] = []
  let curStart = segs[0].start
  for (const s of segs) {
    if (cur.length === 0) curStart = s.start
    cur.push(s)
    if (s.end - curStart >= CHUNK_TARGET_SEC) {
      out.push({
        idx: out.length,
        start: curStart,
        end: s.end,
        text: cur.map((c) => c.text).join(' ').trim(),
      })
      cur = []
    }
  }
  if (cur.length > 0) {
    // Fold a tiny tail into the previous chunk instead of a 3s orphan.
    const tailDur = cur[cur.length - 1].end - cur[0].start
    if (out.length > 0 && tailDur < CHUNK_TARGET_SEC * 0.5) {
      const last = out[out.length - 1]
      last.end = cur[cur.length - 1].end
      last.text = (last.text + ' ' + cur.map((c) => c.text).join(' ')).trim()
    } else {
      out.push({
        idx: out.length,
        start: cur[0].start,
        end: cur[cur.length - 1].end,
        text: cur.map((c) => c.text).join(' ').trim(),
      })
    }
  }
  return out
}

function ChunkPicker({ chunks, selected, onSelect }: {
  chunks: AudioChunk[]
  selected: number
  onSelect: (idx: number) => void
}) {
  if (chunks.length === 0) return null
  return (
    <div className="ec-chunk-picker">
      <span className="ec-chunk-label">Section:</span>
      <button
        className={`ec-chunk-pill${selected === -1 ? ' ec-chunk-pill-active' : ''}`}
        onClick={() => onSelect(-1)}
      >
        Whole clip
      </button>
      {chunks.map((c) => (
        <button
          key={c.idx}
          className={`ec-chunk-pill${selected === c.idx ? ' ec-chunk-pill-active' : ''}`}
          onClick={() => onSelect(c.idx)}
          title={c.text.slice(0, 80) + (c.text.length > 80 ? '…' : '')}
        >
          {formatTime(c.start)}–{formatTime(c.end)}
        </button>
      ))}
    </div>
  )
}

/* ---------------- Host picker ---------------- */

function ClipsHostPicker({ clipsHost }: { clipsHost: UseClipsHostResult }) {
  const [open, setOpen] = useState(false)
  const [newUrl, setNewUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const current = clipsHost.selected
    ? clipsHost.hosts.find((h) => h.url === clipsHost.selected)
    : null

  return (
    <div className="ec-host-row">
      <button className="ec-host-chip" onClick={() => setOpen((o) => !o)}>
        {clipsHost.enabled
          ? (<><Wifi size={12} /> <span className="ec-host-label">{current?.label || 'remote'}</span></>)
          : (<><Server size={12} /> <span className="ec-host-label">This server</span></>)}
        <span className="ec-host-caret">▾</span>
      </button>
      {open && (
        <div className="ec-host-dropdown">
          <button
            className={`ec-host-opt ${!clipsHost.enabled ? 'ec-host-opt-active' : ''}`}
            onClick={() => { clipsHost.select(null); setOpen(false) }}
          >
            <Server size={12} /> This server <span className="ec-host-url">(default)</span>
          </button>
          {clipsHost.hosts.map((h) => {
            const r = clipsHost.reachability[h.url]
            const active = clipsHost.selected === h.url
            return (
              <div key={h.url} className="ec-host-opt-row">
                <button
                  className={`ec-host-opt ${active ? 'ec-host-opt-active' : ''}`}
                  onClick={() => { clipsHost.select(h.url); setOpen(false) }}
                >
                  {r === 'ok' ? <Wifi size={12} className="ec-host-ok" /> :
                   r === 'checking' ? <Loader2 size={12} className="ec-spin" /> :
                   r === 'unreachable' ? <WifiOff size={12} className="ec-host-bad" /> :
                   <Wifi size={12} />}
                  <span className="ec-host-label">{h.label}</span>
                  <span className="ec-host-url">{h.url.replace(/^https?:\/\//, '')}</span>
                </button>
                <button
                  className="ec-host-remove"
                  onClick={() => clipsHost.removeHost(h.url)}
                  title="Remove this host"
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
          <div className="ec-host-add">
            <input
              type="url"
              className="ec-host-input"
              placeholder="https://my-mac.tailnet.ts.net:3456"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              disabled={busy}
            />
            <button
              className="ec-host-add-btn"
              disabled={busy || !newUrl.trim()}
              onClick={async () => {
                setBusy(true)
                try {
                  const ok = await clipsHost.addHost(newUrl)
                  if (ok) setNewUrl('')
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? <Loader2 size={12} className="ec-spin" /> : <Plus size={12} />}
            </button>
          </div>
          {clipsHost.error && (
            <div className="ec-host-error">
              <AlertCircle size={11} /> {clipsHost.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function useSegmentFollower(
  audioRef: React.MutableRefObject<HTMLAudioElement | null>,
  segments: ClipSegment[] | undefined,
) {
  const [activeIdx, setActiveIdx] = useState(-1)
  const rafRef = useRef<number | null>(null)
  const prevActiveRef = useRef(-1)

  const findActive = useCallback((t: number): number => {
    if (!segments || segments.length === 0) return -1
    // Linear from the previous active segment for cheap forward scans; fall
    // back to full scan on big jumps (user seeking).
    const start = Math.max(0, prevActiveRef.current)
    for (let i = start; i < segments.length; i++) {
      if (t >= segments[i].start && t <= segments[i].end) return i
    }
    for (let i = 0; i < segments.length; i++) {
      if (t >= segments[i].start && t <= segments[i].end) return i
    }
    // Between segments — snap to the next-upcoming one so the highlight
    // doesn't blink off in the gap. If past the end, clear.
    for (let i = 0; i < segments.length; i++) {
      if (t < segments[i].start) return i
    }
    return -1
  }, [segments])

  const onTimeUpdate = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    const i = findActive(el.currentTime)
    if (i !== prevActiveRef.current) {
      prevActiveRef.current = i
      setActiveIdx(i)
    }
  }, [audioRef, findActive])

  const seekTo = useCallback((sec: number) => {
    const el = audioRef.current
    if (!el) return
    try { el.currentTime = sec } catch { /* drop */ }
    if (el.paused) void el.play().catch(() => { /* drop */ })
  }, [audioRef])

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
  }, [])

  // Auto-scroll the active segment into view when it changes.
  useEffect(() => {
    if (activeIdx < 0) return
    const el = document.querySelector(`.ec-seg[data-seg-index="${activeIdx}"]`)
    if (el && 'scrollIntoView' in el) {
      (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [activeIdx])

  return { activeIdx, onTimeUpdate, seekTo }
}

function formatDuration(sec: number | null): string {
  if (!sec || !Number.isFinite(sec)) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(b: number): string {
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1024 / 1024).toFixed(1) + ' MB'
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(t).toLocaleDateString()
}
