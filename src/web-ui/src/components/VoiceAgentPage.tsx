import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Mic, Paperclip, Link as LinkIcon, X, Loader2,
  AlertTriangle, FileText, Globe, Square, Minus, Maximize2, GripHorizontal, Copy, Check,
  Languages, ClipboardPaste, Save, Trash2, Plus, MessageSquare, ChevronLeft, RefreshCw,
} from 'lucide-react'
import { usePageTitle } from '../hooks/usePageTitle'
import { ParticleCloud } from './ParticleCloud'
import '../styles/voice-agent.css'

/**
 * `/voice-agent` — full-screen voice assistant with attach-anything.
 *
 * Opens a WebSocket to `/api/voice/live?project=<b64>` (no `path`, so
 * the session starts with no document). The user can then attach
 * files (PDF, MD, HTML, TXT) or URLs to build up the context Claude
 * discusses. Attachments added mid-conversation are announced to the
 * model on the next user turn.
 *
 * Client-side pipeline mirrors the widget served at /api/voice/widget.js:
 *   getUserMedia → AudioContext → energy-based VAD →
 *   resample 16 kHz PCM16 → WS binary → server STT/LLM/TTS →
 *   PCM16 24 kHz frames back → scheduled Web Audio playback (gapless).
 *
 * MVP scope: no persistence, fresh session each open. See
 * src/server/api/voice-live.ts for the WS protocol reference.
 */

/** Fallback project marker for the standalone agent when no `project`
 *  query param is passed — the WS handshake requires a `project` value
 *  but attachment-only sessions don't belong to any project on disk.
 *  We pick a well-known root that isPathSafe rejects further access
 *  into (no attachments will use the path-based file loader on the
 *  server). When the page is opened from a preview page overlay, the
 *  URL DOES carry `project` + `path`, and those win.  */
const VIRTUAL_PROJECT = '/'

/** Where the ES/EN choice is remembered between visits. */
const LANGUAGE_STORAGE_KEY = 'orka.voice.language'

type VoiceLanguage = 'en' | 'es'

// Server sends TTS audio at 24 kHz. Client capture is push-to-talk via
// ScriptProcessor + AnalyserNode — no VAD library needed.

type AgentState =
  | 'idle'         // ready, mic armed, no speech
  | 'listening'    // user is currently speaking
  | 'thinking'     // waiting for LLM first token
  | 'speaking'     // TTS audio playing
  | 'connecting'   // opening WS + mic
  | 'error'

interface Attachment {
  id: string
  source: 'upload' | 'url' | 'project-file' | 'text'
  label: string
  chars: number
  addedAt: number
  /** Server-side flag: the attachment has a live origin (URL or project
   *  file) that can be re-read. Uploads and pasted text don't. */
  refreshable?: boolean
  /** The URL or project-relative path the text came from, when there
   *  was one. Lets a resumed session rebuild the preview. */
  origin?: string
}

interface TranscriptTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  ts: number
}

// Stable id generator for transcript turns. Prevents React from
// reconciling bubbles by array position when multiple `assistant-text`
// events arrive in the same tick — updating by id is what keeps the
// bubbles from ending up empty or duplicated.
let turnCounter = 0
function nextTurnId(): string {
  return `t-${Date.now()}-${++turnCounter}`
}

function encodeProjectPath(p: string): string {
  return btoa(p).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result || '')
      const idx = s.indexOf(',')
      resolve(idx >= 0 ? s.slice(idx + 1) : s)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** Convert a Float32Array (assumed 16 kHz mono, matching whatever
 *  vad-web emits from `onSpeechEnd`) into little-endian PCM16 bytes
 *  for transmission. Server-side whisper reads PCM16 directly. */
function float32ToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = input[i]
    const clipped = Math.max(-1, Math.min(1, s))
    out[i] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff
  }
  return out
}

/** Downsample a Float32 buffer from srcRate to dstRate with nearest-
 *  neighbor sampling, then encode as PCM16. Whisper expects 16 kHz
 *  mono. Nearest-neighbor is aliased but fine for speech; a proper
 *  low-pass would help only marginally at these ratios. */
function downsampleFloat32ToPcm16(input: Float32Array, srcRate: number, dstRate: number): Int16Array {
  if (srcRate === dstRate) return float32ToPcm16(input)
  const ratio = srcRate / dstRate
  const outLen = Math.floor(input.length / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const s = input[Math.floor(i * ratio)]
    const clipped = Math.max(-1, Math.min(1, s))
    out[i] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff
  }
  return out
}

interface SessionProps {
  /** Saved conversation to resume, or null for a fresh session. */
  conversationId: string | null
  /** Back to the conversation picker. */
  onExit: () => void
}

/**
 * One live voice session.
 *
 * Split out from the page so the picker can remount it with a `key`:
 * opening a different conversation has to tear down the WebSocket, the
 * mic graph and the playback queue and build them again, and letting
 * React unmount the whole subtree gets that for free from the cleanup
 * that already exists — far safer than making the init effect
 * re-entrant.
 */
function VoiceAgentSession({ conversationId, onExit }: SessionProps) {
  usePageTitle('Voice Agent')
  // URL params:
  //   ?embedded=1     — hide our own header/back button. Used by the
  //                     iPhone launcher / preview overlay which wrap
  //                     this page in their own chrome.
  //   ?project=<b64>  — url-safe-base64 project path. When present
  //                     (opened from an HTML preview's voice button)
  //                     it goes into the WS handshake so server-side
  //                     can auto-load the file.
  //   ?path=<rel>     — project-relative file path. Server treats it
  //                     as an initial attachment (backward-compat
  //                     with the preview `?voice=1` flow).
  const [searchParams] = useSearchParams()
  const embedded = searchParams.get('embedded') === '1'
  const projectParam = searchParams.get('project')
  const pathParam = searchParams.get('path')

  const [state, setState] = useState<AgentState>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([])
  const [urlDraft, setUrlDraft] = useState('')
  const [urlOpen, setUrlOpen] = useState(false)
  // Paste-text modal. Unlike the URL form (a one-line inline field),
  // pasted text needs room to see what you're attaching, so it gets a
  // real modal with a textarea.
  const [textOpen, setTextOpen] = useState(false)
  const [textDraft, setTextDraft] = useState('')
  // Save-conversation modal + the name of the record we're bound to.
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveDraft, setSaveDraft] = useState('')
  const [convName, setConvName] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  // Attachment ids currently reloading, and a per-id nonce bumped on
  // every successful reload so the preview iframe remounts instead of
  // showing the version it already painted.
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set())
  const [refreshNonce, setRefreshNonce] = useState<Record<string, number>>({})
  const [attaching, setAttaching] = useState(false)
  const [totalChars, setTotalChars] = useState(0)
  // `level` is the smoothed RMS 0..1 read from an AnalyserNode on the
  // mic stream — drives the halo ring around the mic button so the
  // user sees their voice registering.
  const [level, setLevel] = useState(0)
  const [ctxSuspended, setCtxSuspended] = useState(false)
  // Push-to-talk toggle. When true we're accumulating PCM chunks;
  // clicking again stops capture, ships the buffer + utterance-end,
  // and transitions to `thinking`.
  const [recording, setRecording] = useState(false)
  // Document viewer state — when set, the layout goes doc-first:
  // the document takes the full canvas as the protagonist, and the
  // voice agent shrinks to a translucent, draggable, minimizable
  // panel floating on top. Value is the attachment id; the actual
  // preview data (blob url or fetched url) lives in `previewMapRef`
  // below to avoid re-renders when it changes.
  const [viewerId, setViewerId] = useState<string | null>(null)
  // Bump this to force the preview to re-render when we associate a
  // new source with an id (attachment-added arrival lands after the
  // click that opens the viewer).
  const [previewVersion, setPreviewVersion] = useState(0)
  // Floating-agent state (only used when the viewer is open):
  //  - `minimized` collapses the panel to a compact mic-only bubble
  //    that stays functional so the user can keep talking without the
  //    panel covering the document.
  //  - `agentPos` is the top-left of the floating panel in px,
  //    relative to the content viewport. `null` means "use CSS
  //    default position" (top-right corner) until the user drags.
  const [minimized, setMinimized] = useState(false)
  const [agentPos, setAgentPos] = useState<{ x: number; y: number } | null>(null)
  const [justCopied, setJustCopied] = useState(false)
  // Conversation language. Persisted per browser so the widget opens in
  // whatever the user last spoke, and mirrored into a ref because the
  // WS init effect runs once and can't see later state.
  const [language, setLanguage] = useState<VoiceLanguage>(() => {
    const fromUrl = searchParams.get('language')
    if (fromUrl === 'es' || fromUrl === 'en') return fromUrl
    try {
      const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY)
      if (saved === 'es' || saved === 'en') return saved
    } catch { /* private mode / blocked storage */ }
    return 'en'
  })
  const dragStateRef = useRef<{
    active: boolean
    pointerId: number
    startClientX: number
    startClientY: number
    startPosX: number
    startPosY: number
    containerWidth: number
    containerHeight: number
    panelWidth: number
    panelHeight: number
  } | null>(null)
  const floatPanelRef = useRef<HTMLDivElement>(null)

  // The WS init effect runs once; keep the language reachable from it
  // (and from the send helper) without re-opening the socket.
  const languageRef = useRef<VoiceLanguage>(language)
  // Which saved conversation this session writes to. Starts as the one
  // being resumed (if any) and gets set on the first save, so later
  // saves update in place instead of piling up copies.
  const conversationIdRef = useRef<string | null>(conversationId)
  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const playbackQueueRef = useRef<AudioBuffer[]>([])
  const playbackNodeRef = useRef<AudioBufferSourceNode | null>(null)
  // Every buffer source currently scheduled on the audio clock, so a
  // barge-in can stop all of them (see stopPlayback).
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([])
  const playbackTailRef = useRef<number>(0)
  const transcriptRef = useRef<HTMLDivElement>(null)
  // False until the thread has been scrolled into place once. Guards the
  // one case where jumping to the bottom is unconditionally right.
  const didInitialScrollRef = useRef(false)
  // Preview sources per attachment id. `blob` sources own a Blob URL
  // that must be revoked on removal or unmount. `pending` is a FIFO
  // of previews we've built client-side while waiting for the
  // matching `attachment-added` reply — because the server assigns
  // the final id, we can only associate blobs to ids once that reply
  // arrives (shift in arrival order — sequential uploads/URLs work
  // out of the box).
  type Preview = { kind: 'blob' | 'url'; src: string; mime?: string; label: string }
  const previewMapRef = useRef<Map<string, Preview>>(new Map())
  const pendingPreviewsRef = useRef<Preview[]>([])
  // Attachment ids whose stored text we've asked the server for, so the
  // reply knows it was requested rather than arriving unsolicited.
  const pendingContentRef = useRef<Set<string>>(new Set())
  const currentAssistantRef = useRef<string>('')
  // Id of the assistant bubble currently being appended to. Set when a
  // new agent turn starts (first `assistant-text` after a user turn),
  // cleared on `assistant-turn-end`. Updating the transcript BY ID
  // avoids the React-18 batching quirk where two rapid setTranscript
  // updaters both see the same `prev` and each end up appending a
  // fresh bubble (visible symptom: multiple empty AGENT rows).
  const assistantTurnIdRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Level-meter plumbing. AnalyserNode is a pure passive tap on the
  // mic stream — doesn't affect what VAD sees. RAF drives the poll.
  const analyserRef = useRef<AnalyserNode | null>(null)
  const analyserDataRef = useRef<Uint8Array | null>(null)
  const levelRafRef = useRef<number | null>(null)
  const smoothLevelRef = useRef<number>(0)
  // Push-to-talk capture. `processorRef` is a ScriptProcessorNode that
  // fires ~85 ms per callback (buffer 4096 @ 48 kHz). It's always live
  // once init finishes so the connection graph doesn't get torn down
  // and rebuilt on every recording toggle — the callback just checks
  // `recordingRef.current` and either buffers or drops.
  //
  // `recordingRef` mirrors the React state so the callback (closure)
  // reads the current value without needing to be re-wired on state
  // changes. `chunksRef` collects Float32 windows and gets flushed
  // when the user clicks stop.
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const captureCtxSampleRateRef = useRef<number>(48000)
  const chunksRef = useRef<Float32Array[]>([])
  const recordingRef = useRef<boolean>(false)
  useEffect(() => { recordingRef.current = recording }, [recording])
  // Mirror `state` into a ref so the VAD callbacks (created once inside
  // the init effect that intentionally has an empty dep list) can read
  // the LIVE state. Without this, callbacks close over the initial
  // 'connecting' value and barge-in never triggers.
  const stateRef = useRef<AgentState>('connecting')
  useEffect(() => { stateRef.current = state }, [state])
  const viewerIdRef = useRef<string | null>(null)
  useEffect(() => { viewerIdRef.current = viewerId }, [viewerId])

  // Auto-dismiss any error banner after 6s so a transient issue
  // (transient TTS glitch, one bad utterance) doesn't leave a red bar
  // sitting on top of the modal for the rest of the session. Manual
  // dismiss via the X still works.
  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 6000)
    return () => clearTimeout(t)
  }, [error])

  // Auto-scroll the transcript to the bottom whenever a new turn
  // arrives OR the last assistant bubble grows (streaming text).
  // useLayoutEffect avoids a visible jump — we scroll before paint.
  // The user can still scroll up manually; new messages only steal
  // focus if we're already near the bottom.
  //
  // The near-bottom guard has to be skipped for the FIRST paint of a
  // thread. A resumed conversation renders its whole history at once
  // with scrollTop at 0, which is nowhere near the bottom, so the guard
  // would refuse the initial scroll — and then keep refusing every
  // later one, since we never got to the bottom to begin with. The
  // thread would sit pinned to its oldest message forever.
  useLayoutEffect(() => {
    const el = transcriptRef.current
    if (!el || transcript.length === 0) return

    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true
      // Instant, not smooth: the CSS sets scroll-behavior: smooth, and
      // animating a jump the user never asked for just looks like the
      // page is loading twice.
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
      // Bubbles can still reflow after this pass (wrapping, fonts), so
      // settle once more on the next frame.
      requestAnimationFrame(() => {
        const e = transcriptRef.current
        if (e) e.scrollTo({ top: e.scrollHeight, behavior: 'auto' })
      })
      return
    }

    // "Near bottom" tolerance — 120 px covers a full new bubble.
    const nearBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 120
    if (nearBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [transcript])

  // Utility: send JSON control message on WS if open
  const sendCtrl = useCallback((msg: object) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(msg))
  }, [])

  // Playback pipeline: enqueue PCM16 chunks as AudioBuffers, chain-schedule
  const enqueuePcm = useCallback((pcm: Int16Array, sampleRate: number) => {
    const ctx = audioCtxRef.current
    if (!ctx) return
    const f32 = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 0x8000
    const buf = ctx.createBuffer(1, f32.length, sampleRate)
    buf.copyToChannel(f32, 0)
    // Schedule at max(now, tail) for gapless playback
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    const startAt = Math.max(ctx.currentTime, playbackTailRef.current)
    src.start(startAt)
    playbackTailRef.current = startAt + buf.duration
    playbackNodeRef.current = src
    // Every chunk is start()ed the moment it arrives, scheduled into the
    // future — so at any instant there can be a long backlog of sources
    // already committed to the audio clock. stopPlayback() has to be
    // able to reach all of them, not just the newest.
    scheduledSourcesRef.current.push(src)
    src.onended = () => {
      const i = scheduledSourcesRef.current.indexOf(src)
      if (i >= 0) scheduledSourcesRef.current.splice(i, 1)
    }
  }, [])

  const stopPlayback = useCallback(() => {
    // Stop the whole scheduled backlog. Stopping only the most recent
    // source (what this used to do) left every earlier chunk running,
    // so interrupting a long answer didn't actually silence it — the
    // agent kept talking over the user for as long as the queue was.
    for (const src of scheduledSourcesRef.current) {
      try { src.onended = null; src.stop() } catch { /* already ended */ }
    }
    scheduledSourcesRef.current = []
    playbackNodeRef.current = null
    playbackTailRef.current = 0
    playbackQueueRef.current = []
    const ctx = audioCtxRef.current
    if (ctx) playbackTailRef.current = ctx.currentTime
  }, [])

  // Main initialization effect: open WS, mic, VAD, playback context.
  useEffect(() => {
    let disposed = false

    const init = async () => {
      try {
        // 1. WebSocket. If the URL carries `project` (and optionally
        //    `path`) — e.g. we were opened from an HTML preview's
        //    voice button — pass them straight through so the server
        //    resolves the file into an initial attachment. Otherwise
        //    fall back to the standalone virtual-project session.
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const projectQs = projectParam
          ? encodeURIComponent(projectParam)
          : encodeProjectPath(VIRTUAL_PROJECT)
        const pathQs = pathParam
          ? `&path=${encodeURIComponent(pathParam)}`
          : ''
        const convQs = conversationIdRef.current
          ? `&conversation=${encodeURIComponent(conversationIdRef.current)}`
          : ''
        const url = `${proto}//${window.location.host}/api/voice/live?project=${projectQs}${pathQs}`
          + `&language=${encodeURIComponent(languageRef.current)}${convQs}`
        const ws = new WebSocket(url)
        ws.binaryType = 'arraybuffer'
        wsRef.current = ws

        let audioSampleRate = 24000

        ws.onmessage = (ev) => {
          if (ev.data instanceof ArrayBuffer) {
            const pcm = new Int16Array(ev.data)
            enqueuePcm(pcm, audioSampleRate)
            return
          }
          let msg: any
          try { msg = JSON.parse(String(ev.data)) } catch { return }
          switch (msg.type) {
            case 'ready':
              if (Array.isArray(msg.attachments)) {
                setAttachments(msg.attachments)
                setTotalChars(msg.docChars || 0)
                // Restored URL documents can be previewed without a
                // round-trip — the origin is all the iframe needs.
                for (const a of msg.attachments as Attachment[]) {
                  if (a.source === 'url' && a.origin && !previewMapRef.current.has(a.id)) {
                    previewMapRef.current.set(a.id, { kind: 'url', src: a.origin, label: a.label })
                  }
                }
                setPreviewVersion((v) => v + 1)
              }
              if (msg.language === 'es' || msg.language === 'en') {
                languageRef.current = msg.language
                setLanguage(msg.language)
              }
              // Resuming: redraw the thread the user left behind so the
              // conversation reads as continuous rather than starting
              // from a blank panel that secretly remembers everything.
              if (msg.conversation?.id) {
                conversationIdRef.current = msg.conversation.id
                setConvName(msg.conversation.name || null)
              }
              if (Array.isArray(msg.transcript) && msg.transcript.length > 0) {
                setTranscript(msg.transcript.map((t: { role: string; text: string }) => ({
                  id: nextTurnId(),
                  role: t.role === 'user' ? 'user' : 'assistant',
                  text: String(t.text || ''),
                  ts: Date.now(),
                })))
              }
              setState('idle')
              break
            case 'conversation-saved':
              conversationIdRef.current = msg.id
              setConvName(msg.name || null)
              setJustSaved(true)
              setTimeout(() => setJustSaved(false), 2200)
              break
            case 'error':
              setError(msg.message || 'server error')
              setState('error')
              break
            case 'transcript-final': {
              currentAssistantRef.current = ''
              assistantTurnIdRef.current = null
              const userTurn: TranscriptTurn = {
                id: nextTurnId(), role: 'user', text: String(msg.text || ''), ts: Date.now(),
              }
              setTranscript((prev) => [...prev, userTurn])
              setState('thinking')
              break
            }
            case 'assistant-text': {
              const chunk = String(msg.text || '')
              if (!chunk) break
              currentAssistantRef.current += (currentAssistantRef.current ? ' ' : '') + chunk
              const full = currentAssistantRef.current
              if (assistantTurnIdRef.current == null) {
                // Start a new assistant bubble the first time text
                // arrives after a user turn. Capture the id so we
                // update the SAME bubble on subsequent chunks —
                // independent of array position, which React 18
                // batching could momentarily desync.
                const id = nextTurnId()
                assistantTurnIdRef.current = id
                setTranscript((prev) => [...prev, { id, role: 'assistant', text: full, ts: Date.now() }])
              } else {
                const targetId = assistantTurnIdRef.current
                setTranscript((prev) => prev.map((t) =>
                  t.id === targetId ? { ...t, text: full } : t
                ))
              }
              break
            }
            case 'audio-start':
              audioSampleRate = msg.sampleRate || 24000
              setState('speaking')
              break
            case 'audio-end':
              break
            case 'assistant-turn-end':
              currentAssistantRef.current = ''
              assistantTurnIdRef.current = null
              setState('idle')
              break
            case 'language-changed':
              // Authoritative echo from the server — keeps us honest if
              // it rejected the switch or picked a different voice.
              if (msg.language === 'es' || msg.language === 'en') {
                languageRef.current = msg.language
                setLanguage(msg.language)
              }
              break
            case 'attachment-added': {
              setAttachments((prev) => [
                ...prev,
                {
                  id: msg.id,
                  source: msg.source,
                  label: msg.label,
                  chars: msg.chars,
                  addedAt: msg.addedAt,
                  refreshable: !!msg.refreshable,
                },
              ])
              setTotalChars(msg.totalChars || 0)
              setAttaching(false)
              // Bind the pending preview (built client-side when the
              // user clicked "Attach") to the server-issued id. FIFO
              // by arrival — works for sequential uploads.
              const p = pendingPreviewsRef.current.shift()
              if (p) {
                previewMapRef.current.set(msg.id, p)
                setPreviewVersion((v) => v + 1)
              }
              break
            }
            case 'attachment-error': {
              setError(msg.message || 'attachment failed')
              setAttaching(false)
              setRefreshing(new Set())
              // Drop the queued preview whose upload just failed —
              // otherwise it'd bind to the NEXT successful attachment.
              const failed = pendingPreviewsRef.current.shift()
              if (failed?.kind === 'blob') URL.revokeObjectURL(failed.src)
              // Auto-clear the error banner after 4s so the UI doesn't
              // permanently look broken over a transient upload issue.
              setTimeout(() => setError(null), 4000)
              break
            }
            case 'attachment-content': {
              if (!pendingContentRef.current.has(msg.id)) break
              pendingContentRef.current.delete(msg.id)
              const blobUrl = URL.createObjectURL(
                new Blob([String(msg.text || '')], { type: 'text/plain' })
              )
              previewMapRef.current.set(msg.id, {
                kind: 'blob', src: blobUrl, mime: 'text/plain', label: msg.label || 'Document',
              })
              setPreviewVersion((v) => v + 1)
              break
            }
            case 'attachment-updated': {
              setAttachments((prev) => prev.map((a) =>
                a.id === msg.id ? { ...a, label: msg.label ?? a.label, chars: msg.chars ?? a.chars } : a))
              setTotalChars(msg.totalChars || 0)
              setRefreshing((prev) => { const n = new Set(prev); n.delete(msg.id); return n })
              setRefreshNonce((prev) => ({ ...prev, [msg.id]: (prev[msg.id] || 0) + 1 }))
              // A stored-text preview is now out of date. Drop it so the
              // next open pulls the refreshed text; URL previews point at
              // the live page and are handled by the nonce remount.
              const stale = previewMapRef.current.get(msg.id)
              if (stale?.kind === 'blob') {
                URL.revokeObjectURL(stale.src)
                previewMapRef.current.delete(msg.id)
                if (viewerIdRef.current === msg.id) {
                  pendingContentRef.current.add(msg.id)
                  wsRef.current?.send(JSON.stringify({ type: 'attachment-content', id: msg.id }))
                }
              }
              break
            }
            case 'attachment-removed': {
              const removedPrev = previewMapRef.current.get(msg.id)
              if (removedPrev?.kind === 'blob') URL.revokeObjectURL(removedPrev.src)
              previewMapRef.current.delete(msg.id)
              setAttachments((prev) => prev.filter((a) => a.id !== msg.id))
              setTotalChars(msg.totalChars || 0)
              if (viewerIdRef.current === msg.id) setViewerId(null)
              setPreviewVersion((v) => v + 1)
              break
            }
          }
        }

        ws.onerror = () => {
          if (!disposed) {
            setError('WebSocket error')
            setState('error')
          }
        }
        ws.onclose = () => {
          if (!disposed) {
            setState('error')
            setError('Voice session closed')
          }
        }

        // 2. Wait for WS open before starting mic (avoids sending PCM
        //    into a not-yet-open socket)
        await new Promise<void>((resolve, reject) => {
          if (ws.readyState === WebSocket.OPEN) return resolve()
          const t = setTimeout(() => reject(new Error('WS open timeout')), 8000)
          ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
          ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WS error')) }, { once: true })
        })
        if (disposed) return

        // 3. Mic + playback AudioContext.
        // NOTE: we do NOT wire a ScriptProcessor here. Earlier
        // versions did — that created a second consumer of the same
        // MediaStream in a separate AudioContext, competing with
        // vad-web's own worklet-based capture. In some browsers one
        // of the two ends up silent. Simpler design: vad-web owns
        // capture, we only own PLAYBACK (assistant audio → speakers).
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        })
        if (disposed) { stream.getTracks().forEach((t) => t.stop()); return }
        micStreamRef.current = stream
        const ctx = new AudioContext()
        audioCtxRef.current = ctx
        // Chrome autoplay: an AudioContext created without a user
        // gesture starts suspended. The click that opened this page
        // (or the launcher tile that iframed us) usually counts, but
        // resume() is a no-op if already running.
        if (ctx.state === 'suspended') {
          try { await ctx.resume() } catch { /* ignore — will retry on next user gesture */ }
        }
        // Surface the suspended state so the UI can show a "tap to
        // start" hint. In an iframe the parent's click may not carry
        // through as a user gesture, and getUserMedia + AudioContext
        // race can leave us muted until the user taps the button.
        setCtxSuspended(ctx.state === 'suspended')

        // Live level meter — passive AnalyserNode tap on the same
        // stream. Runs alongside vad-web's capture; independent
        // analyser doesn't compete for the track (unlike a second
        // ScriptProcessor consumer would). The RAF loop stops when
        // the ref is cleared during cleanup.
        //
        // The same MediaStreamSource also feeds a ScriptProcessor for
        // manual (push-to-talk) capture — see below. Reusing one
        // source keeps the graph simple and, more importantly, avoids
        // opening two `createMediaStreamSource(stream)` on the same
        // MediaStream (some engines misbehave when you do that).
        try {
          const meterSrc = ctx.createMediaStreamSource(stream)
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 512
          analyser.smoothingTimeConstant = 0.6
          meterSrc.connect(analyser)
          analyserRef.current = analyser
          analyserDataRef.current = new Uint8Array(analyser.frequencyBinCount)

          // Push-to-talk capture: same source → ScriptProcessor →
          // zero-gain sink (some browsers optimise out ScriptProcessors
          // that aren't connected to a destination). Callback fires
          // every ~85 ms at 48 kHz. When recordingRef.current is true
          // we clone the frame into chunksRef; when false we drop.
          const proc = ctx.createScriptProcessor(4096, 1, 1)
          captureCtxSampleRateRef.current = ctx.sampleRate
          const sink = ctx.createGain()
          sink.gain.value = 0
          meterSrc.connect(proc)
          proc.connect(sink)
          sink.connect(ctx.destination)
          proc.onaudioprocess = (evt) => {
            if (!recordingRef.current) return
            const input = evt.inputBuffer.getChannelData(0)
            // Copy — the underlying buffer is reused by the audio
            // engine on the next callback, so a shallow reference
            // would get overwritten before we consume it.
            chunksRef.current.push(new Float32Array(input))
          }
          processorRef.current = proc
          const tick = () => {
            const a = analyserRef.current
            const d = analyserDataRef.current
            if (!a || !d) return
            a.getByteTimeDomainData(d)
            // RMS over the 128 samples, mapped to 0..1
            let sum = 0
            for (let i = 0; i < d.length; i++) {
              const v = (d[i] - 128) / 128
              sum += v * v
            }
            const rms = Math.sqrt(sum / d.length)
            // Smooth with an EMA so the ring doesn't jitter every frame
            smoothLevelRef.current = smoothLevelRef.current * 0.7 + rms * 0.3
            setLevel(smoothLevelRef.current)
            levelRafRef.current = requestAnimationFrame(tick)
          }
          levelRafRef.current = requestAnimationFrame(tick)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[voice-agent] analyser setup failed', err)
        }

        // 4. No auto-VAD — capture is push-to-talk, driven by the
        //    mic button click. Simpler and doesn't depend on
        //    vad-web / Silero which was misbehaving in some setups.
        setState('idle')
      } catch (err: any) {
        if (!disposed) {
          setError(err?.message || 'init failed')
          setState('error')
        }
      }
    }

    void init()

    return () => {
      disposed = true
      if (levelRafRef.current != null) {
        cancelAnimationFrame(levelRafRef.current)
        levelRafRef.current = null
      }
      analyserRef.current = null
      analyserDataRef.current = null
      try { processorRef.current?.disconnect() } catch { /* ignore */ }
      processorRef.current = null
      chunksRef.current = []
      try { wsRef.current?.close() } catch { /* ignore */ }
      wsRef.current = null
      try { micStreamRef.current?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
      micStreamRef.current = null
      try { audioCtxRef.current?.close() } catch { /* ignore */ }
      audioCtxRef.current = null
      // Release any blob URLs we created for the preview viewer.
      for (const p of previewMapRef.current.values()) {
        if (p.kind === 'blob') { try { URL.revokeObjectURL(p.src) } catch { /* ignore */ } }
      }
      previewMapRef.current.clear()
      for (const p of pendingPreviewsRef.current) {
        if (p.kind === 'blob') { try { URL.revokeObjectURL(p.src) } catch { /* ignore */ } }
      }
      pendingPreviewsRef.current = []
    }
    // Intentionally NOT reactive to `state` — we compute it inside
    // the VAD callbacks. Re-running the effect on every state change
    // would tear down the mic pipeline every ~second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enqueuePcm, sendCtrl, stopPlayback])

  const handleFilePick = useCallback(async (file: File) => {
    if (!file) return
    if (file.size > 20 * 1024 * 1024) {
      setError(`${file.name} too large (${(file.size / 1024 / 1024).toFixed(1)} MB > 20 MB)`)
      setTimeout(() => setError(null), 4000)
      return
    }
    setAttaching(true)
    // Build the preview NOW (client owns the File, no round-trip needed)
    // and queue it. It'll be associated with the server-assigned id when
    // `attachment-added` arrives. Same-origin blob URL — browsers render
    // PDFs inline in an iframe / img / video without a plugin.
    const mime = file.type || 'application/octet-stream'
    const blobUrl = URL.createObjectURL(file)
    pendingPreviewsRef.current.push({
      kind: 'blob',
      src: blobUrl,
      mime,
      label: file.name,
    })
    try {
      const dataBase64 = await readAsBase64(file)
      sendCtrl({
        type: 'attach-file',
        name: file.name,
        mime,
        dataBase64,
      })
    } catch (err: any) {
      setAttaching(false)
      setError(err?.message || 'file read failed')
      setTimeout(() => setError(null), 4000)
      // Undo the pending preview since we never sent it.
      const idx = pendingPreviewsRef.current.findIndex((p) => p.src === blobUrl)
      if (idx >= 0) pendingPreviewsRef.current.splice(idx, 1)
      URL.revokeObjectURL(blobUrl)
    }
  }, [sendCtrl])

  const handleUrlSubmit = useCallback(() => {
    const u = urlDraft.trim()
    if (!u) return
    setAttaching(true)
    // Extract a short display label from the URL for the preview
    // (chip already gets its label from the server response).
    let label = u
    try { const parsed = new URL(u); label = parsed.hostname + parsed.pathname.replace(/\/$/, '') } catch { /* ignore */ }
    pendingPreviewsRef.current.push({ kind: 'url', src: u, label })
    sendCtrl({ type: 'attach-url', url: u })
    setUrlDraft('')
    setUrlOpen(false)
  }, [urlDraft, sendCtrl])

  /**
   * Flip ES <-> EN.
   *
   * The server owns the actual switch (whisper decode language, TTS
   * voice, and the model's output language all move together), so this
   * only sets local state, remembers the choice, and tells it.
   */
  const toggleLanguage = useCallback(() => {
    setLanguage((prev) => {
      const next: VoiceLanguage = prev === 'en' ? 'es' : 'en'
      languageRef.current = next
      try { localStorage.setItem(LANGUAGE_STORAGE_KEY, next) } catch { /* blocked storage */ }
      sendCtrl({ type: 'set-language', language: next })
      // Whatever is queued was synthesized in the old language; the
      // server drops its side, so drop ours too instead of letting the
      // backlog keep talking in the language we just left.
      stopPlayback()
      return next
    })
  }, [sendCtrl, stopPlayback])

  /**
   * Attach a blob of pasted text as its own document.
   *
   * The preview is built here from a text/plain Blob, exactly like the
   * file path does — that keeps the attachment card clickable and lets
   * the user re-read what they pasted in the viewer. The server assigns
   * the real id, so this goes on the pending FIFO like the others.
   */
  const handleTextSubmit = useCallback(() => {
    const body = textDraft.trim()
    if (!body) return
    setAttaching(true)

    const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean) || 'Pasted text'
    const label = firstLine.length > 52 ? firstLine.slice(0, 51).trimEnd() + '…' : firstLine
    const blobUrl = URL.createObjectURL(new Blob([body], { type: 'text/plain' }))
    pendingPreviewsRef.current.push({ kind: 'blob', src: blobUrl, mime: 'text/plain', label })

    sendCtrl({ type: 'attach-text', text: body, label })
    setTextDraft('')
    setTextOpen(false)
  }, [textDraft, sendCtrl])

  /**
   * Save (or re-save) the thread under a name.
   *
   * The display transcript travels with the request: the server keeps
   * the model-facing history, which carries injected attachment blobs
   * and language notes that have no business appearing in a bubble.
   */
  const handleSaveSubmit = useCallback(() => {
    const name = saveDraft.trim()
    if (!name) return
    sendCtrl({
      type: 'save-conversation',
      name,
      transcript: transcript.map((t) => ({ role: t.role, text: t.text })),
    })
    setSaveOpen(false)
  }, [saveDraft, transcript, sendCtrl])

  const openSaveModal = useCallback(() => {
    // Re-saving keeps the existing name in the field so the common case
    // is just hitting Save again.
    setSaveDraft(convName || '')
    setSaveOpen(true)
  }, [convName])

  /**
   * Open an attachment in the viewer, building its preview if needed.
   *
   * Freshly attached documents already have one — the browser held the
   * File or the URL. A RESUMED conversation doesn't: those documents
   * were attached in a previous session this browser never saw. URLs
   * rebuild from their origin; everything else asks the server for the
   * stored text and renders that, which is also the honest thing to
   * show, since the stored text is exactly what the agent is reading.
   */
  const openAttachment = useCallback((a: Attachment, isActive: boolean) => {
    if (isActive) { setViewerId(null); return }

    if (!previewMapRef.current.has(a.id)) {
      if (a.source === 'url' && a.origin) {
        previewMapRef.current.set(a.id, { kind: 'url', src: a.origin, label: a.label })
        setPreviewVersion((v) => v + 1)
      } else {
        // Round-trips through the server; the viewer opens as soon as
        // `attachment-content` lands.
        pendingContentRef.current.add(a.id)
        sendCtrl({ type: 'attachment-content', id: a.id })
        setViewerId(a.id)
        // Don't leave the viewer sitting on "no preview" forever if the
        // reply never comes — say what's actually wrong.
        window.setTimeout(() => {
          if (!pendingContentRef.current.has(a.id)) return
          pendingContentRef.current.delete(a.id)
          setError(`Could not load "${a.label}" for preview — the server may be running an older build. Restart orka.`)
          setTimeout(() => setError(null), 6000)
        }, 8000)
        return
      }
    }
    setViewerId(a.id)
  }, [sendCtrl])

  const handleRefresh = useCallback((id: string) => {
    setRefreshing((prev) => new Set(prev).add(id))
    sendCtrl({ type: 'attachment-refresh', id })
  }, [sendCtrl])

  const handleRemove = useCallback((id: string) => {
    sendCtrl({ type: 'attachment-remove', id })
  }, [sendCtrl])

  // Drag & drop file support
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
  }, [])
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    const files = Array.from(e.dataTransfer?.files || [])
    for (const f of files) void handleFilePick(f)
  }, [handleFilePick])

  const micLabel = useMemo(() => {
    if (recording) return 'Recording — tap to send'
    if (ctxSuspended) return 'Tap mic to enable audio'
    switch (state) {
      case 'connecting': return 'Connecting…'
      case 'listening': return 'Recording — tap to send'
      case 'thinking': return 'Transcribing / thinking…'
      case 'speaking': return 'Speaking — tap to interrupt'
      case 'error': return 'Error'
      default: return 'Tap mic to start recording'
    }
  }, [state, ctxSuspended, recording])

  // Manual AudioContext resume — some browsers (or iframes with strict
  // autoplay policies) won't resume the context until an in-page click.
  // Tapping the mic button counts; we wire this to the same click.
  const ensureContextRunning = useCallback(async () => {
    const ctx = audioCtxRef.current
    if (!ctx) return
    if (ctx.state === 'suspended') {
      try { await ctx.resume() } catch { /* ignore */ }
      setCtxSuspended(ctx.state === 'suspended')
    }
  }, [])

  // Push-to-talk toggle. Start clears any previous buffer so the
  // recording is only what happened between the two clicks; stop
  // concatenates, downsamples to 16 kHz PCM16, ships it as a single
  // binary frame followed by `utterance-end` (same shape the server
  // was already handling), and transitions to `thinking`.
  const stopRecordingAndSend = useCallback(() => {
    setRecording(false)
    recordingRef.current = false
    const chunks = chunksRef.current
    chunksRef.current = []
    const total = chunks.reduce((n, c) => n + c.length, 0)
    if (total === 0) {
      // eslint-disable-next-line no-console
      console.warn('[voice-agent] stopRecording: no samples captured')
      return
    }
    const merged = new Float32Array(total)
    let off = 0
    for (const c of chunks) { merged.set(c, off); off += c.length }
    const srcRate = captureCtxSampleRateRef.current || 48000
    const pcm16 = downsampleFloat32ToPcm16(merged, srcRate, 16000)
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // eslint-disable-next-line no-console
      console.warn('[voice-agent] stopRecording: WS not open')
      return
    }
    try {
      ws.send(pcm16)
      ws.send(JSON.stringify({ type: 'utterance-end' }))
      // eslint-disable-next-line no-console
      console.log(`[voice-agent] push-to-talk sent ${pcm16.length} samples (${(pcm16.length / 16000).toFixed(2)}s @ 16k)`)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[voice-agent] send failed', err)
    }
    setState('thinking')
  }, [])

  // ----- Floating panel drag + clamp --------------------------------

  const clampPos = useCallback((x: number, y: number, cw: number, ch: number, pw: number, ph: number) => {
    // Keep the panel entirely inside the visible content area with a
    // small margin so it never floats off screen or under the header.
    const margin = 8
    const maxX = Math.max(margin, cw - pw - margin)
    const maxY = Math.max(margin, ch - ph - margin)
    return {
      x: Math.min(Math.max(margin, x), maxX),
      y: Math.min(Math.max(margin, y), maxY),
    }
  }, [])

  const handleAgentDragStart = useCallback((e: React.PointerEvent) => {
    // Ignore drags initiated on interactive children — the close /
    // minimize buttons need their click through.
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
    const panel = floatPanelRef.current
    if (!panel) return
    const parent = panel.parentElement
    if (!parent) return
    const panelRect = panel.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    dragStateRef.current = {
      active: true,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPosX: panelRect.left - parentRect.left,
      startPosY: panelRect.top - parentRect.top,
      containerWidth: parentRect.width,
      containerHeight: parentRect.height,
      panelWidth: panelRect.width,
      panelHeight: panelRect.height,
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [])

  const handleAgentDragMove = useCallback((e: React.PointerEvent) => {
    const d = dragStateRef.current
    if (!d || !d.active || d.pointerId !== e.pointerId) return
    const dx = e.clientX - d.startClientX
    const dy = e.clientY - d.startClientY
    const clamped = clampPos(
      d.startPosX + dx,
      d.startPosY + dy,
      d.containerWidth,
      d.containerHeight,
      d.panelWidth,
      d.panelHeight,
    )
    setAgentPos(clamped)
  }, [clampPos])

  const handleAgentDragEnd = useCallback((e: React.PointerEvent) => {
    const d = dragStateRef.current
    if (!d) return
    d.active = false
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }, [])

  // Re-clamp panel position on resize so it doesn't end up off-screen
  // after a window resize or rotation.
  useEffect(() => {
    if (!viewerId || agentPos == null) return
    const onResize = () => {
      const panel = floatPanelRef.current
      const parent = panel?.parentElement
      if (!panel || !parent) return
      const parentRect = parent.getBoundingClientRect()
      const panelRect = panel.getBoundingClientRect()
      setAgentPos((prev) => prev
        ? clampPos(prev.x, prev.y, parentRect.width, parentRect.height, panelRect.width, panelRect.height)
        : prev
      )
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [viewerId, agentPos, clampPos])

  const copyConversation = useCallback(async () => {
    const text = transcript
      .map((t) => `${t.role === 'user' ? 'You' : 'Agent'}: ${t.text}`)
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      setJustCopied(true)
      setTimeout(() => setJustCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [transcript])

  const toggleRecording = useCallback(async () => {
    // Any click on the mic counts as a user gesture — unlock the
    // AudioContext first so the very first tap actually starts capture.
    await ensureContextRunning()
    if (recordingRef.current) {
      stopRecordingAndSend()
    } else {
      // Also cut any TTS playback if the assistant is mid-response —
      // signal the server so the LLM turn aborts and won't waste
      // tokens on a reply we're already talking over.
      if (stateRef.current === 'speaking' || playbackTailRef.current > (audioCtxRef.current?.currentTime || 0)) {
        stopPlayback()
        sendCtrl({ type: 'interrupt' })
      }
      chunksRef.current = []
      setRecording(true)
      recordingRef.current = true
      setState('listening')
    }
  }, [ensureContextRunning, sendCtrl, stopPlayback, stopRecordingAndSend])

  return (
    <div
      className={`voice-agent-page${embedded ? ' voice-agent-page-embedded' : ''}${viewerId ? ' voice-agent-page-split' : ''}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
      // Read `previewVersion` so React actually reflows this subtree
      // when we bind a new preview to an id in a ref (which by itself
      // wouldn't trigger a re-render).
      data-preview-version={previewVersion}
    >
      {/* Animated particle cloud background — represents the thinking AI */}
      <ParticleCloud
        state={state}
        intensity={state === 'thinking' || state === 'speaking' ? 1.2 : 0.8}
      />

      {!embedded && (
        <header className="va-header">
          <Link to="/dashboard" className="va-back" aria-label="Back to dashboard">
            <ArrowLeft size={18} />
          </Link>
          <h1 className="va-title">{convName || 'Voice Agent'}</h1>
          <div className="va-header-spacer" />
          <button className="va-back" onClick={onExit} title="Conversations" aria-label="Back to conversations">
            <MessageSquare size={18} />
          </button>
        </header>
      )}

      {error && (
        <div className="va-error-banner">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button className="va-error-dismiss" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* Canvas: either a centered agent (no viewer) or a full-screen
          document with the agent floating on top (viewer open). */}
      <div className="va-canvas-wrapper">
        {/* Attachments stack on the right side */}
        <div className="va-attachments-stack">
          {attachments.map((a) => {
            const isActive = viewerId === a.id
            return (
              // The card used to be one <button> wrapping the sync and
              // remove buttons. Besides being invalid nesting, whenever
              // the card was disabled (no preview yet) the browser
              // suppressed pointer events for the WHOLE subtree, so the
              // actions inside went dead with it — exactly what happened
              // to every restored attachment after resuming. The open
              // action is now its own button and the others are siblings.
              <div
                key={a.id}
                className={`va-attachment-card va-attachment-${a.source}${isActive ? ' va-attachment-active' : ''}`}
              >
                <button
                  type="button"
                  className="va-attachment-open"
                  title={`Open ${a.label} in viewer · ${a.chars} chars`}
                  onClick={() => openAttachment(a, isActive)}
                >
                  <div className="va-attachment-icon">
                    {a.source === 'url' ? <Globe size={16} />
                      : a.source === 'text' ? <ClipboardPaste size={16} />
                      : <FileText size={16} />}
                  </div>
                  <div className="va-attachment-info">
                    <div className="va-attachment-name">{a.label}</div>
                    <div className="va-attachment-size">{(a.chars / 1024).toFixed(1)}K</div>
                  </div>
                </button>
                {a.refreshable && (
                  <button
                    className={`va-attachment-sync${refreshing.has(a.id) ? ' va-attachment-sync-busy' : ''}`}
                    aria-label={`Reload ${a.label}`}
                    title="Reload the latest version"
                    disabled={refreshing.has(a.id)}
                    onClick={(e) => { e.stopPropagation(); handleRefresh(a.id) }}
                  >
                    <RefreshCw size={13} />
                  </button>
                )}
                {a.source !== 'project-file' && (
                  <button
                    className="va-attachment-remove"
                    aria-label={`Remove ${a.label}`}
                    onClick={(e) => { e.stopPropagation(); handleRemove(a.id) }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            )
          })}
          {attachments.length === 0 && (
            <div className="va-attachments-empty">
              No documents
            </div>
          )}
        </div>

        {/* Main canvas */}
        <div className="va-canvas">
        {viewerId && (
          <div className="va-viewer-full">
            <PreviewFrame
              preview={previewMapRef.current.get(viewerId) || null}
              nonce={refreshNonce[viewerId] || 0}
            />
          </div>
        )}

        <div
          ref={floatPanelRef}
          className={
            viewerId
              ? `va-agent-panel va-float${minimized ? ' minimized' : ''}`
              : 'va-agent-panel va-inline'
          }
          style={
            viewerId && agentPos
              ? { left: agentPos.x, top: agentPos.y, right: 'auto', bottom: 'auto' }
              : undefined
          }
        >
          {/* Header only in the expanded state — minimized is just the
              bubble, and it carries the drag handlers itself. */}
          {viewerId && !minimized && (
            <div
              className="va-float-header"
              onPointerDown={handleAgentDragStart}
              onPointerMove={handleAgentDragMove}
              onPointerUp={handleAgentDragEnd}
              onPointerCancel={handleAgentDragEnd}
            >
              <GripHorizontal size={16} className="va-float-grip" />
              <span className="va-float-title">Voice Agent</span>
              <div className="va-float-header-actions">
                <button
                  className="va-float-btn"
                  onClick={() => setMinimized((v) => !v)}
                  aria-label={minimized ? 'Expand agent panel' : 'Minimize agent panel'}
                  title={minimized ? 'Expand' : 'Minimize'}
                >
                  {minimized ? <Maximize2 size={14} /> : <Minus size={14} />}
                </button>
                <button
                  className="va-float-btn"
                  onClick={() => { setViewerId(null); setMinimized(false) }}
                  aria-label="Close document viewer"
                  title="Close viewer"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}

          {viewerId && minimized ? (
            <div
              className="va-float-mini"
              // Drag lives here now that the header is gone. The start
              // handler ignores pointerdown on buttons, so the mic and
              // expand taps still land.
              onPointerDown={handleAgentDragStart}
              onPointerMove={handleAgentDragMove}
              onPointerUp={handleAgentDragEnd}
              onPointerCancel={handleAgentDragEnd}
            >
              <div
                className="va-mic-wrap va-mic-wrap-mini"
                style={{ '--level': String(Math.min(1, level * 4)) } as React.CSSProperties}
              >
                <span className="va-mic-halo" />
                <button
                  className={`va-mic va-mic-mini va-mic-${recording ? 'recording' : state}`}
                  aria-label={recording ? 'Stop recording and send' : 'Start recording'}
                  onClick={toggleRecording}
                  disabled={state === 'connecting' || state === 'error'}
                >
                  {state === 'connecting' && <Loader2 size={20} className="va-spin" />}
                  {recording && <Square size={16} fill="currentColor" />}
                  {!recording && state !== 'connecting' && <Mic size={20} />}
                </button>
              </div>
              <button
                className="va-float-expand-btn"
                onClick={() => setMinimized(false)}
                aria-label="Expand agent panel"
                title="Expand"
              >
                <Maximize2 size={12} />
              </button>
            </div>
          ) : (
            <>
              {/* Transcript area — now takes top priority (70-80% of space) */}
              {transcript.length > 0 ? (
                <div className="va-transcript-wrap va-transcript-primary">
                  <div className="va-transcript" ref={transcriptRef}>
                    {transcript.map((t) => (
                      <div key={t.id} className={`va-turn va-turn-${t.role}`}>
                        <div className="va-turn-role">{t.role === 'user' ? 'You' : 'Agent'}</div>
                        <div className="va-turn-text">{t.text || (t.role === 'assistant' ? '…' : '')}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="va-empty-state">
                  <div className={`va-state-chip va-state-${recording ? 'recording' : state}`}>
                    <span className={`va-state-dot va-state-dot-${recording ? 'recording' : state}`} />
                    {recording ? 'Recording'
                      : state === 'connecting' ? 'Connecting'
                      : state === 'thinking' ? 'Transcribing'
                      : state === 'speaking' ? 'Speaking'
                      : state === 'error' ? 'Error'
                      : 'Ready'}
                  </div>
                  <p className="va-empty-prompt">Start talking to begin</p>
                </div>
              )}

              {/* Actions bar — always visible (attach, copy, etc.) */}
              <div className="va-actions-bar">
                <button
                  className="va-attach-btn va-attach-btn-icon"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={attaching}
                  title="Attach file"
                >
                  <Paperclip size={18} />
                </button>
                <button
                  className="va-attach-btn va-attach-btn-icon"
                  onClick={() => setUrlOpen((v) => !v)}
                  disabled={attaching}
                  title="Attach URL"
                >
                  <LinkIcon size={18} />
                </button>
                {transcript.length > 0 && (
                  <button
                    className={`va-attach-btn va-attach-btn-icon${justSaved ? ' va-attach-btn-copied' : ''}`}
                    onClick={openSaveModal}
                    title={convName ? `Save changes to "${convName}"` : 'Save conversation'}
                    aria-label="Save conversation"
                  >
                    {justSaved ? <Check size={18} /> : <Save size={18} />}
                  </button>
                )}
                <button
                  className="va-attach-btn va-attach-btn-icon"
                  onClick={() => setTextOpen(true)}
                  disabled={attaching}
                  title="Paste text"
                  aria-label="Paste text as a document"
                >
                  <ClipboardPaste size={18} />
                </button>
                <button
                  className="va-attach-btn va-attach-btn-icon va-lang-btn"
                  onClick={toggleLanguage}
                  aria-label={language === 'es' ? 'Cambiar a inglés' : 'Switch to Spanish'}
                  title={language === 'es' ? 'Hablando español — cambiar a inglés' : 'Speaking English — switch to Spanish'}
                >
                  <Languages size={18} />
                  <span className="va-lang-tag">{language.toUpperCase()}</span>
                </button>
                {transcript.length > 0 && (
                  <button
                    className={`va-attach-btn va-attach-btn-icon${justCopied ? ' va-attach-btn-copied' : ''}`}
                    onClick={copyConversation}
                    aria-label="Copy conversation to clipboard"
                    title="Copy conversation"
                  >
                    {justCopied ? <Check size={18} /> : <Copy size={18} />}
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.md,.markdown,.txt,.html,.htm,.json"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void handleFilePick(f)
                    e.target.value = ''
                  }}
                />
              </div>

              {saveOpen && (
                <div className="va-modal-backdrop" onClick={() => setSaveOpen(false)}>
                  <div
                    className="va-modal va-modal-sm"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Save conversation"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="va-modal-header">
                      <Save size={16} />
                      <span>{convName ? 'Save changes' : 'Save conversation'}</span>
                      <button className="va-modal-close" onClick={() => setSaveOpen(false)} aria-label="Close">
                        <X size={14} />
                      </button>
                    </div>
                    <div className="va-modal-body">
                      <input
                        type="text"
                        className="va-url-input"
                        placeholder="Name this conversation…"
                        value={saveDraft}
                        onChange={(e) => setSaveDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveSubmit()
                          if (e.key === 'Escape') setSaveOpen(false)
                        }}
                        autoFocus
                      />
                      <p className="va-modal-hint">
                        {transcript.length} turn{transcript.length === 1 ? '' : 's'} and {attachments.length} document
                        {attachments.length === 1 ? '' : 's'} will be stored, so you can pick
                        this back up later.
                      </p>
                    </div>
                    <div className="va-modal-footer">
                      <button
                        className="va-url-submit"
                        onClick={handleSaveSubmit}
                        disabled={!saveDraft.trim()}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {textOpen && (
                <div
                  className="va-modal-backdrop"
                  onClick={() => { setTextOpen(false); setTextDraft('') }}
                >
                  <div
                    className="va-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Paste text as a document"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="va-modal-header">
                      <ClipboardPaste size={16} />
                      <span>Paste text</span>
                      <button
                        className="va-modal-close"
                        onClick={() => { setTextOpen(false); setTextDraft('') }}
                        aria-label="Close"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <textarea
                      className="va-modal-textarea"
                      placeholder="Paste anything here — a Slack thread, an email, notes…"
                      value={textDraft}
                      onChange={(e) => setTextDraft(e.target.value)}
                      onKeyDown={(e) => {
                        // Enter inserts a newline (this is a textarea);
                        // Cmd/Ctrl+Enter is the submit gesture.
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleTextSubmit()
                        if (e.key === 'Escape') { setTextOpen(false); setTextDraft('') }
                      }}
                      autoFocus
                    />
                    <div className="va-modal-footer">
                      <span className="va-modal-count">
                        {textDraft.trim().length.toLocaleString()} chars
                      </span>
                      <button
                        className="va-url-submit"
                        onClick={handleTextSubmit}
                        disabled={!textDraft.trim() || attaching}
                      >
                        Attach
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {urlOpen && (
                <div className="va-url-form">
                  <input
                    type="url"
                    className="va-url-input"
                    placeholder="https://…"
                    value={urlDraft}
                    onChange={(e) => setUrlDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleUrlSubmit()
                      if (e.key === 'Escape') { setUrlOpen(false); setUrlDraft('') }
                    }}
                    autoFocus
                  />
                  <button
                    className="va-url-submit"
                    onClick={handleUrlSubmit}
                    disabled={!urlDraft.trim() || attaching}
                  >
                    Fetch
                  </button>
                </div>
              )}

              {/* Mic control — now small and centered at bottom */}
              <div className="va-mic-dock">
                <div
                  className="va-mic-wrap"
                  style={{ '--level': String(Math.min(1, level * 4)) } as React.CSSProperties}
                >
                  <span className="va-mic-halo" />
                  <button
                    className={`va-mic va-mic-compact va-mic-${recording ? 'recording' : state}`}
                    aria-label={recording ? 'Stop recording and send' : 'Start recording'}
                    onClick={toggleRecording}
                    disabled={state === 'connecting' || state === 'error'}
                  >
                    {state === 'connecting' && <Loader2 size={24} className="va-spin" />}
                    {recording && <Square size={18} fill="currentColor" />}
                    {!recording && state !== 'connecting' && <Mic size={24} />}
                  </button>
                </div>
                <div className="va-mic-label-compact">{micLabel}</div>
              </div>
            </>
          )}
        </div>
      </div>
      </div>
    </div>
  )
}


// ---- Preview frame ------------------------------------------------

/**
 * Renders the source of an attachment inside the viewer background.
 * PDFs and images render natively from a blob URL. URLs are embedded
 * through `resolveEmbed` below, which keeps them renderable even when
 * the remote refuses to be framed. "Open in new tab" stays as the
 * escape hatch for the pathological cases (login walls, framebusters).
 */
type Preview = { kind: 'blob' | 'url'; src: string; mime?: string; label: string }

/**
 * Decide how to put a remote URL inside our iframe.
 *
 * Same-origin URLs load directly — full fidelity, scripts and all.
 * Anything else goes through `/api/files/proxy`, which re-serves the
 * document from our own host so the remote's `X-Frame-Options` / CSP
 * `frame-ancestors` can't block the embed. That's not an exotic case:
 * another Orka server on the tailnet pins `frame-ancestors` too, so
 * laptop→desktop preview links hit it every time.
 *
 * Proxied documents lose `allow-same-origin` in the sandbox — they're
 * served from our origin but are NOT our content, so they must not be
 * able to read our storage or call our APIs with our credentials.
 */
function resolveEmbed(raw: string): { src: string; sandbox: string; proxied: boolean } {
  // The attached URL is loaded VERBATIM — query params included. An
  // earlier revision stripped `?voice=1` / `?comments=1` off Orka
  // preview links to avoid nesting a second voice widget; it turned
  // out to break more than it fixed, and the URL the user attached is
  // the URL they expect to see.
  let u: URL
  try {
    u = new URL(raw, window.location.href)
  } catch {
    return { src: raw, sandbox: 'allow-scripts allow-forms allow-popups', proxied: false }
  }

  if (u.origin === window.location.origin) {
    return { src: raw, sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups', proxied: false }
  }
  return {
    src: `/api/files/proxy?url=${encodeURIComponent(raw)}`,
    sandbox: 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox',
    proxied: true,
  }
}
function PreviewFrame({ preview, nonce = 0 }: { preview: Preview | null; nonce?: number }) {
  if (!preview) {
    return (
      <div className="va-preview-empty">
        <FileText size={32} />
        <span>No preview available for this attachment.</span>
      </div>
    )
  }
  if (preview.kind === 'blob') {
    if (preview.mime?.startsWith('image/')) {
      return <img src={preview.src} alt={preview.label} className="va-preview-image" />
    }
    // PDFs, HTML, text — browser handles content-type from the mime
    // of the underlying Blob (URL.createObjectURL preserves it).
    return (
      <iframe
        src={preview.src}
        title={preview.label}
        className="va-preview-iframe"
      />
    )
  }
  // preview.kind === 'url'
  const embed = resolveEmbed(preview.src)
  return (
    <div className="va-preview-url">
      <iframe
        // Remount on reload: the src is unchanged, so without a new key
        // the browser keeps showing the copy it already painted.
        key={`${embed.src}#${nonce}`}
        src={embed.src}
        title={preview.label}
        className="va-preview-iframe"
        sandbox={embed.sandbox}
        referrerPolicy="no-referrer"
      />
      <div className="va-preview-url-hint">
        <span>{embed.proxied ? 'Served through Orka to allow embedding.' : 'Embedded page'}</span>
        <a href={preview.src} target="_blank" rel="noopener noreferrer">
          Open in new tab ↗
        </a>
      </div>
    </div>
  )
}

// ---- Conversation picker + page shell -------------------------------

interface ConversationSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  project: string
  language: string
  turnCount: number
  attachmentCount: number
  preview: string
}

function relativeTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

/**
 * Landing screen: pick up where you left off, or start fresh.
 *
 * Deliberately NOT shown for the document flow (`?path=`), where the
 * caller already decided what the conversation is about — a preview
 * page's mic button should open a mic, not a menu.
 */
export function VoiceAgentPage() {
  const [searchParams] = useSearchParams()
  const embedded = searchParams.get('embedded') === '1'
  const pathParam = searchParams.get('path')
  const conversationParam = searchParams.get('conversation')

  // `null` = show the picker. A started session is identified by
  // `{ key }`, which doubles as the remount key for VoiceAgentSession.
  const [session, setSession] = useState<{ key: string; conversationId: string | null } | null>(
    // A document-scoped or deep-linked entry skips the picker entirely.
    pathParam || conversationParam
      ? { key: conversationParam || 'doc', conversationId: conversationParam }
      : null
  )
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/voice/conversations')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setConversations(Array.isArray(data.conversations) ? data.conversations : [])
    } catch (err: any) {
      setPickerError(err?.message || 'could not load conversations')
      setConversations([])
    }
  }, [])

  useEffect(() => {
    if (session) return
    void loadConversations()
  }, [session, loadConversations])

  const handleDelete = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/voice/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setConversations((prev) => (prev || []).filter((c) => c.id !== id))
    } catch (err: any) {
      setPickerError(err?.message || 'could not delete conversation')
    } finally {
      setConfirmDelete(null)
    }
  }, [])

  if (session) {
    return (
      <VoiceAgentSession
        key={session.key}
        conversationId={session.conversationId}
        onExit={() => setSession(null)}
      />
    )
  }

  return (
    <div className={`voice-agent-page${embedded ? ' voice-agent-page-embedded' : ''}`}>
      <ParticleCloud state="idle" intensity={0.8} />

      {!embedded && (
        <header className="va-header">
          <Link to="/dashboard" className="va-back" aria-label="Back to dashboard">
            <ArrowLeft size={18} />
          </Link>
          <h1 className="va-title">Voice Agent</h1>
          <div className="va-header-spacer" />
        </header>
      )}

      {pickerError && (
        <div className="va-error-banner">
          <AlertTriangle size={16} />
          <span>{pickerError}</span>
          <button className="va-error-dismiss" onClick={() => setPickerError(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="va-picker">
        <button
          className="va-picker-new"
          onClick={() => setSession({ key: `new-${Date.now()}`, conversationId: null })}
        >
          <Plus size={18} />
          <span>New conversation</span>
        </button>

        {conversations === null && <div className="va-picker-empty">Loading…</div>}

        {conversations !== null && conversations.length === 0 && (
          <div className="va-picker-empty">
            No saved conversations yet. Start one and hit save when it&apos;s worth keeping.
          </div>
        )}

        {conversations !== null && conversations.length > 0 && (
          <>
            <div className="va-picker-heading">Saved</div>
            <div className="va-picker-list">
              {conversations.map((c) => (
                <div key={c.id} className="va-picker-row">
                  <button
                    className="va-picker-open"
                    onClick={() => setSession({ key: c.id, conversationId: c.id })}
                    title={`Resume "${c.name}"`}
                  >
                    <MessageSquare size={16} className="va-picker-icon" />
                    <div className="va-picker-info">
                      <div className="va-picker-name">{c.name}</div>
                      <div className="va-picker-meta">
                        {relativeTime(c.updatedAt)} · {c.turnCount} turn{c.turnCount === 1 ? '' : 's'}
                        {c.attachmentCount > 0 && ` · ${c.attachmentCount} doc${c.attachmentCount === 1 ? '' : 's'}`}
                        {' · '}{c.language.toUpperCase()}
                      </div>
                      {c.preview && <div className="va-picker-preview">{c.preview}</div>}
                    </div>
                  </button>
                  {confirmDelete === c.id ? (
                    <div className="va-picker-confirm">
                      <button className="va-picker-confirm-yes" onClick={() => handleDelete(c.id)}>
                        Delete
                      </button>
                      <button className="va-picker-confirm-no" onClick={() => setConfirmDelete(null)}>
                        <ChevronLeft size={14} />
                      </button>
                    </div>
                  ) : (
                    <button
                      className="va-picker-delete"
                      onClick={() => setConfirmDelete(c.id)}
                      aria-label={`Delete ${c.name}`}
                      title="Delete"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
