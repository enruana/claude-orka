import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, AIQueryContext } from '../api/client'
import './quick-ai-dialog.css'

interface QuickAIDialogProps {
  open: boolean
  onClose: () => void
  contextType: 'terminal' | 'code' | 'none'
  contextLabel: string
  getContext: () => Promise<Omit<AIQueryContext, 'type'>>
}

// Separate response tooltip that persists after dialog closes
interface AIResponse {
  answer: string
  question: string
}

export function QuickAIDialog({ open, onClose, contextType, contextLabel, getContext }: QuickAIDialogProps) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<AIResponse | null>(null)
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when dialog opens
  useEffect(() => {
    if (open) {
      setQuery('')
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // Handle Escape to close response tooltip
  useEffect(() => {
    if (!response) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setResponse(null)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [response])

  const handleSubmit = useCallback(async () => {
    const q = query.trim()
    if (!q || loading) return

    setLoading(true)
    onClose() // Close dialog immediately, loading continues

    try {
      const contextData = await getContext()
      const context: AIQueryContext = { type: contextType, ...contextData }
      const result = await api.aiQuery(q, context)
      setResponse({ answer: result.answer, question: q })
    } catch (err: any) {
      setResponse({ answer: `Error: ${err.message}`, question: q })
    } finally {
      setLoading(false)
    }
  }, [query, loading, onClose, getContext, contextType])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }, [handleSubmit, onClose])

  const handleCopy = useCallback(() => {
    if (!response) return
    navigator.clipboard.writeText(response.answer)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [response])

  const badgeClass = contextType === 'terminal' ? 'terminal' : contextType === 'code' ? 'code' : ''

  return (
    <>
      {/* Spotlight dialog */}
      {open && (
        <div className="quick-ai-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
          <div className="quick-ai-dialog">
            <div className="quick-ai-header">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <span className={`quick-ai-badge ${badgeClass}`}>{contextLabel}</span>
            </div>
            <div className="quick-ai-input-wrapper">
              <input
                ref={inputRef}
                className="quick-ai-input"
                type="text"
                placeholder="Ask AI anything..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
            <div className="quick-ai-hint">
              <kbd>Enter</kbd> to ask &middot; <kbd>Esc</kbd> to close
            </div>
          </div>
        </div>
      )}

      {/* Loading indicator (shows after dialog closes during request) */}
      {loading && !open && (
        <div className="quick-ai-response">
          <div className="quick-ai-response-header">
            <span className="quick-ai-response-title">
              <span className="quick-ai-spinner" />
              Thinking...
            </span>
          </div>
          <div className="quick-ai-response-body" style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
            {query}
          </div>
        </div>
      )}

      {/* Response tooltip */}
      {response && !loading && (
        <div className="quick-ai-response">
          <div className="quick-ai-response-header">
            <span className="quick-ai-response-title">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z" fill="currentColor" stroke="none" />
                <path d="M12 7v5l3 3" stroke="var(--bg-secondary)" strokeWidth="2" strokeLinecap="round" />
              </svg>
              AI Response
            </span>
            <div className="quick-ai-response-actions">
              <button className={`quick-ai-response-btn ${copied ? 'copied' : ''}`} onClick={handleCopy} title="Copy">
                {copied ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
              <button className="quick-ai-response-btn" onClick={() => setResponse(null)} title="Close (Esc)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div className="quick-ai-response-body">
            <ReactMarkdown>{response.answer}</ReactMarkdown>
          </div>
        </div>
      )}
    </>
  )
}
