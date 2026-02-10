/**
 * AgentLogsModal - Modal for viewing agent logs and activity
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, RefreshCw, Trash2 } from 'lucide-react'
import type { Agent } from '../../api/agents'

interface AgentLog {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug' | 'action'
  message: string
  details?: Record<string, unknown>
}

interface AgentLogsModalProps {
  agent: Agent | null
  isOpen: boolean
  onClose: () => void
}

// Use window.location.origin for mobile/VPN compatibility
const getApiBase = () => `${window.location.origin}/api`

export function AgentLogsModal({ agent, isOpen, onClose }: AgentLogsModalProps) {
  const [logs, setLogs] = useState<AgentLog[]>([])
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [filter, setFilter] = useState<'all' | 'action' | 'error'>('all')
  const logsEndRef = useRef<HTMLDivElement>(null)

  const fetchLogs = useCallback(async () => {
    if (!agent) return

    try {
      setLoading(true)
      const res = await fetch(`${getApiBase()}/agents/${agent.id}/logs`)
      if (res.ok) {
        const data = await res.json()
        setLogs(data.logs || [])
      }
    } catch (err) {
      console.error('Failed to fetch logs:', err)
    } finally {
      setLoading(false)
    }
  }, [agent])

  const clearLogs = async () => {
    if (!agent) return

    try {
      await fetch(`${getApiBase()}/agents/${agent.id}/logs`, { method: 'DELETE' })
      setLogs([])
    } catch (err) {
      console.error('Failed to clear logs:', err)
    }
  }

  // Initial fetch
  useEffect(() => {
    if (isOpen && agent) {
      fetchLogs()
    }
  }, [isOpen, agent, fetchLogs])

  // Auto-refresh
  useEffect(() => {
    if (!isOpen || !autoRefresh || !agent) return

    const interval = setInterval(fetchLogs, 2000)
    return () => clearInterval(interval)
  }, [isOpen, autoRefresh, agent, fetchLogs])

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoRefresh && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoRefresh])

  if (!isOpen || !agent) return null

  const filteredLogs = logs.filter(log => {
    if (filter === 'all') return true
    if (filter === 'action') return log.level === 'action'
    if (filter === 'error') return log.level === 'error' || log.level === 'warn'
    return true
  })

  const getLevelColor = (level: AgentLog['level']) => {
    switch (level) {
      case 'error': return '#f38ba8'
      case 'warn': return '#f9e2af'
      case 'action': return '#a6e3a1'
      case 'debug': return '#6c7086'
      default: return '#cdd6f4'
    }
  }

  const getLevelIcon = (level: AgentLog['level']) => {
    switch (level) {
      case 'error': return '❌'
      case 'warn': return '⚠️'
      case 'action': return '🎯'
      case 'debug': return '🔍'
      default: return '📝'
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#1e1e2e',
          borderRadius: '12px',
          width: '90%',
          maxWidth: '900px',
          height: '80%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid #313244',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #313244',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: '1.2rem', color: '#cdd6f4' }}>
              Agent Logs: {agent.name}
            </h2>
            <span style={{ fontSize: '0.8rem', color: '#6c7086' }}>
              Status: {agent.status} | {logs.length} logs
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: '#6c7086',
              padding: '4px',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Toolbar */}
        <div
          style={{
            padding: '12px 20px',
            borderBottom: '1px solid #313244',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          {/* Filter */}
          <select
            value={filter}
            onChange={e => setFilter(e.target.value as typeof filter)}
            style={{
              background: '#313244',
              color: '#cdd6f4',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 12px',
              fontSize: '0.85rem',
            }}
          >
            <option value="all">All Logs</option>
            <option value="action">Actions Only</option>
            <option value="error">Errors/Warnings</option>
          </select>

          {/* Auto-refresh toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', color: '#a6adc8' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh
          </label>

          <div style={{ flex: 1 }} />

          {/* Refresh button */}
          <button
            onClick={fetchLogs}
            disabled={loading}
            style={{
              background: '#313244',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              color: '#cdd6f4',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '0.85rem',
            }}
          >
            <RefreshCw size={14} className={loading ? 'spinning' : ''} />
            Refresh
          </button>

          {/* Clear button */}
          <button
            onClick={clearLogs}
            style={{
              background: '#45475a',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              color: '#f38ba8',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '0.85rem',
            }}
          >
            <Trash2 size={14} />
            Clear
          </button>
        </div>

        {/* Logs list */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '12px 20px',
            fontFamily: 'monospace',
            fontSize: '0.85rem',
          }}
        >
          {filteredLogs.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#6c7086', padding: '40px' }}>
              No logs yet. Start the agent to see activity.
            </div>
          ) : (
            filteredLogs.map(log => (
              <div
                key={log.id}
                style={{
                  padding: '8px 12px',
                  marginBottom: '4px',
                  background: '#11111b',
                  borderRadius: '6px',
                  borderLeft: `3px solid ${getLevelColor(log.level)}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <span>{getLevelIcon(log.level)}</span>
                  <span style={{ color: '#6c7086', fontSize: '0.75rem' }}>
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span
                    style={{
                      background: getLevelColor(log.level),
                      color: '#1e1e2e',
                      padding: '1px 6px',
                      borderRadius: '4px',
                      fontSize: '0.7rem',
                      fontWeight: 'bold',
                      textTransform: 'uppercase',
                    }}
                  >
                    {log.level}
                  </span>
                </div>
                <div style={{ color: '#cdd6f4', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {log.message}
                </div>
                {log.details && (
                  <details style={{ marginTop: '8px' }}>
                    <summary style={{ color: '#89b4fa', cursor: 'pointer', fontSize: '0.8rem' }}>
                      Details
                    </summary>
                    <pre
                      style={{
                        background: '#181825',
                        padding: '8px',
                        borderRadius: '4px',
                        marginTop: '4px',
                        overflow: 'auto',
                        fontSize: '0.75rem',
                        color: '#a6adc8',
                      }}
                    >
                      {JSON.stringify(log.details, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>

        {/* Footer with agent info */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid #313244',
            fontSize: '0.8rem',
            color: '#6c7086',
            display: 'flex',
            gap: '20px',
          }}
        >
          {agent.connection && (
            <span>Connected to: {agent.connection.projectPath}</span>
          )}
          {agent.lastActivity && (
            <span>Last activity: {new Date(agent.lastActivity).toLocaleString()}</span>
          )}
          <span>Consecutive responses: {agent.consecutiveResponses}/{agent.maxConsecutiveResponses}</span>
        </div>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .spinning {
          animation: spin 1s linear infinite;
        }
      `}</style>
    </div>
  )
}
