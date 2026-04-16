import Editor from '@monaco-editor/react'
import { useRef, useCallback, useState, useEffect } from 'react'
import type { editor } from 'monaco-editor'
import type { ProjectComment } from '../../api/client'
import { MessageSquarePlus } from 'lucide-react'

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

  // Floating comment button state (shows when text is selected)
  const [selectionBtnPos, setSelectionBtnPos] = useState<{ top: number; left: number } | null>(null)

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

  const handleEditorMount = useCallback((ed: editor.IStandaloneCodeEditor) => {
    editorRef.current = ed

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

    // Hide floating button on scroll
    ed.onDidScrollChange(() => {
      setSelectionBtnPos(null)
    })

    // Focus editor when mounted (only on desktop)
    if (!isMobile) {
      ed.focus()
    }
  }, [isMobile, triggerAddComment, updateSelectionButton])

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
          minimap: { enabled: !isMobile, scale: 0.8 },
          scrollBeyondLastLine: false,
          wordWrap: isMobile ? 'on' : 'off',
          lineNumbers: isMobile ? 'off' : 'on',
          renderWhitespace: 'selection',
          tabSize: 2,
          insertSpaces: true,
          automaticLayout: true,
          bracketPairColorization: { enabled: true },
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
        }}
      />

      {/* Floating "Add Comment" button — appears on text selection */}
      {selectionBtnPos && onAddComment && (
        <button
          className="editor-selection-comment-btn"
          style={{ top: selectionBtnPos.top, left: selectionBtnPos.left }}
          onPointerDown={(e) => {
            // Prevent Monaco from losing the selection
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            triggerAddComment()
          }}
          title="Add Review Comment"
        >
          <MessageSquarePlus size={14} />
        </button>
      )}
    </div>
  )
}
