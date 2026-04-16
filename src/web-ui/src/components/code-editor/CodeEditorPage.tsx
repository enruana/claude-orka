import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { CodeEditorView } from './CodeEditorView'

export function CodeEditorPage() {
  const { encodedPath } = useParams<{ encodedPath: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const initialFile = searchParams.get('file') || undefined

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

  return (
    <CodeEditorView
      projectPath={projectPath}
      encodedPath={encodedPath}
      onBack={() => navigate(`/projects/${encodedPath}`)}
      initialFile={initialFile}
    />
  )
}
