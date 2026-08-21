import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Mic, Paperclip, Link as LinkIcon, X, Loader2,
  AlertTriangle, FileText, Globe, Square, Minus, Maximize2, GripHorizontal, Copy, Check,
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
  source: 'upload' | 'url' | 'project-file'
  label: string
  chars: number
  addedAt: number
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

export function VoiceAgentPage() {
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

  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const playbackQueueRef = useRef<AudioBuffer[]>([])
  const playbackNodeRef = useRef<AudioBufferSourceNode | null>(null)
  const playbackTailRef = useRef<number>(0)
  const transcriptRef = useRef<HTMLDivElement>(null)
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
  useLayoutEffect(() => {
    const el = transcriptRef.current
    if (!el) return
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
  }, [])

  const stopPlayback = useCallback(() => {
    try { playbackNodeRef.current?.stop() } catch { /* ignore */ }
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
        const url = `${proto}//${window.location.host}/api/voice/live?project=${projectQs}${pathQs}`
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
              }
              setState('idle')
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
            case 'attachment-added': {
              setAttachments((prev) => [
                ...prev,
                {
                  id: msg.id,
                  source: msg.source,
                  label: msg.label,
                  chars: msg.chars,
                  addedAt: msg.addedAt,
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
              // Drop the queued preview whose upload just failed —
              // otherwise it'd bind to the NEXT successful attachment.
              const failed = pendingPreviewsRef.current.shift()
              if (failed?.kind === 'blob') URL.revokeObjectURL(failed.src)
              // Auto-clear the error banner after 4s so the UI doesn't
              // permanently look broken over a transient upload issue.
              setTimeout(() => setError(null), 4000)
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
          <h1 className="va-title">Voice Agent</h1>
          <div className="va-header-spacer" />
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

      <div className="va-attachments">
        {attachments.map((a) => {
          const hasPreview = previewMapRef.current.has(a.id)
          const isActive = viewerId === a.id
          return (
            <button
              type="button"
              key={a.id}
              className={`va-chip va-chip-${a.source}${isActive ? ' va-chip-active' : ''}${hasPreview ? ' va-chip-clickable' : ''}`}
              title={hasPreview ? `Open ${a.label} in viewer · ${a.chars} chars` : `${a.chars} chars (no preview available)`}
              onClick={() => { if (hasPreview) setViewerId(isActive ? null : a.id) }}
              disabled={!hasPreview}
            >
              {a.source === 'url' ? <Globe size={12} /> : <FileText size={12} />}
              <span className="va-chip-label">{a.label}</span>
              {a.source !== 'project-file' && (
                <span
                  className="va-chip-remove"
                  role="button"
                  tabIndex={0}
                  aria-label={`Remove ${a.label}`}
                  onClick={(e) => { e.stopPropagation(); handleRemove(a.id) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation(); e.preventDefault(); handleRemove(a.id)
                    }
                  }}
                >
                  <X size={12} />
                </span>
              )}
            </button>
          )
        })}
        {attachments.length === 0 && (
          <div className="va-attachments-empty">
            No documents yet. Attach a PDF, drop a file, or paste a URL to get started.
          </div>
        )}
        {totalChars > 0 && (
          <div className="va-attachments-total">
            {(totalChars / 1024).toFixed(1)}K chars total
          </div>
        )}
      </div>

      {/* Canvas: either a centered agent (no viewer) or a full-screen
          document with the agent floating on top (viewer open). */}
      <div className="va-canvas">
        {viewerId && (
          <div className="va-viewer-full">
            <PreviewFrame
              preview={previewMapRef.current.get(viewerId) || null}
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
          {viewerId && (
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
            <div className="va-float-mini">
              <div className="va-mini-content">
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
                <span className={`va-state-dot va-state-dot-${recording ? 'recording' : state}`} />
              </div>
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
  )
}


// ---- Preview frame ------------------------------------------------

/**
 * Renders the source of an attachment inside the viewer background.
 * PDFs and images render natively from a blob URL. URLs iframe the
 * remote origin — sites with `X-Frame-Options: DENY` won't render;
 * we show a small hint + "Open in new tab" fallback so the user has
 * an escape hatch.
 */
type Preview = { kind: 'blob' | 'url'; src: string; mime?: string; label: string }
function PreviewFrame({ preview }: { preview: Preview | null }) {
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
  return (
    <div className="va-preview-url">
      <iframe
        src={preview.src}
        title={preview.label}
        className="va-preview-iframe"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        referrerPolicy="no-referrer"
      />
      <div className="va-preview-url-hint">
        <span>Can&apos;t see the page? Some sites block embedding.</span>
        <a href={preview.src} target="_blank" rel="noopener noreferrer">
          Open in new tab ↗
        </a>
      </div>
    </div>
  )
}
