import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownViewerProps {
  content: string
  fileName: string
}

// Stable component map — defined outside to avoid recreating on every render
const markdownComponents = {
  a: ({ href, children, node: _node, ...props }: any) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
  code: ({ className, children, node: _node, inline: _inline, ...props }: any) => {
    const match = /language-(\w+)/.exec(className || '')
    const isInline = !match && !className
    if (isInline) {
      return (
        <code className="inline-code" {...props}>
          {children}
        </code>
      )
    }
    return (
      <code className={`code-block ${match ? `language-${match[1]}` : ''}`} {...props}>
        {children}
      </code>
    )
  },
  pre: ({ children, node: _node, ...props }: any) => (
    <pre className="code-block-wrapper" {...props}>
      {children}
    </pre>
  ),
}

function MarkdownViewerImpl({ content, fileName }: MarkdownViewerProps) {
  return (
    <div className="markdown-viewer">
      <div className="markdown-viewer-header">
        <span className="markdown-filename">{fileName}</span>
      </div>
      <div className="markdown-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}

// Memoize to prevent re-rendering when parent state (e.g., selectionBtn) changes.
// ReactMarkdown processing can create new DOM nodes which destroys any active
// text selection — critical when the floating comment button updates.
export const MarkdownViewer = memo(MarkdownViewerImpl, (prev, next) =>
  prev.content === next.content && prev.fileName === next.fileName
)
