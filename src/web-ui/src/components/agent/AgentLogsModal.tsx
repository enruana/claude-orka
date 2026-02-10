/**
 * AgentLogsModal - Modal for viewing agent logs, status, and decisions
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, RefreshCw, Trash2 } from 'lucide-react'
import type { Agent, AgentStatusSummary } from '../../api/agents'

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

type TabId = 'overview' | 'timeline' | 'decisions'

const getApiBase = () => `${window.location.origin}/api`

const actionIcons: Record<string, string> = {
  respond: '💬',
  approve: '✅',
  reject: '❌',
  wait: '⏸',
  request_help: '🆘',
  compact: '📦',
  escape: '⎋',
}

const phaseLabels: Record<string, string> = {
  idle: 'Idle',
  capture: 'Capturing',
  analyze: 'Analyzing',
  decide: 'Deciding',
  execute: 'Executing',
  done: 'Done',
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = confidence * 100
  const color = confidence >= 0.7 ? '#a6e3a1' : confidence >= 0.4 ? '#f9e2af' : '#f38ba8'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <div
        style={{
          width: '60px',
          height: '6px',
          background: '#313244',
          borderRadius: '3px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            borderRadius: '3px',
          }}
        />
      </div>
      <span style={{ fontSize: '0.8rem', color: '#a6adc8' }}>{pct.toFixed(0)}%</span>
    </div>
  )
}

// --- Overview Tab ---
function OverviewTab({ status, logs }: { status: AgentStatusSummary | null; logs: AgentLog[] }) {
  if (!status) {
    return (
      <div style={{ textAlign: 'center', color: '#6c7086', padding: '40px' }}>
        Loading status...
      </div>
    )
  }

  // Extract decision logs from all logs
  const decisionLogs = logs
    .filter(l => l.details && (l.details as Record<string, unknown>).phase === 'decide' && (l.details as Record<string, unknown>).decision)
    .slice(-10)
    .reverse()

  const snapshotLines = status.lastTerminalSnapshot?.split('\n') || []

  return (
    <div style={{ padding: '16px 20px', overflow: 'auto', flex: 1 }}>
      {/* Current Status Card */}
      <div
        style={{
          background: '#181825',
          borderRadius: '8px',
          padding: '16px',
          marginBottom: '16px',
          border: '1px solid #313244',
        }}
      >
        <div style={{ fontSize: '0.75rem', color: '#6c7086', textTransform: 'uppercase', fontWeight: 600, marginBottom: '12px' }}>
          Current Status
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <span style={{ color: '#6c7086', fontSize: '0.8rem' }}>Phase: </span>
            <span style={{ color: '#cdd6f4', fontWeight: 500 }}>
              {phaseLabels[status.currentPhase] || status.currentPhase}
            </span>
          </div>
          {status.processingDuration != null && status.processingDuration > 0 && (
            <div>
              <span style={{ color: '#6c7086', fontSize: '0.8rem' }}>Processing: </span>
              <span style={{ color: '#cdd6f4' }}>{(status.processingDuration / 1000).toFixed(1)}s</span>
            </div>
          )}
          {status.lastDecision && (
            <>
              <div>
                <span style={{ color: '#6c7086', fontSize: '0.8rem' }}>Last action: </span>
                <span style={{ color: '#cdd6f4' }}>
                  {actionIcons[status.lastDecision.action] || ''} {status.lastDecision.action}
                </span>
              </div>
              <div>
                <span style={{ color: '#6c7086', fontSize: '0.8rem' }}>Confidence: </span>
                <ConfidenceBar confidence={status.lastDecision.confidence} />
              </div>
            </>
          )}
        </div>
        {status.lastDecision?.response && (
          <div style={{ marginTop: '10px', padding: '8px 12px', background: '#11111b', borderRadius: '6px' }}>
            <span style={{ color: '#6c7086', fontSize: '0.75rem' }}>Response: </span>
            <span style={{ color: '#a6adc8', fontStyle: 'italic' }}>"{status.lastDecision.response}"</span>
          </div>
        )}
      </div>

      {/* Terminal Snapshot */}
      {snapshotLines.length > 0 && (
        <div
          style={{
            borderRadius: '8px',
            overflow: 'hidden',
            marginBottom: '16px',
            border: '1px solid #313244',
          }}
        >
          <div
            style={{
              padding: '8px 16px',
              background: '#181825',
              fontSize: '0.75rem',
              color: '#6c7086',
              textTransform: 'uppercase',
              fontWeight: 600,
              borderBottom: '1px solid #313244',
            }}
          >
            Terminal Snapshot
          </div>
          <div
            style={{
              background: '#11111b',
              padding: '12px 16px',
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              lineHeight: '1.5',
              color: '#a6adc8',
              maxHeight: '250px',
              overflow: 'auto',
              whiteSpace: 'pre',
            }}
          >
            {snapshotLines.join('\n')}
          </div>
        </div>
      )}

      {/* Recent Decisions */}
      <div
        style={{
          borderRadius: '8px',
          overflow: 'hidden',
          border: '1px solid #313244',
        }}
      >
        <div
          style={{
            padding: '8px 16px',
            background: '#181825',
            fontSize: '0.75rem',
            color: '#6c7086',
            textTransform: 'uppercase',
            fontWeight: 600,
            borderBottom: '1px solid #313244',
          }}
        >
          Recent Decisions ({decisionLogs.length})
        </div>
        <div style={{ background: '#181825' }}>
          {decisionLogs.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#6c7086', fontSize: '0.85rem' }}>
              No decisions yet
            </div>
          ) : (
            decisionLogs.map(log => {
              const decision = (log.details as Record<string, unknown>).decision as Record<string, unknown>
              return (
                <div
                  key={log.id}
                  style={{
                    padding: '10px 16px',
                    borderBottom: '1px solid #1e1e2e',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                  }}
                >
                  <span style={{ color: '#6c7086', fontSize: '0.75rem', flexShrink: 0, width: '50px' }}>
                    {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span style={{ flexShrink: 0 }}>
                    {actionIcons[decision.action as string] || '❓'}
                  </span>
                  <span style={{ color: '#cdd6f4', fontWeight: 500, fontSize: '0.85rem', flexShrink: 0 }}>
                    {decision.action as string}
                  </span>
                  {decision.response && (
                    <span style={{ color: '#a6adc8', fontSize: '0.8rem', fontStyle: 'italic', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      "{decision.response as string}"
                    </span>
                  )}
                  {!decision.response && (
                    <span style={{ color: '#6c7086', fontSize: '0.8rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {decision.reason as string}
                    </span>
                  )}
                  <span style={{ flexShrink: 0 }}>
                    <ConfidenceBar confidence={decision.confidence as number} />
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

// --- Timeline Tab (existing flat log list) ---
function TimelineTab({ logs, filter }: { logs: AgentLog[]; filter: 'all' | 'action' | 'error' }) {
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

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
    <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px', fontFamily: 'monospace', fontSize: '0.85rem' }}>
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
  )
}

// --- Decisions Tab ---
function DecisionsTab({ logs }: { logs: AgentLog[] }) {
  const decisionLogs = logs
    .filter(l => l.details && (l.details as Record<string, unknown>).phase === 'decide' && (l.details as Record<string, unknown>).decision)
    .reverse()

  if (decisionLogs.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6c7086' }}>
        No decisions yet. The agent will make decisions when it receives hook events.
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
      {decisionLogs.map(log => {
        const decision = (log.details as Record<string, unknown>).decision as Record<string, unknown>
        return (
          <div
            key={log.id}
            style={{
              padding: '14px 16px',
              marginBottom: '8px',
              background: '#181825',
              borderRadius: '8px',
              borderLeft: '3px solid #89b4fa',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span style={{ fontSize: '1.1rem' }}>
                {actionIcons[decision.action as string] || '❓'}
              </span>
              <span style={{ color: '#cdd6f4', fontWeight: 600, fontSize: '1rem' }}>
                {(decision.action as string).toUpperCase()}
              </span>
              <div style={{ marginLeft: 'auto' }}>
                <ConfidenceBar confidence={decision.confidence as number} />
              </div>
              <span style={{ color: '#6c7086', fontSize: '0.8rem', flexShrink: 0 }}>
                {timeAgo(log.timestamp)}
              </span>
            </div>

            {decision.response && (
              <div
                style={{
                  padding: '8px 12px',
                  background: '#11111b',
                  borderRadius: '6px',
                  marginBottom: '8px',
                  color: '#a6adc8',
                  fontStyle: 'italic',
                  fontSize: '0.9rem',
                }}
              >
                "{decision.response as string}"
              </div>
            )}

            <div style={{ color: '#6c7086', fontSize: '0.85rem' }}>
              {decision.reason as string}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// --- Main Modal ---
export function AgentLogsModal({ agent, isOpen, onClose }: AgentLogsModalProps) {
  const [logs, setLogs] = useState<AgentLog[]>([])
  const [status, setStatus] = useState<AgentStatusSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [timelineFilter, setTimelineFilter] = useState<'all' | 'action' | 'error'>('all')

  const fetchData = useCallback(async () => {
    if (!agent) return

    try {
      setLoading(true)
      const [logsRes, statusRes] = await Promise.all([
        fetch(`${getApiBase()}/agents/${agent.id}/logs`),
        fetch(`${getApiBase()}/agents/${agent.id}/status`),
      ])

      if (logsRes.ok) {
        const data = await logsRes.json()
        setLogs(data.logs || [])
      }

      if (statusRes.ok) {
        const data = await statusRes.json()
        setStatus(data)
      }
    } catch (err) {
      console.error('Failed to fetch data:', err)
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
      fetchData()
    }
  }, [isOpen, agent, fetchData])

  // Auto-refresh
  useEffect(() => {
    if (!isOpen || !autoRefresh || !agent) return
    const interval = setInterval(fetchData, 2000)
    return () => clearInterval(interval)
  }, [isOpen, autoRefresh, agent, fetchData])

  if (!isOpen || !agent) return null

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'decisions', label: 'Decisions' },
  ]

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
              {agent.connection ? (
                <>Connected to: {agent.connection.projectPath.split('/').pop()}
                  {agent.connection.branchId && <span style={{ color: '#a6e3a1' }}> ({agent.connection.branchId})</span>}
                  {' | '}
                </>
              ) : ''}
              {logs.length} events
              {status?.stats && (
                <> | {status.stats.totalActions} actions | {status.stats.totalErrors} errors</>
              )}
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

        {/* Tab bar + toolbar */}
        <div
          style={{
            padding: '0 20px',
            borderBottom: '1px solid #313244',
            display: 'flex',
            alignItems: 'center',
            gap: '0',
          }}
        >
          {/* Tabs */}
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                background: 'transparent',
                border: 'none',
                borderBottom: activeTab === tab.id ? '2px solid #89b4fa' : '2px solid transparent',
                padding: '12px 16px',
                cursor: 'pointer',
                color: activeTab === tab.id ? '#89b4fa' : '#6c7086',
                fontSize: '0.9rem',
                fontWeight: activeTab === tab.id ? 600 : 400,
              }}
            >
              {tab.label}
            </button>
          ))}

          <div style={{ flex: 1 }} />

          {/* Timeline filter (only show on timeline tab) */}
          {activeTab === 'timeline' && (
            <select
              value={timelineFilter}
              onChange={e => setTimelineFilter(e.target.value as typeof timelineFilter)}
              style={{
                background: '#313244',
                color: '#cdd6f4',
                border: 'none',
                borderRadius: '6px',
                padding: '4px 8px',
                fontSize: '0.8rem',
                marginRight: '8px',
              }}
            >
              <option value="all">All</option>
              <option value="action">Actions</option>
              <option value="error">Errors</option>
            </select>
          )}

          {/* Auto-refresh toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', color: '#a6adc8', marginRight: '8px' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
            />
            Auto
          </label>

          {/* Refresh button */}
          <button
            onClick={fetchData}
            disabled={loading}
            style={{
              background: '#313244',
              border: 'none',
              borderRadius: '6px',
              padding: '4px 8px',
              cursor: 'pointer',
              color: '#cdd6f4',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '0.8rem',
              marginRight: '4px',
            }}
          >
            <RefreshCw size={12} className={loading ? 'spinning' : ''} />
          </button>

          {/* Clear button */}
          <button
            onClick={clearLogs}
            style={{
              background: '#45475a',
              border: 'none',
              borderRadius: '6px',
              padding: '4px 8px',
              cursor: 'pointer',
              color: '#f38ba8',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '0.8rem',
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {activeTab === 'overview' && <OverviewTab status={status} logs={logs} />}
          {activeTab === 'timeline' && <TimelineTab logs={logs} filter={timelineFilter} />}
          {activeTab === 'decisions' && <DecisionsTab logs={logs} />}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '10px 20px',
            borderTop: '1px solid #313244',
            fontSize: '0.8rem',
            color: '#6c7086',
            display: 'flex',
            gap: '20px',
          }}
        >
          <span>Responses: {agent.consecutiveResponses}/{agent.maxConsecutiveResponses === -1 ? '∞' : agent.maxConsecutiveResponses}</span>
          {agent.lastActivity && (
            <span>Last activity: {timeAgo(agent.lastActivity)}</span>
          )}
          {status?.stats.consecutiveWaits != null && status.stats.consecutiveWaits > 0 && (
            <span>Consecutive waits: {status.stats.consecutiveWaits}</span>
          )}
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
