import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Share2 } from 'lucide-react'
import { KBGraph } from './KBGraph'
import { usePageTitle } from '../../hooks/usePageTitle'

export function KBPage() {
  const { encodedPath } = useParams<{ encodedPath: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const sessionId = searchParams.get('sessionId') || undefined
  const branch = searchParams.get('branch') || undefined

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

  usePageTitle(projectName, 'Knowledge')

  return (
    <div className="kb-page-container">
      <div className="kb-page-header">
        <button className="icon-button" onClick={() => navigate(-1)} title="Go back">
          <ArrowLeft size={18} />
        </button>
        <div className="kb-page-info">
          <Share2 size={14} />
          <span className="kb-page-project">{projectName}</span>
          <span className="kb-page-separator">/</span>
          <span className="kb-page-title">Knowledge</span>
        </div>
      </div>
      <div className="kb-page-content">
        <KBGraph
          projectPath={projectPath}
          encodedPath={encodedPath}
          sessionId={sessionId}
          branch={branch}
          visible
        />
      </div>
    </div>
  )
}
