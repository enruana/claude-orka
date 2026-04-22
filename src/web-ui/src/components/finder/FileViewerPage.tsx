import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, ExternalLink, AlertCircle, Printer, MessageSquarePlus } from 'lucide-react'
import Editor, { useMonaco } from '@monaco-editor/react'
import { api, ProjectComment } from '../../api/client'
import { MarkdownViewer } from '../code-editor/MarkdownViewer'
import { AddCommentDialog } from '../AddCommentDialog'
import { getFileType, getMonacoLanguage, getFileIcon, getFileKind } from '../../utils/fileTypes'
import { usePageTitle } from '../../hooks/usePageTitle'
import { printFile } from '../../utils/printFile'
import './finder.css'

export function FileViewerPage() {
  const { encodedPath } = useParams<{ encodedPath: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const filePath = searchParams.get('path') || ''

  const [content, setContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const monaco = useMonaco()
  const markdownRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Comment support
  const [commentDialog, setCommentDialog] = useState<{
    startLine: number
    endLine: number
    selectedText: string
  } | null>(null)
  const [selectionBtn, setSelectionBtn] = useState<{ top: number; left: number } | null>(null)

  if (!encodedPath || !filePath) {
    return (
      <div className="file-viewer-page">
        <div className="finder-error" style={{ height: '100vh' }}>
          <AlertCircle size={24} />
          <p>Missing project or file path</p>
        </div>
      </div>
    )
  }

  const projectPath = atob(encodedPath)
  const fileName = filePath.split('/').pop() || filePath
  const fileType = getFileType(filePath)
  const dirPath = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : ''
  const projectName = projectPath.split('/').pop() || projectPath

  usePageTitle(projectName, fileName)

  useEffect(() => {
    const load = async () => {
      if (fileType === 'image') {
        setIsLoading(false)
        return
      }
      try {
        setIsLoading(true)
        setError(null)
        const data = await api.getFileContent(encodedPath!, filePath)
        setContent(data.content)
      } catch (err: any) {
        setError(err.message || 'Failed to load file')
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [encodedPath, filePath, fileType])

  // Detect text selection and show floating comment button.
  // IMPORTANT: we only check AFTER selection completes (mouseup/touchend), NOT on
  // every selectionchange — re-rendering the floating button during an active drag
  // can interfere with the browser's selection behavior, especially when the drag
  // crosses inline elements with distinct padding like <code>.
  useEffect(() => {
    const checkSelection = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setSelectionBtn(null)
        return
      }

      const bodyEl = bodyRef.current
      if (!bodyEl) return
      const anchorNode = sel.anchorNode
      if (!anchorNode || !bodyEl.contains(anchorNode)) {
        setSelectionBtn(null)
        return
      }

      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      const bodyRect = bodyEl.getBoundingClientRect()

      setSelectionBtn({
        top: rect.bottom - bodyRect.top + bodyEl.scrollTop + 4,
        left: Math.min(rect.right - bodyRect.left, bodyRect.width - 44),
      })
    }

    // Only hide button when selection collapses (so user sees an immediate response
    // when they click elsewhere), but don't reposition during drag.
    const onSelectionChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setSelectionBtn(null)
      }
    }

    const onMouseUp = () => setTimeout(checkSelection, 10)
    const onTouchEnd = () => setTimeout(checkSelection, 150)

    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('touchend', onTouchEnd)

    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('touchend', onTouchEnd)
    }
  }, [])

  const handleAddCommentFromSelection = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return

    const selectedText = sel.toString().trim()
    if (!selectedText) return

    // Estimate line numbers from the content
    const fullText = content || ''
    const lines = fullText.split('\n')

    // Find which line the selected text starts on
    let startLine = 1
    let endLine = 1
    const selStart = fullText.indexOf(selectedText)
    if (selStart >= 0) {
      const beforeSel = fullText.substring(0, selStart)
      startLine = (beforeSel.match(/\n/g) || []).length + 1
      const selLines = (selectedText.match(/\n/g) || []).length
      endLine = startLine + selLines
    }

    setCommentDialog({ startLine, endLine, selectedText })
    setSelectionBtn(null)
    sel.removeAllRanges()
  }, [content])

  const handleBack = () => {
    navigate(-1)
  }

  const handleOpenInCodeEditor = () => {
    navigate(`/projects/${encodedPath}/code`)
  }

  const handlePrint = () => {
    printFile({
      content: content || '',
      fileName,
      filePath,
      fileType,
      language: getMonacoLanguage(filePath),
      monaco: monaco || undefined,
      renderedHtml: markdownRef.current?.innerHTML,
      imageUrl: fileType === 'image'
        ? `/api/files/image?project=${encodedPath}&path=${encodeURIComponent(filePath)}`
        : undefined,
    })
  }

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="finder-loading" style={{ height: '100%' }}>
          <div className="spinner" />
          <span>Loading file...</span>
        </div>
      )
    }

    if (error) {
      return (
        <div className="finder-error" style={{ height: '100%' }}>
          <AlertCircle size={24} />
          <p>{error}</p>
        </div>
      )
    }

    switch (fileType) {
      case 'markdown':
        return (
          <div ref={markdownRef} style={{ padding: 'var(--space-md)' }}>
            <MarkdownViewer content={content || ''} fileName={fileName} currentDir={dirPath} encodedProjectPath={encodedPath} />
          </div>
        )

      case 'image':
        return (
          <div className="image-viewer-content">
            <img
              src={`/api/files/image?project=${encodedPath}&path=${encodeURIComponent(filePath)}`}
              alt={fileName}
              onError={() => setError('Failed to load image')}
            />
          </div>
        )

      case 'code':
        return (
          <div className="code-viewer-content">
            <Editor
              width="100%"
              height="100%"
              language={getMonacoLanguage(filePath)}
              value={content || ''}
              theme="vs-dark"
              options={{
                readOnly: true,
                minimap: { enabled: true },
                fontSize: 13,
                lineNumbers: 'on',
                wordWrap: 'on',
                scrollBeyondLastLine: false,
                folding: true,
                renderLineHighlight: 'line',
                scrollbar: {
                  vertical: 'auto',
                  horizontal: 'auto',
                  verticalScrollbarSize: 10,
                  horizontalScrollbarSize: 10,
                },
                automaticLayout: true,
              }}
            />
          </div>
        )

      default:
        return (
          <div className="file-viewer-unknown">
            {getFileIcon(fileName, 48)}
            <div className="file-info-details">
              <strong>{fileName}</strong>
              <span>{getFileKind(fileName.split('.').pop() || '')}</span>
              <span>{dirPath || '/'}</span>
            </div>
          </div>
        )
    }
  }

  return (
    <div className="file-viewer-page">
      <div className="file-viewer-header">
        <button className="icon-button" onClick={handleBack} title="Go back">
          <ArrowLeft size={18} />
        </button>
        <div className="file-viewer-title">
          <span className="file-icon">{getFileIcon(fileName, 16)}</span>
          <span className="file-name">{fileName}</span>
        </div>
        <span className="file-viewer-path">{dirPath || '/'}</span>
        <button className="icon-button" onClick={handlePrint} title="Print / Save as PDF">
          <Printer size={16} />
        </button>
        <button className="icon-button" onClick={handleOpenInCodeEditor} title="Open in Code Editor">
          <ExternalLink size={16} />
        </button>
      </div>
      <div className="file-viewer-body" ref={bodyRef} style={{ position: 'relative' }}>
        {renderContent()}

        {/* Floating "Add Comment" button on text selection */}
        {selectionBtn && (
          <button
            className="editor-selection-comment-btn"
            style={{ top: selectionBtn.top, left: selectionBtn.left }}
            // preventDefault on mousedown/pointerdown keeps the text selection
            // alive when the user clicks the button
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onPointerDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              handleAddCommentFromSelection()
            }}
            title="Add Review Comment"
          >
            <MessageSquarePlus size={14} />
          </button>
        )}
      </div>

      {/* Add Comment Dialog */}
      {commentDialog && (
        <AddCommentDialog
          filePath={filePath}
          startLine={commentDialog.startLine}
          endLine={commentDialog.endLine}
          selectedText={commentDialog.selectedText}
          onSave={async (body) => {
            try {
              await api.createComment(projectPath, {
                filePath,
                startLine: commentDialog.startLine,
                endLine: commentDialog.endLine,
                selectedText: commentDialog.selectedText,
                body,
              })
              setCommentDialog(null)
            } catch (err: any) {
              console.error('Failed to create comment:', err)
            }
          }}
          onCancel={() => setCommentDialog(null)}
        />
      )}
    </div>
  )
}
