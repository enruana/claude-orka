import { useEffect, useRef, useState, memo } from 'react'
import { createPortal } from 'react-dom'
import { AnsiUp } from 'ansi_up'
import { Terminal, X, Check, Copy as CopyIcon } from 'lucide-react'
// Modal styles (.copy-terminal-*) live in task-widget.css alongside the
// widget's speed-dial rules. Import them here so the modal renders correctly
// even when TaskWidget is not on the page (e.g. the /dashboard system terminal).
import './task-widget.css'

export interface TerminalCaptureResult {
  plain: string
  ansi: string
}

interface CopyFromTerminalModalProps {
  open: boolean
  onClose: () => void
  /** Fetches the terminal capture. Called each time the modal opens. */
  captureFn: () => Promise<TerminalCaptureResult>
}

/**
 * Memoized <pre> so the terminal content doesn't re-render on unrelated
 * parent updates (which would collapse an active text selection and wipe
 * the syntax-like highlighting we mutate in after the initial render).
 */
const TerminalPre = memo(function TerminalPre({
  html, plain,
}: { html: string; plain: string }) {
  if (html) {
    return <pre className="copy-terminal-pre" dangerouslySetInnerHTML={{ __html: html }} />
  }
  return <pre className="copy-terminal-pre">{plain}</pre>
})

/**
 * Walk a DOM tree and apply regex-based highlighting to text nodes only.
 * Skips element children so we don't double-wrap text already inside an
 * inline-colored span produced by ansi_up.
 */
function highlightTerminalDom(root: HTMLElement): void {
  const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g
  const PATH_RE = /(?<![\w./])(\/[\w.\-/]+(?:\.[a-z0-9]+)?)(?=[\s:,;)\]"'`]|$)/gi
  const NUM_RE = /\b\d+(?:\.\d+)*\b/g
  const KEYWORD_ERR_RE = /\b(ERROR|ERR|FAIL|FAILED|WARN|WARNING|DENIED|REJECTED)\b/g
  const KEYWORD_OK_RE = /\b(SUCCESS|OK|PASS|PASSED|INFO|DEBUG|DONE|READY)\b/g
  const QUOTED_RE = /(["'`])(?:(?=(\\?))\2.)*?\1/g

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) textNodes.push(node as Text)

  for (const textNode of textNodes) {
    const text = textNode.nodeValue || ''
    if (!text.trim()) continue

    type Hit = { start: number; end: number; className: string; href?: string }
    const hits: Hit[] = []
    const addHits = (re: RegExp, className: string, hrefFn?: (m: string) => string) => {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        hits.push({ start: m.index, end: m.index + m[0].length, className, href: hrefFn?.(m[0]) })
      }
    }
    addHits(URL_RE, 'hl-url', (u) => u)
    addHits(PATH_RE, 'hl-path')
    addHits(QUOTED_RE, 'hl-string')
    addHits(KEYWORD_ERR_RE, 'hl-keyword-error')
    addHits(KEYWORD_OK_RE, 'hl-keyword-ok')
    addHits(NUM_RE, 'hl-number')

    if (hits.length === 0) continue

    hits.sort((a, b) => a.start - b.start || b.end - a.end)
    const merged: Hit[] = []
    for (const h of hits) {
      const last = merged[merged.length - 1]
      if (!last || h.start >= last.end) merged.push(h)
    }

    const frag = document.createDocumentFragment()
    let cursor = 0
    for (const h of merged) {
      if (h.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, h.start)))
      let el: HTMLElement
      if (h.href) {
        const a = document.createElement('a')
        a.href = h.href
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        a.className = h.className
        el = a
      } else {
        el = document.createElement('span')
        el.className = h.className
      }
      el.textContent = text.slice(h.start, h.end)
      frag.appendChild(el)
      cursor = h.end
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)))
    textNode.parentNode?.replaceChild(frag, textNode)
  }
}

export function CopyFromTerminalModal({ open, onClose, captureFn }: CopyFromTerminalModalProps) {
  const [plain, setPlain] = useState('')
  const [html, setHtml] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setCapturing(true)
    setPlain('')
    setHtml('')
    setCopyFeedback(false)

    captureFn()
      .then(({ plain: p, ansi }) => {
        if (cancelled) return
        let clipped = (p || '').replace(/\n+$/, '')
        if (clipped.length > 5000) clipped = '…' + clipped.slice(-5000)
        setPlain(clipped)
        try {
          const converter = new AnsiUp()
          ;(converter as any).use_classes = false
          setHtml(converter.ansi_to_html(ansi || ''))
        } catch {
          setHtml('')
        }
      })
      .catch((err: any) => {
        if (cancelled) return
        setPlain(`(Failed to capture terminal: ${err?.message || err})`)
        setHtml('')
      })
      .finally(() => { if (!cancelled) setCapturing(false) })

    return () => { cancelled = true }
  }, [open, captureFn])

  useEffect(() => {
    if (!open || capturing) return
    const body = bodyRef.current
    if (!body) return
    requestAnimationFrame(() => {
      const pre = body.querySelector('pre.copy-terminal-pre') as HTMLElement | null
      if (pre) {
        try { highlightTerminalDom(pre) } catch {}
      }
      body.scrollTop = body.scrollHeight
    })
  }, [open, capturing, plain, html])

  if (!open) return null

  const handleCopy = async () => {
    if (!plain) return
    try {
      await navigator.clipboard.writeText(plain)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = plain
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopyFeedback(true)
    setTimeout(() => setCopyFeedback(false), 1500)
  }

  return createPortal(
    <div
      className="copy-terminal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="copy-terminal-modal" onClick={e => e.stopPropagation()}>
        <div className="copy-terminal-modal-header">
          <span className="copy-terminal-modal-title">
            <Terminal size={18} />
            Terminal capture
            {plain && <span className="copy-terminal-chars">{plain.length} chars</span>}
          </span>
          <div className="copy-terminal-modal-actions">
            <button
              className={`copy-terminal-btn-primary ${copyFeedback ? 'success' : ''}`}
              disabled={!plain || capturing}
              onClick={handleCopy}
            >
              {copyFeedback ? (<><Check size={14} /> Copied</>) : (<><CopyIcon size={14} /> Copy all</>)}
            </button>
            <button className="copy-terminal-btn-close" onClick={onClose} title="Close">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="copy-terminal-modal-body" ref={bodyRef}>
          {capturing ? (
            <div className="copy-terminal-loading-fs">
              <div className="spinner" />
              <span>Capturing terminal…</span>
            </div>
          ) : (
            <TerminalPre html={html} plain={plain} />
          )}
        </div>
        <div className="copy-terminal-modal-footer">
          <span className="copy-terminal-hint-fs">
            Select any text and Cmd+C to copy, or use "Copy all" to grab everything
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * Binds Cmd/Ctrl+L and postMessage('orka-copy-from-terminal') to toggle the
 * modal. Skips activation when a text input is focused, and gates on
 * `enabled` (typically: is a terminal iframe currently visible?).
 */
export function useCopyFromTerminalShortcut(
  enabled: boolean,
  toggle: () => void,
) {
  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (e: KeyboardEvent) => {
      const isShortcut = (e.metaKey || e.ctrlKey) && (e.key === 'l' || e.key === 'L')
      if (!isShortcut) return
      const ae = document.activeElement as HTMLElement | null
      if (ae) {
        const tag = ae.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) return
      }
      e.preventDefault()
      toggle()
    }

    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'orka-copy-from-terminal') toggle()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('message', onMessage)
    }
  }, [enabled, toggle])
}
