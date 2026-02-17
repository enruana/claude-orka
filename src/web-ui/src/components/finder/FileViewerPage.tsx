import { useState, useEffect } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, ExternalLink, AlertCircle } from 'lucide-react'
import Editor from '@monaco-editor/react'
import { api } from '../../api/client'
import { MarkdownViewer } from '../code-editor/MarkdownViewer'
import { getFileType, getMonacoLanguage, getFileIcon, getFileKind } from '../../utils/fileTypes'
import './finder.css'

export function FileViewerPage() {
  const { encodedPath } = useParams<{ encodedPath: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const filePath = searchParams.get('path') || ''

  const [content, setContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  const handleBack = () => {
    navigate(-1)
  }

  const handleOpenInCodeEditor = () => {
    navigate(`/projects/${encodedPath}/code`)
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
          <div style={{ padding: 'var(--space-md)' }}>
            <MarkdownViewer content={content || ''} fileName={fileName} />
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
        <button className="icon-button" onClick={handleOpenInCodeEditor} title="Open in Code Editor">
          <ExternalLink size={16} />
        </button>
      </div>
      <div className="file-viewer-body">
        {renderContent()}
      </div>
    </div>
  )
}
