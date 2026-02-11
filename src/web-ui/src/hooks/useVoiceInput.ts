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

  const transcribeAudio = useCallback(async (audioBlob: Blob, mimeType: string, lang: VoiceLanguage) => {
    try {
      const response = await fetch(`/api/transcribe?language=${lang}`, {
        method: 'POST',
        headers: { 'Content-Type': mimeType },
        body: audioBlob
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Transcription failed' }))
        throw new Error(err.message || err.error || 'Transcription failed')
      }

      const result = await response.json()

      if (!result.text || result.text.trim() === '') {
        setError('No speech detected. Please try again.')
      } else {
        setTranscribedText(result.text.trim())
      }
    } catch (err: any) {
      console.error('Transcription error:', err)
      setError(`Transcription failed: ${err.message}`)
    } finally {
      setIsTranscribing(false)
    }
  }, [])

  const startRecording = useCallback(async () => {
    try {
      setError(null)
      setTranscribedText('')

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000
        }
      })

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : 'audio/webm'

      // Set up AudioContext + AnalyserNode for amplitude visualization
      const audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 128
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser)
      audioContextRef.current = audioContext
      setAnalyserNode(analyser)

      const mediaRecorder = new MediaRecorder(stream, { mimeType })
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

        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType })
        await transcribeAudio(audioBlob, mimeType, language)
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
