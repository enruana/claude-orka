import { useState, useEffect, useCallback } from 'react'
import {
  MessageSquare,
  Trash2,
  Check,
  ChevronDown,
  ChevronRight,
  Send,
  Play,
  Folder,
  FileText,
  Wand2,
} from 'lucide-react'
import { api, ProjectComment } from '../api/client'
import './comment-widget.css'

interface CommentWidgetProps {
  projectPath: string
  onClose: () => void
  popoverStyle?: React.CSSProperties
  /** Identifier of the terminal the comments should be sent to. When set,
   *  `sendToTerminal` targets the iframe with `data-orka-session-id`
   *  matching this value — necessary when multiple terminals coexist on
   *  the page (e.g. a Board task modal above a Board master drawer).
   *  Falls back to the legacy broad `iframe.terminal-iframe` selector
   *  when not provided or when no matching iframe exists. */
  sessionId?: string
}

/** Return the parent folder path of a file, or "(root)" for root files. */
function folderOf(filePath: string): string {
  const idx = filePath.lastIndexOf('/')
  if (idx <= 0) return '(root)'
  return filePath.slice(0, idx)
}

/** Just the filename for the file header row. */
function basenameOf(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

export function CommentWidget({ projectPath, onClose, popoverStyle, sessionId }: CommentWidgetProps) {
  const [comments, setComments] = useState<ProjectComment[]>([])
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
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

  const handleDeleteMany = async (ids: string[]) => {
    if (ids.length === 0) return
    try {
      await Promise.all(ids.map((id) => api.deleteComment(projectPath, id)))
      await fetchComments()
    } catch (err) {
      console.error('Failed to bulk delete:', err)
    }
  }

  const handleNavigate = (filePath: string, startLine: number) => {
    window.dispatchEvent(new CustomEvent('orka-navigate-to-comment', {
      detail: { filePath, startLine },
    }))
  }

  const toggleFolder = (folder: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }

  const toggleFile = (filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }

  /**
   * Build the "apply comments" prompt. The template treats each comment
   * as one of four intents (edit / recommendation / question / regen) and
   * tells Claude how to handle each, plus keeps a per-comment log entry
   * so a paper trail survives the terminal session.
   */
  const buildApplyPrompt = (commentsToApply: ProjectComment[]): string => {
    const byFile = new Map<string, ProjectComment[]>()
    for (const c of commentsToApply) {
      const list = byFile.get(c.filePath) || []
      list.push(c)
      byFile.set(c.filePath, list)
    }
    const fileCount = byFile.size
    const folderCount = new Set([...byFile.keys()].map(folderOf)).size

    const preamble = [
      `You've received ${commentsToApply.length} review comment${commentsToApply.length === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'} in ${folderCount} folder${folderCount === 1 ? '' : 's'}. Process them all in one pass following this protocol:`,
      '',
      '## 1. Classify each comment',
      '',
      '- **EDIT** — a specific change to make in place.',
      '- **RECOMMENDATION** — a suggestion to consider; act on it if you agree.',
      '- **QUESTION** — an open question that needs investigation before acting.',
      '- **REGENERATE** — a request to rewrite a section or the whole document.',
      '',
      '## 2. Handle each',
      '',
      '- **EDIT** → apply the change directly.',
      '- **RECOMMENDATION** → apply if the tradeoff makes sense. If not, briefly note why in the log.',
      '- **QUESTION** → investigate first (read the referenced code + related tickets + do a deep-research pass if the answer is external), then apply the resolution or record the finding if no action is needed.',
      '- **REGENERATE** → produce the rewrite. If the comment names specific sections or points, weave them in explicitly.',
      '',
      '## 3. Keep a paper trail',
      '',
      'Choose the log destination per file type — HTML docs get an embedded',
      'changelog (subtle, at the bottom of the file); other files use the',
      'project-level markdown log.',
      '',
      '### If the target file is `.html`',
      '',
      'The document has a `<section class="changelog">` at the bottom with',
      'a `<ul>` of entries. **Prepend** a new `<li>` (most recent first)',
      'with a bumped version — small fix `v1.0 → v1.1`, larger revision or',
      'regen `v1.x → v2.0`. Also update the `.meta` line at the end that',
      'shows "Versión actual: vX.Y".',
      '',
      'Entry shape:',
      '',
      '```html',
      '<li data-version="v1.1">',
      '  <span class="ver">v1.1</span>',
      '  <span class="when">2026-07-24</span>',
      '  <strong>EDIT · <file>:<lines></strong> — one-line description of what',
      '  changed and why, plus any research links inline.',
      '</li>',
      '```',
      '',
      'Group multiple comments applied in one pass into a single `<li>` with',
      'a nested `<ul>` if that keeps the log readable.',
      '',
      '### For any other file type',
      '',
      'Append a Markdown entry to `.claude-orka/comments/log.md` at the',
      'project root (create the folder if needed) so we still have a paper',
      'trail without polluting the source with comments:',
      '',
      '```',
      '### <ISO timestamp> · <file>:<lines>',
      '',
      '**Classification:** EDIT | RECOMMENDATION | QUESTION | REGENERATE',
      '',
      '**Original comment:**',
      '> <the comment body>',
      '',
      '**Action taken:** <what you did, links to files/PRs, or "deferred: <reason>">',
      '',
      '**Notes/research:** <optional — findings, links, next steps>',
      '```',
      '',
      '## 4. Summary at the end',
      '',
      'Print a compact summary in the terminal: N applied, N researched, N regenerated, N deferred. Include a one-line reason for each deferred item.',
      '',
      '---',
      '',
      '## Comments',
      '',
    ]

    let prompt = preamble.join('\n')

    for (const [file, fileComments] of byFile) {
      prompt += `\n### File: \`${file}\`\n\n`
      for (const c of fileComments) {
        const lineRange = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-${c.endLine}`
        prompt += `**${lineRange}**`
        if (c.selectedText) {
          const snippet = c.selectedText.length > 240 ? c.selectedText.slice(0, 240) + '…' : c.selectedText
          prompt += ` — selected:\n\n\`\`\`\n${snippet}\n\`\`\`\n\n`
        } else {
          prompt += '\n\n'
        }
        prompt += `> ${c.body.replace(/\n/g, '\n> ')}\n\n`
      }
    }

    return prompt
  }

  /**
   * Dedicated regenerate prompt for a single file. Tells Claude to rewrite
   * the file from scratch, weaving in ALL unresolved comments, and reading
   * the comments log for prior context so decisions stay consistent
   * across sessions.
   */
  const buildRegeneratePrompt = (filePath: string, fileComments: ProjectComment[]): string => {
    const isHtml = /\.html?$/i.test(filePath)
    const parts = [
      `Regenerate the document \`${filePath}\` from scratch, incorporating the review comments below and any prior resolutions.`,
      '',
      '## Steps',
      '',
      '1. Read the current file to understand its structure and intent.',
      isHtml
        ? '2. Read the `<section class="changelog">` at the bottom to see prior versions and what each addressed — keep decisions consistent across regens.'
        : '2. Read the comments log at `.claude-orka/comments/log.md` and grep it for prior entries referencing this file.',
      `3. For each comment below, treat it as scoped feedback. **QUESTION**-type comments must be investigated (read code, related tickets, or do a deep-research pass) before being reflected in the rewrite.`,
      '4. Rewrite the document from scratch, preserving its intent and structure but resolving every comment.',
      `5. Save the new content with the \`Write\` tool (full-file replacement, not patch). Path: \`${filePath}\`.`,
      isHtml
        ? '6. Bump the version (major bump for a regen: `v1.x → v2.0`, chain further regens as `v3.0`, `v4.0`, etc.). Prepend a new `<li>` to the changelog with the version, ISO date, and a one-paragraph summary of what changed AND which comments it resolved (reference them inline). Update the `.meta` line to show the new "Versión actual".'
        : '6. Append a **REGENERATE** entry to `.claude-orka/comments/log.md` with the version, timestamp, and what changed.',
      '',
      '## Comments to incorporate',
      '',
    ]
    let prompt = parts.join('\n')
    for (const c of fileComments) {
      const lineRange = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-${c.endLine}`
      prompt += `\n**${lineRange}**`
      if (c.selectedText) {
        const snippet = c.selectedText.length > 240 ? c.selectedText.slice(0, 240) + '…' : c.selectedText
        prompt += ` — selected:\n\n\`\`\`\n${snippet}\n\`\`\`\n\n`
      } else {
        prompt += '\n\n'
      }
      prompt += `> ${c.body.replace(/\n/g, '\n> ')}\n\n`
    }
    prompt += '\nAfter saving, print a compact summary: what sections you changed, which comments you weaved in, and any research/deep-dive links.'
    return prompt
  }

  const sendToTerminal = (text: string) => {
    // Resolution order:
    //  1. Iframe whose data-orka-session-id matches ours — precise match
    //     when a Board task modal is open (the modal's iframe carries
    //     the task key; the drawer's master iframe carries the boardId).
    //  2. A `terminal-iframe` inside a `role="dialog"` — the topmost
    //     modal-hosted terminal, useful when sessionId isn't propagated
    //     but the modal is clearly the interactive surface.
    //  3. The plain legacy `iframe.terminal-iframe` — same behavior the
    //     Classic-session flow has always used.
    let iframe: HTMLIFrameElement | null = null
    if (sessionId) {
      iframe = document.querySelector(
        `iframe[data-orka-session-id="${sessionId}"]`
      ) as HTMLIFrameElement | null
    }
    if (!iframe) {
      const modalIframes = document.querySelectorAll('[role="dialog"] iframe.terminal-iframe')
      if (modalIframes.length > 0) {
        iframe = modalIframes[modalIframes.length - 1] as HTMLIFrameElement
      }
    }
    if (!iframe) {
      iframe = document.querySelector('iframe.terminal-iframe') as HTMLIFrameElement | null
    }
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'terminal-input', text }, '*')
      setTimeout(() => iframe!.focus(), 100)
    }
  }

  const handleApplyAll = () => {
    const unresolved = comments.filter((c) => !c.resolved)
    if (unresolved.length === 0) return
    sendToTerminal(buildApplyPrompt(unresolved))
  }

  const handleApplyFolder = (folder: string) => {
    const unresolved = comments.filter((c) => !c.resolved && folderOf(c.filePath) === folder)
    if (unresolved.length === 0) return
    sendToTerminal(buildApplyPrompt(unresolved))
  }

  const handleApplyFile = (filePath: string) => {
    const unresolved = comments.filter((c) => !c.resolved && c.filePath === filePath)
    if (unresolved.length === 0) return
    sendToTerminal(buildApplyPrompt(unresolved))
  }

  const handleApplyOne = (comment: ProjectComment) => {
    sendToTerminal(buildApplyPrompt([comment]))
  }

  const handleRegenerateFile = (filePath: string) => {
    const fileComments = comments.filter((c) => c.filePath === filePath && !c.resolved)
    if (fileComments.length === 0) return
    sendToTerminal(buildRegeneratePrompt(filePath, fileComments))
  }

  const handleDeleteFolder = async (folder: string, count: number) => {
    if (!window.confirm(`Delete ${count} comment(s) in ${folder}? This cannot be undone.`)) return
    const ids = comments.filter((c) => folderOf(c.filePath) === folder).map((c) => c.id)
    await handleDeleteMany(ids)
  }

  const handleDeleteFile = async (filePath: string, count: number) => {
    if (!window.confirm(`Delete ${count} comment(s) in ${basenameOf(filePath)}? This cannot be undone.`)) return
    const ids = comments.filter((c) => c.filePath === filePath).map((c) => c.id)
    await handleDeleteMany(ids)
  }

  const unresolvedCount = comments.filter((c) => !c.resolved).length

  // Group: folder → file → comments. Preserves insertion order per group
  // so the UI stays stable across polls.
  const tree = new Map<string, Map<string, ProjectComment[]>>()
  for (const c of comments) {
    const folder = folderOf(c.filePath)
    const files = tree.get(folder) || new Map<string, ProjectComment[]>()
    const list = files.get(c.filePath) || []
    list.push(c)
    files.set(c.filePath, list)
    tree.set(folder, files)
  }

  return (
    <div className="comment-popover" style={popoverStyle} onClick={(e) => e.stopPropagation()}>
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
              title="Send all unresolved comments to the terminal"
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
          Array.from(tree.entries()).map(([folder, files]) => {
            const folderCollapsed = collapsedFolders.has(folder)
            const folderCommentCount = Array.from(files.values()).reduce((n, list) => n + list.length, 0)
            const folderUnresolved = Array.from(files.values()).reduce(
              (n, list) => n + list.filter((c) => !c.resolved).length,
              0
            )

            return (
              <div key={folder} className="comment-folder-group">
                <div className="comment-folder-header">
                  <button
                    className="comment-folder-toggle"
                    onClick={() => toggleFolder(folder)}
                    title={folderCollapsed ? 'Expand' : 'Collapse'}
                  >
                    {folderCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <Folder size={13} />
                    <span className="comment-folder-name" title={folder}>{folder}</span>
                    <span className="comment-folder-count">{folderUnresolved}/{folderCommentCount}</span>
                  </button>
                  <div className="comment-folder-actions">
                    {folderUnresolved > 0 && (
                      <button
                        className="comment-bulk-btn"
                        onClick={() => handleApplyFolder(folder)}
                        title={`Apply all ${folderUnresolved} unresolved in this folder`}
                      >
                        <Send size={11} />
                      </button>
                    )}
                    <button
                      className="comment-bulk-btn destructive"
                      onClick={() => handleDeleteFolder(folder, folderCommentCount)}
                      title="Delete all comments in this folder"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>

                {!folderCollapsed && Array.from(files.entries()).map(([filePath, fileComments]) => {
                  const fileName = basenameOf(filePath)
                  const isCollapsed = collapsedFiles.has(filePath)
                  const fileUnresolved = fileComments.filter((c) => !c.resolved).length

                  return (
                    <div key={filePath} className="comment-file-group">
                      <div className="comment-file-header">
                        <button
                          className="comment-file-toggle"
                          onClick={() => toggleFile(filePath)}
                          title={isCollapsed ? 'Expand' : 'Collapse'}
                        >
                          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                          <FileText size={12} />
                          <span className="comment-file-name" title={filePath}>{fileName}</span>
                          <span className="comment-file-count">{fileUnresolved}/{fileComments.length}</span>
                        </button>
                        <div className="comment-file-actions">
                          {fileUnresolved > 0 && (
                            <>
                              <button
                                className="comment-bulk-btn"
                                onClick={() => handleApplyFile(filePath)}
                                title={`Apply all ${fileUnresolved} unresolved in this file`}
                              >
                                <Send size={11} />
                              </button>
                              <button
                                className="comment-bulk-btn regen"
                                onClick={() => handleRegenerateFile(filePath)}
                                title="Regenerate this file incorporating all comments (Claude rewrites from scratch)"
                              >
                                <Wand2 size={11} />
                              </button>
                            </>
                          )}
                          <button
                            className="comment-bulk-btn destructive"
                            onClick={() => handleDeleteFile(filePath, fileComments.length)}
                            title="Delete all comments on this file"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>

                      {!isCollapsed && fileComments.map((comment) => (
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
                          <div
                            className="comment-content"
                            onClick={() => handleNavigate(comment.filePath, comment.startLine)}
                          >
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
                })}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
