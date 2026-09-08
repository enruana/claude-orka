import Editor from '@monaco-editor/react'
import { useRef, useCallback, useState, useEffect } from 'react'
import type { editor, IRange } from 'monaco-editor'
import type { ProjectComment } from '../../api/client'
import { api } from '../../api/client'
import { MessageSquarePlus, Sparkles, Loader2, Check, Undo2, X as XIcon } from 'lucide-react'

/** Lines of untouched code sent around the selection so the rewrite
 *  matches the file's names and style. Enough to be useful, small
 *  enough to keep the request quick. */
const AI_CONTEXT_LINES = 40

/** An applied-but-not-yet-accepted edit. Keeping the original text and
 *  the range it now occupies is what makes Revert exact, rather than
 *  hoping an undo stack unwinds to the right place. */
interface PendingEdit {
  range: IRange
  original: string
  applied: string
}

interface GoToLine {
  line: number
  column?: number
}

interface AddCommentData {
  startLine: number
  endLine: number
  selectedText: string
}

interface EditorPaneProps {
  content: string
  filePath: string
  onChange: (content: string) => void
  readOnly?: boolean
  goToLine?: GoToLine | null
  comments?: ProjectComment[]
  onAddComment?: (data: AddCommentData) => void
}

// Detect mobile device
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const checkMobile = () => {
      const mobileQuery = window.matchMedia('(max-width: 768px)')
      const touchQuery = window.matchMedia('(pointer: coarse)')
      setIsMobile(mobileQuery.matches || touchQuery.matches)
    }

    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  return isMobile
}

// Map file extensions to Monaco language IDs
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''

  const languageMap: Record<string, string> = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'mjs': 'javascript',
    'cjs': 'javascript',

    // Web
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'scss',
    'less': 'less',

    // Data formats
    'json': 'json',
    'jsonc': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'xml': 'xml',
    'toml': 'toml',

    // Scripting
    'py': 'python',
    'rb': 'ruby',
    'php': 'php',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'ps1': 'powershell',

    // Systems
    'go': 'go',
    'rs': 'rust',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'java': 'java',
    'kt': 'kotlin',
    'swift': 'swift',
    'cs': 'csharp',

    // Config
    'md': 'markdown',
    'mdx': 'markdown',
    'dockerfile': 'dockerfile',
    'makefile': 'makefile',
    'ini': 'ini',
    'env': 'ini',

    // SQL
    'sql': 'sql',

    // GraphQL
    'graphql': 'graphql',
    'gql': 'graphql',
  }

  // Handle special filenames
  const filename = filePath.split('/').pop()?.toLowerCase() || ''
  if (filename === 'dockerfile') return 'dockerfile'
  if (filename === 'makefile') return 'makefile'
  if (filename.startsWith('.env')) return 'ini'
  if (filename === '.gitignore') return 'ini'

  return languageMap[ext] || 'plaintext'
}

export function EditorPane({ content, filePath, onChange, readOnly = false, goToLine, comments, onAddComment }: EditorPaneProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<string[]>([])
  const commentDecorationsRef = useRef<string[]>([])
  const onAddCommentRef = useRef(onAddComment)
  const isMobile = useIsMobile()

  // Floating action bar (shows when text is selected)
  const [selectionBtnPos, setSelectionBtnPos] = useState<{ top: number; left: number } | null>(null)

  // Inline "edit with Claude" flow.
  const [aiPrompt, setAiPrompt] = useState<{ top: number; left: number } | null>(null)
  const [aiInstruction, setAiInstruction] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null)
  // The selection is captured when the prompt opens: focusing the input
  // takes focus out of Monaco, and by submit time getSelection() no
  // longer reflects what the user highlighted.
  const capturedSelRef = useRef<{ range: IRange; text: string } | null>(null)
  const aiDecorationsRef = useRef<string[]>([])
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)

  // Keep ref in sync to avoid stale closures in addAction
  useEffect(() => {
    onAddCommentRef.current = onAddComment
  }, [onAddComment])

  // Trigger add-comment from current selection (used by both context menu and floating button)
  const triggerAddComment = useCallback(() => {
    const ed = editorRef.current
    if (!ed) return
    const sel = ed.getSelection()
    if (!sel || sel.isEmpty()) return
    const text = ed.getModel()?.getValueInRange(sel) || ''
    onAddCommentRef.current?.({
      startLine: sel.startLineNumber,
      endLine: sel.endLineNumber,
      selectedText: text,
    })
    setSelectionBtnPos(null)
  }, [])

  // Show/hide floating button based on current editor selection
  const updateSelectionButton = useCallback(() => {
    const ed = editorRef.current
    if (!ed) return

    const sel = ed.getSelection()
    if (!sel || sel.isEmpty()) {
      setSelectionBtnPos(null)
      return
    }

    const endPos = { lineNumber: sel.endLineNumber, column: sel.endColumn }
    const coords = ed.getScrolledVisiblePosition(endPos)
    if (!coords) {
      setSelectionBtnPos(null)
      return
    }

    const editorDom = ed.getDomNode()
    if (!editorDom) return
    const editorRect = editorDom.getBoundingClientRect()

    setSelectionBtnPos({
      top: coords.top + coords.height + 4,
      left: Math.min(coords.left, editorRect.width - 44),
    })
  }, [])

  /** Anchor a floating widget just under the end of the selection. */
  const anchorBelowSelection = useCallback((): { top: number; left: number } | null => {
    const ed = editorRef.current
    if (!ed) return null
    const sel = ed.getSelection()
    if (!sel || sel.isEmpty()) return null
    const coords = ed.getScrolledVisiblePosition({ lineNumber: sel.endLineNumber, column: sel.endColumn })
    const dom = ed.getDomNode()
    if (!coords || !dom) return null
    const width = dom.getBoundingClientRect().width
    return {
      top: coords.top + coords.height + 6,
      // Keep the panel on screen when the selection ends near the right edge.
      left: Math.max(8, Math.min(coords.left, width - 380)),
    }
  }, [])

  /** Open the instruction box for the current selection. */
  const openAiPrompt = useCallback(() => {
    const ed = editorRef.current
    if (!ed) return
    const sel = ed.getSelection()
    const model = ed.getModel()
    if (!sel || sel.isEmpty() || !model) return

    capturedSelRef.current = {
      range: {
        startLineNumber: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber,
        endColumn: sel.endColumn,
      },
      text: model.getValueInRange(sel),
    }
    setAiError(null)
    setAiInstruction('')
    setAiPrompt(anchorBelowSelection())
    setSelectionBtnPos(null)
  }, [anchorBelowSelection])

  const dismissAi = useCallback(() => {
    setAiPrompt(null)
    setAiInstruction('')
    setAiError(null)
    capturedSelRef.current = null
  }, [])

  /** Highlight the range an edit landed in, so it's obvious what moved. */
  const markEditedRange = useCallback((range: IRange | null) => {
    const ed = editorRef.current
    if (!ed) return
    aiDecorationsRef.current = ed.deltaDecorations(
      aiDecorationsRef.current,
      range ? [{ range, options: { isWholeLine: true, className: 'ai-edit-line' } }] : []
    )
  }, [])

  /**
   * Send the selection to Claude and drop the result straight in.
   *
   * The edit is applied immediately rather than shown in a preview
   * pane: seeing it in place, in context, is the whole point — and it
   * stays reversible, because the original text and the range it now
   * occupies are kept until the user accepts.
   */
  const runAiEdit = useCallback(async () => {
    const ed = editorRef.current
    const model = ed?.getModel()
    const captured = capturedSelRef.current
    const instruction = aiInstruction.trim()
    if (!ed || !model || !captured || !instruction) return

    setAiBusy(true)
    setAiError(null)
    try {
      const startLine = captured.range.startLineNumber
      const endLine = captured.range.endLineNumber
      const lastLine = model.getLineCount()
      const beforeFrom = Math.max(1, startLine - AI_CONTEXT_LINES)
      const afterTo = Math.min(lastLine, endLine + AI_CONTEXT_LINES)

      const contextBefore = beforeFrom < startLine
        ? model.getValueInRange({
            startLineNumber: beforeFrom, startColumn: 1,
            endLineNumber: startLine, endColumn: captured.range.startColumn,
          })
        : ''
      const contextAfter = afterTo > endLine
        ? model.getValueInRange({
            startLineNumber: endLine, startColumn: captured.range.endColumn,
            endLineNumber: afterTo, endColumn: model.getLineMaxColumn(afterTo),
          })
        : ''

      const { edited, unchanged } = await api.editCode({
        selection: captured.text,
        instruction,
        filePath,
        contextBefore,
        contextAfter,
      })

      if (unchanged) {
        setAiError("Claude left the code as it was — try rephrasing.")
        return
      }

      ed.executeEdits('orka-ai-edit', [{ range: captured.range, text: edited, forceMoveMarkers: true }])

      // Where the new text ended up: same start, end derived from what
      // was actually inserted.
      const startOffset = model.getOffsetAt({
        lineNumber: captured.range.startLineNumber,
        column: captured.range.startColumn,
      })
      const endPos = model.getPositionAt(startOffset + edited.length)
      const newRange: IRange = {
        startLineNumber: captured.range.startLineNumber,
        startColumn: captured.range.startColumn,
        endLineNumber: endPos.lineNumber,
        endColumn: endPos.column,
      }

      setPendingEdit({ range: newRange, original: captured.text, applied: edited })
      markEditedRange(newRange)
      ed.revealRangeInCenterIfOutsideViewport(newRange)
      setAiPrompt(null)
      setAiInstruction('')
    } catch (err: any) {
      setAiError(err?.message || 'The edit failed')
    } finally {
      setAiBusy(false)
    }
  }, [aiInstruction, filePath, markEditedRange])

  const acceptEdit = useCallback(() => {
    setPendingEdit(null)
    markEditedRange(null)
    capturedSelRef.current = null
    editorRef.current?.focus()
  }, [markEditedRange])

  const revertEdit = useCallback(() => {
    const ed = editorRef.current
    if (ed && pendingEdit) {
      ed.executeEdits('orka-ai-revert', [
        { range: pendingEdit.range, text: pendingEdit.original, forceMoveMarkers: true },
      ])
    }
    setPendingEdit(null)
    markEditedRange(null)
    capturedSelRef.current = null
    ed?.focus()
  }, [pendingEdit, markEditedRange])

  const handleEditorMount = useCallback((ed: editor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) => {
    editorRef.current = ed
    monacoRef.current = monaco

    ed.addAction({
      id: 'orka-ai-edit',
      label: 'Edit with Claude',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      precondition: 'editorHasSelection',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
      run: () => openAiPromptRef.current(),
    })

    // Register "Add Comment" context menu action (desktop)
    ed.addAction({
      id: 'orka-add-comment',
      label: 'Add Review Comment',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 10,
      precondition: 'editorHasSelection',
      run: () => triggerAddComment(),
    })

    // Show floating button when selection changes (works on desktop)
    ed.onDidChangeCursorSelection(() => {
      updateSelectionButton()
    })

    // Hide the selection bar on scroll. The AI widgets stay put — they
    // hold state the user is in the middle of, and re-anchor below.
    ed.onDidScrollChange(() => {
      setSelectionBtnPos(null)
    })

    // Focus editor when mounted (only on desktop)
    if (!isMobile) {
      ed.focus()
    }
  }, [isMobile, triggerAddComment, updateSelectionButton])

  // addAction closes over its callback once, so route through a ref.
  const openAiPromptRef = useRef(openAiPrompt)
  useEffect(() => { openAiPromptRef.current = openAiPrompt }, [openAiPrompt])

  /**
   * Keep Cmd+K local to the editor when there's a selection.
   *
   * Monaco calls preventDefault but the event still bubbles, and the
   * app-wide Cmd+K opens the Quick AI dialog — so both would fire and
   * the inline box would appear behind a modal. Capture phase, and only
   * while the editor holds a non-empty selection, so the global
   * shortcut keeps working everywhere else.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) return
      const ed = editorRef.current
      if (!ed || !ed.hasTextFocus()) return
      const sel = ed.getSelection()
      if (!sel || sel.isEmpty()) return
      e.preventDefault()
      e.stopImmediatePropagation()
      openAiPromptRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // A new file means any in-flight edit no longer refers to anything.
  useEffect(() => {
    setPendingEdit(null)
    setAiPrompt(null)
    capturedSelRef.current = null
    aiDecorationsRef.current = []
  }, [filePath])

  // Fallback for mobile: listen for touchend/mouseup on the editor DOM
  // Monaco may not fire onDidChangeCursorSelection reliably on touch selection
  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return

    const editorDom = ed.getDomNode()
    if (!editorDom) return

    const handleSelectionEnd = () => {
      // Small delay to let Monaco finalize the selection
      setTimeout(() => updateSelectionButton(), 150)
    }

    editorDom.addEventListener('touchend', handleSelectionEnd)
    editorDom.addEventListener('mouseup', handleSelectionEnd)

    // Also catch selection changes via the browser's selectionchange event
    const handleSelectionChange = () => {
      setTimeout(() => updateSelectionButton(), 100)
    }
    document.addEventListener('selectionchange', handleSelectionChange)

    return () => {
      editorDom.removeEventListener('touchend', handleSelectionEnd)
      editorDom.removeEventListener('mouseup', handleSelectionEnd)
      document.removeEventListener('selectionchange', handleSelectionChange)
    }
  }, [updateSelectionButton, content]) // re-attach when content changes (editor might remount)

  // Apply comment decorations
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || !comments) return

    const decorations = comments
      .filter(c => !c.resolved)
      .map(c => ({
        range: {
          startLineNumber: c.startLine,
          startColumn: 1,
          endLineNumber: c.endLine,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: 'comment-highlight-line',
          glyphMarginClassName: 'comment-glyph',
          glyphMarginHoverMessage: { value: c.body },
        },
      }))

    commentDecorationsRef.current = ed.deltaDecorations(commentDecorationsRef.current, decorations)
  }, [comments])

  // Listen for Quick AI context requests (Cmd+K)
  useEffect(() => {
    const handleContextRequest = () => {
      const ed = editorRef.current
      if (!ed) return

      const model = ed.getModel()
      const selection = ed.getSelection()
      let selectedText = ''
      if (selection && !selection.isEmpty()) {
        selectedText = model?.getValueInRange(selection) || ''
      }

      window.dispatchEvent(new CustomEvent('orka-editor-context', {
        detail: {
          fileContent: model?.getValue() || '',
          filePath,
          selection: selectedText,
        },
      }))
    }

    window.addEventListener('orka-get-editor-context', handleContextRequest)
    return () => window.removeEventListener('orka-get-editor-context', handleContextRequest)
  }, [filePath])

  // Handle goToLine
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || !goToLine) return

    const line = goToLine.line
    const column = goToLine.column ?? 1

    ed.revealLineInCenter(line)
    ed.setPosition({ lineNumber: line, column })
    ed.focus()

    // Highlight line briefly
    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, [
      {
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: { isWholeLine: true, className: 'search-highlight-line' },
      },
    ])

    const timer = setTimeout(() => {
      if (editorRef.current) {
        decorationsRef.current = editorRef.current.deltaDecorations(decorationsRef.current, [])
      }
    }, 2000)

    return () => clearTimeout(timer)
  }, [goToLine])

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      onChange(value)
    }
  }, [onChange])

  const language = getLanguageFromPath(filePath)

  return (
    <div className="editor-pane">
      <Editor
        height="100%"
        language={language}
        value={content}
        onChange={handleEditorChange}
        onMount={handleEditorMount}
        theme="vs-dark"
        options={{
          readOnly,
          fontSize: isMobile ? 8 : 13,
          fontFamily: "'SF Mono', Monaco, 'Courier New', monospace",
          fontLigatures: true,
          minimap: {
            enabled: !isMobile,
            scale: 1,
            renderCharacters: false,
            maxColumn: 100,
            showSlider: 'mouseover',
          },
          scrollBeyondLastLine: false,
          wordWrap: isMobile ? 'on' : 'off',
          lineNumbers: isMobile ? 'off' : 'on',
          renderWhitespace: 'selection',
          renderLineHighlight: 'all',
          tabSize: 2,
          insertSpaces: true,
          automaticLayout: true,
          bracketPairColorization: { enabled: true },
          guides: {
            bracketPairs: 'active',
            indentation: true,
            highlightActiveIndentation: 'always',
          },
          stickyScroll: { enabled: !isMobile, maxLineCount: 5 },
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          padding: { top: 8, bottom: 8 },
          folding: !isMobile,
          foldingStrategy: 'indentation',
          showFoldingControls: 'mouseover',
          links: true,
          contextmenu: !isMobile,
          quickSuggestions: !isMobile,
          suggestOnTriggerCharacters: !isMobile,
          acceptSuggestionOnEnter: 'smart',
          formatOnPaste: true,
          formatOnType: false,
          glyphMargin: !isMobile,
          lineDecorationsWidth: isMobile ? 0 : 10,
          lineNumbersMinChars: isMobile ? 2 : 3,
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
            useShadows: false,
          },
        }}
      />

      {/* Selection toolbar — the primary action is asking Claude. */}
      {selectionBtnPos && !aiPrompt && !pendingEdit && (
        <div
          className="editor-selection-bar"
          style={{ top: selectionBtnPos.top, left: selectionBtnPos.left }}
          // pointerdown, not click: Monaco drops the selection the
          // moment focus leaves, and the handlers below need it intact.
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
        >
          <button
            className="editor-selection-action editor-selection-action-primary"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openAiPrompt() }}
            title="Edit with Claude (⌘K)"
          >
            <Sparkles size={13} />
            <span>Edit</span>
            <kbd>⌘K</kbd>
          </button>
          {onAddComment && (
            <button
              className="editor-selection-action"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); triggerAddComment() }}
              title="Add Review Comment"
            >
              <MessageSquarePlus size={13} />
            </button>
          )}
        </div>
      )}

      {/* Instruction box */}
      {aiPrompt && (
        <div className="editor-ai-prompt" style={{ top: aiPrompt.top, left: aiPrompt.left }}>
          <div className="editor-ai-prompt-row">
            <Sparkles size={14} className="editor-ai-prompt-icon" />
            <input
              className="editor-ai-prompt-input"
              placeholder="Convert to an arrow function, add types, extract a helper…"
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void runAiEdit() }
                if (e.key === 'Escape') { e.preventDefault(); dismissAi() }
              }}
              disabled={aiBusy}
              autoFocus
            />
            {aiBusy ? (
              <Loader2 size={15} className="editor-ai-spin" />
            ) : (
              <button className="editor-ai-prompt-close" onClick={dismissAi} title="Cancel (Esc)">
                <XIcon size={14} />
              </button>
            )}
          </div>
          {aiError && <div className="editor-ai-prompt-error">{aiError}</div>}
          {!aiError && (
            <div className="editor-ai-prompt-hint">
              {aiBusy ? 'Claude is rewriting the selection…' : 'Enter to run · Esc to cancel'}
            </div>
          )}
        </div>
      )}

      {/* Accept / revert bar for an applied edit */}
      {pendingEdit && (
        <div className="editor-ai-review">
          <Sparkles size={13} />
          <span className="editor-ai-review-label">Claude edited this selection</span>
          <button className="editor-ai-review-accept" onClick={acceptEdit}>
            <Check size={13} /> Keep
          </button>
          <button className="editor-ai-review-revert" onClick={revertEdit}>
            <Undo2 size={13} /> Revert
          </button>
        </div>
      )}
    </div>
  )
}
