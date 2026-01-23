import { useParams, useNavigate } from 'react-router-dom'
import { FileExplorer } from './FileExplorer'
import { ArrowLeft } from 'lucide-react'
import './code-editor.css'

export function FilesPage() {
  const { encodedPath } = useParams<{ encodedPath: string }>()
  const navigate = useNavigate()

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
        <FileExplorer
          projectPath={projectPath}
          encodedPath={encodedPath}
        />
      </div>
    </div>
  )
}
