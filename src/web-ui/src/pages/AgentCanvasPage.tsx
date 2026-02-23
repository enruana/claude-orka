/**
 * AgentCanvasPage - Page wrapper for the Agent Canvas
 */

import { Link } from 'react-router-dom'
import { AgentCanvas } from '../components/agent'
import { usePageTitle } from '../hooks/usePageTitle'
import '../styles/agent-canvas.css'

export function AgentCanvasPage() {
  usePageTitle('Agents')
  return (
    <div className="agent-canvas-page">
      <header className="agent-canvas-header">
        <h1>🤖 Master Agents</h1>
        <div className="header-actions">
          <Link to="/" className="btn btn-secondary">
            ← Home
          </Link>
        </div>
      </header>

      <div className="agent-canvas-container">
        <AgentCanvas />
      </div>
    </div>
  )
}
