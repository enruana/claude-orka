import { useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { FinderExplorer } from '../finder/FinderExplorer'
import { ArrowLeft } from 'lucide-react'
import { usePageTitle } from '../../hooks/usePageTitle'
import './code-editor.css'

export function FilesPage() {
  const { encodedPath } = useParams<{ encodedPath: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const initialPath = searchParams.get('path') || undefined

  // Keep the current directory in the URL (?path=) so it survives a reload
  // and a back/forward navigation. `replace` avoids polluting history with one
  // entry per folder step.
  const handlePathChange = useCallback((path: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (path) next.set('path', path)
      else next.delete('path')
      return next
    }, { replace: true })
  }, [setSearchParams])

  if (!encodedPath) {
    return (
      <div className="error-container">
        <div className="error-message">
          <h2>Project not found</h2>
          <p>No project path provided</p>
        </div>
      </div>
    )
  }

  const projectPath = atob(encodedPath)
  const projectName = projectPath.split('/').pop() || projectPath

  usePageTitle(projectName, 'Files')

  return (
    <div className="files-page-container">
      <div className="files-page-header">
        <button className="icon-button" onClick={() => navigate(-1)} title="Go back">
          <ArrowLeft size={18} />
        </button>
        <div className="project-info">
          <span className="project-name">{projectName}</span>
          <span className="separator">/</span>
          <span className="page-title">Files</span>
        </div>
      </div>
      <div className="files-page-content">
        <FinderExplorer
          projectPath={projectPath}
          encodedPath={encodedPath}
          initialPath={initialPath}
          onPathChange={handlePathChange}
        />
      </div>
    </div>
  )
}
