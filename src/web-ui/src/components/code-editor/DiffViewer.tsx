import { DiffEditor } from '@monaco-editor/react'
import { X } from 'lucide-react'
import { useState, useEffect } from 'react'

interface DiffViewerProps {
  original: string
  modified: string
  filePath: string
  onClose: () => void
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
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'json': 'json',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'md': 'markdown',
    'py': 'python',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'java': 'java',
    'yaml': 'yaml',
    'yml': 'yaml',
    'xml': 'xml',
    'sql': 'sql',
    'sh': 'shell',
    'bash': 'shell',
  }

  return languageMap[ext] || 'plaintext'
}

export function DiffViewer({ original, modified, filePath, onClose }: DiffViewerProps) {
  const filename = filePath.split('/').pop() || filePath
  const language = getLanguageFromPath(filePath)
  const isMobile = useIsMobile()

  return (
    <div className="diff-viewer">
      <div className="diff-viewer-header">
        <span className="diff-filename">{filename}</span>
        <span className="diff-path">{filePath}</span>
        <button className="diff-close-btn" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="diff-viewer-content">
        <DiffEditor
          height="100%"
          language={language}
          original={original}
          modified={modified}
          theme="vs-dark"
          options={{
            readOnly: true,
            fontSize: isMobile ? 8 : 13,
            fontFamily: "'SF Mono', Monaco, 'Courier New', monospace",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderSideBySide: !isMobile,
            automaticLayout: true,
            originalEditable: false,
            renderOverviewRuler: false,
            padding: { top: 8, bottom: 8 },
            lineNumbers: isMobile ? 'off' : 'on',
            wordWrap: isMobile ? 'on' : 'off',
          }}
        />
      </div>
    </div>
  )
}
