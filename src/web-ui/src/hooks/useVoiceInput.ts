import { useState, useRef, useCallback } from 'react'

export type VoiceLanguage = 'es' | 'en' | 'auto'

export interface UseVoiceInputReturn {
  isRecording: boolean
  isTranscribing: boolean
  transcribedText: string
  error: string | null
  language: VoiceLanguage
  analyserNode: AnalyserNode | null
  startRecording: () => Promise<void>
  stopRecording: () => void
  setTranscribedText: (text: string) => void
  setLanguage: (lang: VoiceLanguage) => void
  reset: () => void
}

export function useVoiceInput(): UseVoiceInputReturn {
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [transcribedText, setTranscribedText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [language, setLanguage] = useState<VoiceLanguage>('es')

  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioContextRef = useRef<AudioContext | null>(null)

  /**
   * Job-based upload + poll. Kept as the fallback path: it spawns a
   * fresh whisper-cli per request (model reload every time) and polls
   * on a 2s timer, so it is several seconds slower than /direct. Only
   * reached when the direct route is unavailable (older server).
   */
  const transcribeViaJob = useCallback(async (audioBlob: Blob, mimeType: string, lang: VoiceLanguage) => {
    const uploadResponse = await fetch(`/api/transcribe?language=${lang}`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType },
      body: audioBlob
    })

    if (!uploadResponse.ok) {
      const err = await uploadResponse.json().catch(() => ({ error: 'Upload failed' }))
      throw new Error(err.message || err.error || 'Upload failed')
    }

    const { jobId } = await uploadResponse.json()
    if (!jobId) throw new Error('No job ID returned')

    const maxAttempts = 300
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 2000))

      const pollResponse = await fetch(`/api/transcribe/job/${jobId}`)
      if (!pollResponse.ok) throw new Error('Failed to check status')

      const result = await pollResponse.json()

      if (result.status === 'completed') return (result.text || '').trim()
      if (result.status === 'error') throw new Error(result.error || 'Transcription failed')
    }

    throw new Error('Transcription timed out')
  }, [])

  /**
   * Same pipeline the voice agent uses: one request, one answer, served
   * off the persistent whisper-server (model already in RAM). Typically
   * ~1s for a short dictation vs ~6-10s on the job route.
   */
  const transcribeAudio = useCallback(async (audioBlob: Blob, mimeType: string, lang: VoiceLanguage) => {
    try {
      let text = ''
      let routeMissing = false
      try {
        const res = await fetch(`/api/transcribe/direct?language=${lang}`, {
          method: 'POST',
          headers: { 'Content-Type': mimeType },
          body: audioBlob
        })
        // A 404 means the server predates this route — that's the only
        // case worth paying for a second, slower attempt. Any other
        // failure (bad audio, whisper down) would fail on the job route
        // too, so we surface it instead of stalling the user for ~10s.
        if (res.status === 404) routeMissing = true
        if (!routeMissing) {
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.message || err.error || `Transcription failed (${res.status})`)
          }
          text = ((await res.json()).text || '').trim()
        }
      } catch (directErr: any) {
        // fetch() itself threw → the request never landed (offline,
        // server restarting). Worth one retry on the legacy route.
        if (directErr instanceof TypeError) routeMissing = true
        else throw directErr
      }

      if (routeMissing) {
        console.warn('Direct transcription unavailable, falling back to job flow')
        text = await transcribeViaJob(audioBlob, mimeType, lang)
      }

      if (!text) {
        setError('No speech detected. Please try again.')
      } else {
        setTranscribedText(text)
      }
    } catch (err: any) {
      console.error('Transcription error:', err)
      setError(`Transcription failed: ${err.message}`)
    } finally {
      setIsTranscribing(false)
    }
  }, [transcribeViaJob])

  const startRecording = useCallback(async () => {
    try {
      setError(null)
      setTranscribedText('')

      // Kick the persistent whisper-server awake while the user is still
      // speaking, so the first transcription doesn't pay the model-load
      // cost. Fire-and-forget — failure just means the normal path runs.
      void fetch('/api/transcribe/warmup', { method: 'POST' }).catch(() => {})

      // Pre-flight check: getUserMedia requires HTTPS or localhost.
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const isSecure = window.location.protocol === 'https:' ||
          window.location.hostname === 'localhost' ||
          window.location.hostname === '127.0.0.1'
        setError(isSecure
          ? 'Microphone API not supported in this browser.'
          : 'Microphone requires HTTPS. Open this page via https:// or localhost.')
        return
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000
        }
      })

      // iOS Safari only supports MP4/AAC for MediaRecorder. Other browsers prefer WebM/Opus.
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

      const mimeCandidates = isIOS
        ? ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/aac', 'audio/wav', 'audio/webm']
        : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/wav']

      let mimeType = ''
      for (const t of mimeCandidates) {
        try {
          if (MediaRecorder.isTypeSupported(t)) { mimeType = t; break }
        } catch { /* ignore */ }
      }

      // Set up AudioContext + AnalyserNode for amplitude visualization
      const audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 128
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser)
      audioContextRef.current = audioContext
      setAnalyserNode(analyser)

      const mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      // If we let the browser pick, use whatever it actually chose
      const effectiveMimeType = mimeType || mediaRecorder.mimeType || 'audio/webm'
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data)
        }
      }

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop())
        audioContextRef.current?.close()
        audioContextRef.current = null
        setAnalyserNode(null)

        if (audioChunksRef.current.length === 0) {
          setError('No audio recorded')
          setIsRecording(false)
          return
        }

        const audioBlob = new Blob(audioChunksRef.current, { type: effectiveMimeType })
        await transcribeAudio(audioBlob, effectiveMimeType, language)
      }

      mediaRecorder.start()
      setIsRecording(true)
    } catch (err: any) {
      console.error('Failed to start recording:', err)
      if (err.name === 'NotAllowedError') {
        setError('Microphone access denied. Please allow microphone access.')
      } else if (err.name === 'NotFoundError') {
        setError('No microphone found.')
      } else {
        setError(`Recording failed: ${err.message}`)
      }
    }
  }, [language, transcribeAudio])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
      setIsTranscribing(true)
    }
  }, [])

  const reset = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    audioContextRef.current?.close()
    audioContextRef.current = null
    setAnalyserNode(null)
    setIsRecording(false)
    setIsTranscribing(false)
    setTranscribedText('')
    setError(null)
  }, [])

  return {
    isRecording,
    isTranscribing,
    transcribedText,
    error,
    language,
    analyserNode,
    startRecording,
    stopRecording,
    setTranscribedText,
    setLanguage,
    reset,
  }
}
