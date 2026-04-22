import { memo, useMemo, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownViewerProps {
  content: string
  fileName: string
  /** Current file's directory path (relative to project root) for resolving relative links */
  currentDir?: string
  /** Base64-encoded project path for building viewer URLs */
  encodedProjectPath?: string
}

/** Check if a link is external (http/https/mailto) */
function isExternalLink(href: string): boolean {
  return /^(https?:|mailto:|#)/.test(href)
}

/**
 * Normalize a path from markdown links.
 * All paths are treated as absolute from the project root.
 * Leading slashes and trailing slashes are stripped.
 */
function normalizePath(href: string): string {
  return href.replace(/^\/+/, '').replace(/\/+$/, '')
}

/** Check if a path looks like a file (has extension) vs directory */
function isFilePath(p: string): boolean {
  const last = p.split('/').pop() || ''
  return /\.\w+$/.test(last)
}

function MarkdownViewerImpl({ content, fileName, currentDir, encodedProjectPath }: MarkdownViewerProps) {
  const handleLinkClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    // External links: let browser handle normally
    if (isExternalLink(href)) return

    // No project context: open as-is
    if (!encodedProjectPath) return

    e.preventDefault()

    const resolved = normalizePath(href)

    if (isFilePath(resolved)) {
      window.open(
        `/projects/${encodedProjectPath}/files/view?path=${encodeURIComponent(resolved)}`,
        '_blank'
      )
    } else {
      window.open(
        `/projects/${encodedProjectPath}/files?path=${encodeURIComponent(resolved)}`,
        '_blank'
      )
    }
  }, [encodedProjectPath])

  // Build components with link handler baked in
  const components = useMemo(() => ({
    a: ({ href, children, node: _node, ...props }: any) => {
      const linkHref = href || ''
      const isExternal = isExternalLink(linkHref)

      return (
        <a
          href={linkHref}
          onClick={(e: React.MouseEvent<HTMLAnchorElement>) => handleLinkClick(e, linkHref)}
          target={isExternal ? '_blank' : undefined}
          rel={isExternal ? 'noopener noreferrer' : undefined}
          className={isExternal ? 'md-link-external' : 'md-link-internal'}
          {...props}
        >
          {children}
        </a>
      )
    },
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
  }), [handleLinkClick])

  return (
    <div className="markdown-viewer">
      <div className="markdown-viewer-header">
        <span className="markdown-filename">{fileName}</span>
      </div>
      <div className="markdown-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}

export const MarkdownViewer = memo(MarkdownViewerImpl, (prev, next) =>
  prev.content === next.content &&
  prev.fileName === next.fileName &&
  prev.currentDir === next.currentDir &&
  prev.encodedProjectPath === next.encodedProjectPath
)
