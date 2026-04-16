import { useState, useEffect, useCallback } from 'react'
import {
  MessageSquare,
  Trash2,
  Check,
  ChevronDown,
  ChevronRight,
  Send,
  Play,
} from 'lucide-react'
import { api, ProjectComment } from '../api/client'
import './comment-widget.css'

interface CommentWidgetProps {
  projectPath: string
  onClose: () => void
  popoverStyle?: React.CSSProperties
}

export function CommentWidget({ projectPath, onClose, popoverStyle }: CommentWidgetProps) {
  const [comments, setComments] = useState<ProjectComment[]>([])
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const fetchComments = useCallback(async () => {
    try {
      const data = await api.listComments(projectPath)
      setComments(data)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    fetchComments()
  }, [fetchComments])

  const handleResolve = async (commentId: string, resolved: boolean) => {
    try {
      await api.updateComment(projectPath, commentId, { resolved })
      await fetchComments()
    } catch (err) {
      console.error('Failed to update comment:', err)
    }
  }

  const handleDelete = async (commentId: string) => {
    try {
      await api.deleteComment(projectPath, commentId)
      await fetchComments()
    } catch (err) {
      console.error('Failed to delete comment:', err)
    }
  }

  const handleNavigate = (filePath: string, startLine: number) => {
    window.dispatchEvent(new CustomEvent('orka-navigate-to-comment', {
      detail: { filePath, startLine },
    }))
  }

  const toggleFile = (filePath: string) => {
    setCollapsedFiles(prev => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }

  const buildPrompt = (commentsToApply: ProjectComment[]) => {
    const byFile = new Map<string, ProjectComment[]>()
    for (const c of commentsToApply) {
      const list = byFile.get(c.filePath) || []
      list.push(c)
      byFile.set(c.filePath, list)
    }

    let prompt = 'Please review and apply the following document review comments to the codebase. For each comment, read the referenced section, understand the feedback, and make the appropriate changes:\n\n'

    for (const [file, fileComments] of byFile) {
      prompt += `## File: ${file}\n`
      for (const c of fileComments) {
        prompt += `### Lines ${c.startLine}-${c.endLine}\n`
        if (c.selectedText) {
          const snippet = c.selectedText.length > 200 ? c.selectedText.slice(0, 200) + '...' : c.selectedText
          prompt += `Selected text: "${snippet}"\n`
        }
        prompt += `Comment: ${c.body}\n\n`
      }
    }

    prompt += 'After applying each comment, briefly explain what you changed.'
    return prompt
  }

  const sendToTerminal = (text: string) => {
    const iframe = document.querySelector('iframe.terminal-iframe') as HTMLIFrameElement | null
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'terminal-input', text }, '*')
      setTimeout(() => iframe.focus(), 100)
    }
  }

  const handleApplyAll = () => {
    const unresolved = comments.filter(c => !c.resolved)
    if (unresolved.length === 0) return
    sendToTerminal(buildPrompt(unresolved))
  }

  const handleApplyOne = (comment: ProjectComment) => {
    sendToTerminal(buildPrompt([comment]))
  }

  const unresolvedCount = comments.filter(c => !c.resolved).length

  // Group comments by file
  const byFile = new Map<string, ProjectComment[]>()
  for (const c of comments) {
    const list = byFile.get(c.filePath) || []
    list.push(c)
    byFile.set(c.filePath, list)
  }

  return (
    <div className="comment-popover" style={popoverStyle} onClick={e => e.stopPropagation()}>
      <div className="comment-popover-header">
        <div className="comment-popover-title">
          <MessageSquare size={16} />
          <span>Comments</span>
          {unresolvedCount > 0 && (
            <span className="comment-count-badge">{unresolvedCount}</span>
          )}
        </div>
        <div className="comment-popover-actions">
          {unresolvedCount > 0 && (
            <button
              className="comment-apply-btn"
              onClick={handleApplyAll}
              title="Send all unresolved comments to terminal"
            >
              <Send size={13} />
              <span>Apply All</span>
            </button>
          )}
        </div>
      </div>

      <div className="comment-list">
        {loading ? (
          <div className="comment-empty">Loading...</div>
        ) : comments.length === 0 ? (
          <div className="comment-empty">
            <p>No comments yet</p>
            <p className="comment-empty-hint">Select text in the code editor, right-click, and choose "Add Review Comment"</p>
          </div>
        ) : (
          Array.from(byFile.entries()).map(([filePath, fileComments]) => {
            const fileName = filePath.split('/').pop() || filePath
            const isCollapsed = collapsedFiles.has(filePath)
            const fileUnresolved = fileComments.filter(c => !c.resolved).length

            return (
              <div key={filePath} className="comment-file-group">
                <div className="comment-file-header" onClick={() => toggleFile(filePath)}>
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span className="comment-file-name" title={filePath}>{fileName}</span>
                  <span className="comment-file-count">{fileUnresolved}/{fileComments.length}</span>
                </div>
                {!isCollapsed && fileComments.map(comment => (
                  <div
                    key={comment.id}
                    className={`comment-item ${comment.resolved ? 'resolved' : ''}`}
                  >
                    <button
                      className={`comment-checkbox ${comment.resolved ? 'checked' : ''}`}
                      onClick={() => handleResolve(comment.id, !comment.resolved)}
                      title={comment.resolved ? 'Unresolve' : 'Mark as resolved'}
                    >
                      {comment.resolved && <Check size={10} />}
                    </button>
                    <div className="comment-content" onClick={() => handleNavigate(comment.filePath, comment.startLine)}>
                      <div className="comment-meta">
                        <span className="comment-line-badge">
                          L{comment.startLine}{comment.endLine !== comment.startLine ? `-${comment.endLine}` : ''}
                        </span>
                      </div>
                      <div className="comment-body">{comment.body}</div>
                    </div>
                    <div className="comment-actions">
                      {!comment.resolved && (
                        <button
                          className="comment-apply-one-btn"
                          onClick={() => handleApplyOne(comment)}
                          title="Apply this comment"
                        >
                          <Play size={10} />
                        </button>
                      )}
                      <button
                        className="comment-delete-btn"
                        onClick={() => handleDelete(comment.id)}
                        title="Delete comment"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
