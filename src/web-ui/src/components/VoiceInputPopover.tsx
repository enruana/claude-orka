import { useEffect, useRef, useCallback, useState } from 'react'
import { Mic, MicOff, Send, X, Loader2, Copy, Check } from 'lucide-react'
import { useVoiceInput } from '../hooks/useVoiceInput'

const BAR_COUNT = 6

function AudioBars({ analyser }: { analyser: AnalyserNode }) {
  const barsRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)

  const tick = useCallback(() => {
    const data = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(data)

    // Average groups of frequency bins into BAR_COUNT bars
    const binGroup = Math.floor(data.length / BAR_COUNT)
    const bars = barsRef.current?.children
    if (bars) {
      for (let i = 0; i < BAR_COUNT; i++) {
        let sum = 0
        for (let j = 0; j < binGroup; j++) {
          sum += data[i * binGroup + j]
        }
        const level = sum / binGroup / 255
        ;(bars[i] as HTMLElement).style.height = `${Math.max(8, level * 100)}%`
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [analyser])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [tick])

  return (
    <div className="audio-bars" ref={barsRef}>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <div key={i} className="audio-bar" />
      ))}
    </div>
  )
}

interface VoiceInputPopoverProps {
  isOpen: boolean
  onClose: () => void
  onSend: (text: string) => void
  sendLabel?: string
}

export function VoiceInputPopover({ isOpen, onClose, onSend, sendLabel = 'Send' }: VoiceInputPopoverProps) {
  const voice = useVoiceInput()
  const popoverRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  // Click outside to dismiss
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        handleClose()
      }
    }

    // Delay listener to avoid the opening click from immediately closing
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Reset state when closing
  const handleClose = () => {
    voice.reset()
    onClose()
  }

  const handleSend = () => {
    if (voice.transcribedText.trim()) {
      onSend(voice.transcribedText.trim())
      voice.reset()
      onClose()
    }
  }

  if (!isOpen) return null

  return (
    <div className="voice-modal" ref={popoverRef}>
      <div className="voice-modal-header">
        <h3>Voice Input</h3>
        <button className="voice-modal-close" onClick={handleClose}>
          <X size={18} />
        </button>
      </div>

      <div className="voice-modal-content">
        {/* Language selector - visible when idle */}
        {!voice.isRecording && !voice.isTranscribing && (
          <div className="voice-language-selector">
            <button
              className={`voice-lang-btn ${voice.language === 'es' ? 'active' : ''}`}
              onClick={() => voice.setLanguage('es')}
            >
              ES
            </button>
            <button
              className={`voice-lang-btn ${voice.language === 'en' ? 'active' : ''}`}
              onClick={() => voice.setLanguage('en')}
            >
              EN
            </button>
            <button
              className={`voice-lang-btn ${voice.language === 'auto' ? 'active' : ''}`}
              onClick={() => voice.setLanguage('auto')}
            >
              Auto
            </button>
          </div>
        )}

        {/* Idle state */}
        {!voice.isRecording && !voice.isTranscribing && !voice.transcribedText && !voice.error && (
          <div className="voice-modal-idle">
            <p>Click to start recording</p>
            <button className="voice-record-btn" onClick={voice.startRecording}>
              <Mic size={32} />
            </button>
          </div>
        )}

        {/* Recording in progress */}
        {voice.isRecording && (
          <div className="voice-modal-recording">
            <div className="recording-indicator">
              <span className="recording-dot" />
              <span>Recording...</span>
            </div>
            {voice.analyserNode && <AudioBars analyser={voice.analyserNode} />}
            <button className="voice-stop-btn" onClick={voice.stopRecording}>
              <MicOff size={32} />
              <span>Stop Recording</span>
            </button>
          </div>
        )}

        {/* Transcribing */}
        {voice.isTranscribing && (
          <div className="voice-modal-transcribing">
            <Loader2 size={32} className="spinner" />
            <p>Transcribing audio...</p>
          </div>
        )}

        {/* Error state */}
        {voice.error && (
          <div className="voice-modal-error">
            <p className="error-text">{voice.error}</p>
            <button className="voice-retry-btn" onClick={() => { voice.setLanguage(voice.language); voice.startRecording(); }}>
              <Mic size={20} />
              <span>Try Again</span>
            </button>
          </div>
        )}

        {/* Transcription result */}
        {voice.transcribedText && !voice.error && (
          <div className="voice-modal-result">
            <textarea
              className="transcription-text"
              value={voice.transcribedText}
              onChange={(e) => voice.setTranscribedText(e.target.value)}
              placeholder="Transcribed text..."
            />
            <div className="voice-modal-actions">
              <button className="voice-retry-btn" onClick={() => { voice.setTranscribedText(''); voice.startRecording(); }}>
                <Mic size={16} />
                <span>Re-record</span>
              </button>
              <button
                className="voice-copy-btn"
                onClick={() => {
                  navigator.clipboard.writeText(voice.transcribedText.trim())
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
                title="Copy to clipboard"
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
              <button className="voice-send-btn" onClick={handleSend}>
                <Send size={16} />
                <span>{sendLabel}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
