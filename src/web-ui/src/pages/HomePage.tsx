/**
 * HomePage - Entry point with navigation cards to Sessions and Agents
 */

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { FolderOpen, Bot } from 'lucide-react'
import { api } from '../api/client'
import { agentsApi } from '../api/agents'

export function HomePage() {
  const navigate = useNavigate()
  const [projectCount, setProjectCount] = useState<number | null>(null)
  const [agentCount, setAgentCount] = useState<number | null>(null)

  useEffect(() => {
    api.listProjects().then((p) => setProjectCount(p.length)).catch(() => {})
    agentsApi.list().then((a) => setAgentCount(a.length)).catch(() => {})
  }, [])

  return (
    <>
      <style>{`
        .home-page {
          min-height: 100%;
          min-height: 100dvh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 24px;
          gap: 48px;
        }

        .home-header {
          text-align: center;
        }

        .home-header h1 {
          font-size: 32px;
          font-weight: 700;
          color: var(--text-primary);
          margin: 0;
        }

        .home-header p {
          margin: 8px 0 0;
          color: var(--text-secondary);
          font-size: 14px;
        }

        .home-cards {
          display: flex;
          gap: 20px;
          width: 100%;
          max-width: 640px;
        }

        .home-card {
          flex: 1;
          background: var(--bg-secondary);
          border: 1px solid var(--border-primary);
          border-radius: var(--radius-lg);
          padding: 32px 24px;
          cursor: pointer;
          transition: background var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
          text-align: center;
        }

        .home-card:hover {
          background: var(--bg-tertiary);
          border-color: var(--accent-blue);
          box-shadow: var(--shadow-md);
        }

        .home-card-icon {
          width: 56px;
          height: 56px;
          border-radius: var(--radius-md);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .home-card-icon.sessions {
          background: rgba(10, 132, 255, 0.12);
          color: var(--accent-blue);
        }

        .home-card-icon.agents {
          background: rgba(191, 90, 242, 0.12);
          color: var(--accent-purple);
        }

        .home-card h2 {
          font-size: 18px;
          font-weight: 600;
          color: var(--text-primary);
          margin: 0;
        }

        .home-card p {
          font-size: 13px;
          color: var(--text-secondary);
          margin: 0;
          line-height: 1.4;
        }

        .home-badge {
          font-size: 12px;
          font-weight: 500;
          padding: 2px 10px;
          border-radius: 999px;
          background: var(--bg-tertiary);
          color: var(--text-secondary);
        }

        @media (max-width: 520px) {
          .home-cards {
            flex-direction: column;
          }
        }
      `}</style>

      <div className="home-page">
        <div className="home-header">
          <h1>Claude Orka</h1>
          <p>Session orchestration for Claude Code</p>
        </div>

        <div className="home-cards">
          <div className="home-card" onClick={() => navigate('/dashboard')}>
            <div className="home-card-icon sessions">
              <FolderOpen size={28} />
            </div>
            <h2>Sessions</h2>
            <p>Manage projects and Claude Code sessions</p>
            {projectCount !== null && (
              <span className="home-badge">
                {projectCount} project{projectCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          <div className="home-card" onClick={() => navigate('/agents')}>
            <div className="home-card-icon agents">
              <Bot size={28} />
            </div>
            <h2>Agents</h2>
            <p>Configure and monitor master agents</p>
            {agentCount !== null && (
              <span className="home-badge">
                {agentCount} agent{agentCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
