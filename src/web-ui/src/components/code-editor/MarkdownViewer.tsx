import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownViewerProps {
  content: string
  fileName: string
}

export function MarkdownViewer({ content, fileName }: MarkdownViewerProps) {
  return (
    <div className="markdown-viewer">
      <div className="markdown-viewer-header">
        <span className="markdown-filename">{fileName}</span>
      </div>
      <div className="markdown-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // Open external links in new tab
            a: ({ href, children, ...props }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            ),
            // Style code blocks
            code: ({ className, children, ...props }) => {
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
            // Style pre blocks
            pre: ({ children, ...props }) => (
              <pre className="code-block-wrapper" {...props}>
                {children}
              </pre>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
