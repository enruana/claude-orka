import { useState, useEffect, useRef } from 'react'
import { X, Mic, MicOff, Send } from 'lucide-react'
import { useVoiceInput } from '../hooks/useVoiceInput'

interface AddCommentDialogProps {
  filePath: string
  startLine: number
  endLine: number
  selectedText: string
  onSave: (body: string) => void
  onCancel: () => void
}

export function AddCommentDialog({
  filePath,
  startLine,
  endLine,
  selectedText,
  onSave,
  onCancel,
}: AddCommentDialogProps) {
  const [body, setBody] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const voice = useVoiceInput()

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // When voice transcription completes, append to body
  useEffect(() => {
    if (voice.transcribedText) {
      setBody(prev => prev ? `${prev} ${voice.transcribedText}` : voice.transcribedText)
      voice.setTranscribedText('')
    }
  }, [voice.transcribedText]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = () => {
    const trimmed = body.trim()
    if (!trimmed) return
    onSave(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSave()
    }
    if (e.key === 'Escape') {
      onCancel()
    }
  }

  const fileName = filePath.split('/').pop() || filePath
  const lineLabel = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`

  return (
    <>
      <style>{`
        .add-comment-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.5);
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
        }
        .add-comment-dialog {
          background: var(--bg-secondary);
          border: 1px solid var(--border-primary);
          border-radius: var(--radius-lg);
          width: 100%;
          max-width: 480px;
          box-shadow: var(--shadow-xl);
          display: flex;
          flex-direction: column;
        }
        .add-comment-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border-primary);
        }
        .add-comment-header h3 {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
          margin: 0;
        }
        .add-comment-close {
          background: none;
          border: none;
          color: var(--text-tertiary);
          cursor: pointer;
          padding: 4px;
          border-radius: var(--radius-sm);
        }
        .add-comment-close:hover {
          color: var(--text-primary);
          background: var(--bg-hover);
        }
        .add-comment-body {
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .add-comment-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: var(--text-secondary);
        }
        .add-comment-meta .file-badge {
          background: var(--bg-tertiary);
          padding: 2px 8px;
          border-radius: var(--radius-sm);
          font-family: monospace;
          font-size: 11px;
        }
        .add-comment-meta .line-badge {
          background: rgba(10,132,255,0.15);
          color: var(--accent-blue);
          padding: 2px 8px;
          border-radius: var(--radius-sm);
          font-family: monospace;
          font-size: 11px;
          font-weight: 600;
        }
        .add-comment-snippet {
          background: var(--bg-tertiary);
          border: 1px solid var(--border-primary);
          border-radius: var(--radius-sm);
          padding: 8px 12px;
          font-family: monospace;
          font-size: 12px;
          color: var(--text-secondary);
          max-height: 80px;
          overflow-y: auto;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .add-comment-input-row {
          display: flex;
          gap: 8px;
        }
        .add-comment-textarea {
          flex: 1;
          background: var(--bg-primary);
          border: 1px solid var(--border-primary);
          border-radius: var(--radius-md);
          padding: 10px 12px;
          color: var(--text-primary);
          font-size: 13px;
          font-family: inherit;
          resize: vertical;
          min-height: 60px;
          max-height: 150px;
          outline: none;
        }
        .add-comment-textarea:focus {
          border-color: var(--accent-blue);
        }
        .add-comment-textarea::placeholder {
          color: var(--text-tertiary);
        }
        .add-comment-voice-btn {
          width: 40px;
          height: 40px;
          border-radius: var(--radius-md);
          border: 1px solid var(--border-primary);
          background: var(--bg-primary);
          color: var(--text-secondary);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          align-self: flex-end;
        }
        .add-comment-voice-btn:hover {
          background: var(--bg-hover);
          color: var(--text-primary);
        }
        .add-comment-voice-btn.recording {
          background: rgba(255,69,58,0.15);
          border-color: var(--accent-red);
          color: var(--accent-red);
          animation: pulse-recording 1.5s ease-in-out infinite;
        }
        .add-comment-voice-btn.transcribing {
          opacity: 0.6;
          cursor: wait;
        }
        @keyframes pulse-recording {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        .add-comment-footer {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          padding: 12px 16px;
          border-top: 1px solid var(--border-primary);
        }
        .add-comment-footer button {
          padding: 6px 16px;
          border-radius: var(--radius-md);
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          border: 1px solid var(--border-primary);
        }
        .add-comment-cancel {
          background: var(--bg-tertiary);
          color: var(--text-primary);
        }
        .add-comment-cancel:hover {
          background: var(--bg-hover);
        }
        .add-comment-save {
          background: var(--accent-blue);
          color: white;
          border-color: var(--accent-blue) !important;
        }
        .add-comment-save:hover {
          background: var(--accent-blue-hover);
        }
        .add-comment-save:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .add-comment-error {
          font-size: 12px;
          color: var(--accent-red);
        }
        .add-comment-hint {
          font-size: 11px;
          color: var(--text-tertiary);
          text-align: right;
        }
      `}</style>

      <div className="add-comment-overlay" onClick={onCancel}>
        <div className="add-comment-dialog" onClick={e => e.stopPropagation()} onKeyDown={handleKeyDown}>
          <div className="add-comment-header">
            <h3>Add Comment</h3>
            <button className="add-comment-close" onClick={onCancel}>
              <X size={16} />
            </button>
          </div>

          <div className="add-comment-body">
            <div className="add-comment-meta">
              <span className="file-badge">{fileName}</span>
              <span className="line-badge">{lineLabel}</span>
            </div>

            {selectedText && (
              <div className="add-comment-snippet">
                {selectedText.length > 200 ? selectedText.slice(0, 200) + '...' : selectedText}
              </div>
            )}

            <div className="add-comment-input-row">
              <textarea
                ref={textareaRef}
                className="add-comment-textarea"
                value={body}
                onChange={e => setBody(e.target.value)}
                placeholder="Write your comment..."
                rows={3}
              />
              <button
                className={`add-comment-voice-btn ${voice.isRecording ? 'recording' : ''} ${voice.isTranscribing ? 'transcribing' : ''}`}
                onClick={() => {
                  if (voice.isRecording) {
                    voice.stopRecording()
                  } else if (!voice.isTranscribing) {
                    voice.startRecording()
                  }
                }}
                disabled={voice.isTranscribing}
                title={voice.isRecording ? 'Stop recording' : 'Record voice comment'}
              >
                {voice.isRecording ? <MicOff size={18} /> : <Mic size={18} />}
              </button>
            </div>

            {voice.error && <div className="add-comment-error">{voice.error}</div>}
            <div className="add-comment-hint">Ctrl+Enter to save</div>
          </div>

          <div className="add-comment-footer">
            <button className="add-comment-cancel" onClick={onCancel}>Cancel</button>
            <button className="add-comment-save" onClick={handleSave} disabled={!body.trim()}>
              <Send size={14} style={{ marginRight: 6 }} />
              Save Comment
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
