/**
 * AgentLogsModal - Modal for viewing agent logs
 *
 * Phase 1: Simple timeline of log entries grouped by cycle
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, RefreshCw, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import type { Agent } from '../../api/agents'

interface AgentLog {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug' | 'action'
  message: string
  details?: Record<string, unknown>
  cycleId?: string
}

interface AgentLogsModalProps {
  agent: Agent | null
  isOpen: boolean
  onClose: () => void
}

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

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

// Phase emoji mapping
const phaseIcons: Record<string, string> = {
  hook_incoming: '📨',
  hook_filter: '🚫',
  hook_accepted: '✅',
  hook_session_start: '🔄',
  hook_received: '📥',
  terminal_capture: '📸',
  terminal_state: '🔍',
  decision: '💭',
  execution: '🎯',
  cycle_done: '✅',
  capture: '📸',
  analyze: '🔍',
  decide: '💭',
  execute: '🎯',
  done: '✅',
}

function getLevelColor(level: AgentLog['level']) {
  switch (level) {
    case 'error': return '#f38ba8'
    case 'warn': return '#f9e2af'
    case 'action': return '#a6e3a1'
    case 'debug': return '#6c7086'
    default: return '#cdd6f4'
  }
}

/** Pick a left-border color based on the cycle's final decision action */
function getCycleBorderColor(action?: string): string {
  switch (action) {
    case 'respond':
    case 'approve':
      return '#a6e3a1'  // green
    case 'wait':
      return '#f9e2af'  // yellow
    case 'request_help':
    case 'reject':
      return '#f38ba8'  // red
    case 'compact':
    case 'escape':
      return '#89b4fa'  // blue
    default:
      return '#585b70'  // muted
  }
}

/** Group logs into cycles + standalone entries in display order */
function groupLogsByCycle(logs: AgentLog[]): Array<{ type: 'cycle'; cycleId: string; logs: AgentLog[] } | { type: 'standalone'; log: AgentLog }> {
  const groups: Array<{ type: 'cycle'; cycleId: string; logs: AgentLog[] } | { type: 'standalone'; log: AgentLog }> = []
  const cycleMap = new Map<string, AgentLog[]>()

  for (const log of logs) {
    if (log.cycleId) {
      if (!cycleMap.has(log.cycleId)) {
        cycleMap.set(log.cycleId, [])
      }
      cycleMap.get(log.cycleId)!.push(log)
    }
  }

  const emittedCycles = new Set<string>()
  for (const log of logs) {
    if (log.cycleId) {
      if (!emittedCycles.has(log.cycleId)) {
        emittedCycles.add(log.cycleId)
        groups.push({ type: 'cycle', cycleId: log.cycleId, logs: cycleMap.get(log.cycleId)! })
      }
    } else {
      groups.push({ type: 'standalone', log })
    }
  }

  return groups
}

/** Extract summary info from a cycle's logs */
function getCycleSummary(cycleLogs: AgentLog[]) {
  let eventType = ''
  let action = ''
  let durationMs = 0
  let response = ''

  for (const log of cycleLogs) {
    const d = log.details as Record<string, unknown> | undefined
    if (!d?.phase) continue
    if (d.phase === 'hook_received' || d.phase === 'hook_incoming' || d.phase === 'hook_accepted' || d.phase === 'capture') {
      eventType = (d.eventType as string) || eventType
    }
    if (d.phase === 'decision' || d.phase === 'decide') {
      action = (d.action as string) || (d.decision as Record<string, unknown>)?.action as string || action
      response = (d.response as string) || (d.decision as Record<string, unknown>)?.response as string || response
    }
    if (d.phase === 'cycle_done' || d.phase === 'done') {
      durationMs = (d.durationMs as number) || durationMs
    }
  }

  return { eventType, action, durationMs, response }
}

// --- Cycle Card Component ---
function CycleCard({ cycleLogs, defaultExpanded, filter }: { cycleLogs: AgentLog[]; defaultExpanded: boolean; filter: 'all' | 'action' | 'error' | 'hooks' }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const summary = getCycleSummary(cycleLogs)
  const timestamp = cycleLogs[0]?.timestamp

  const filteredLogs = cycleLogs.filter(log => {
    if (filter === 'all') return true
    if (filter === 'action') return log.level === 'action'
    if (filter === 'error') return log.level === 'error' || log.level === 'warn'
    if (filter === 'hooks') {
      const p = (log.details as Record<string, unknown>)?.phase as string | undefined
      return p === 'hook_incoming' || p === 'hook_filter' || p === 'hook_accepted' || p === 'hook_received' || p === 'hook_session_start'
    }
    return true
  })

  if (filter !== 'all' && filteredLogs.length === 0) return null

  return (
    <div
      style={{
        background: '#1e1e2e',
        borderRadius: '8px',
        marginBottom: '6px',
        borderLeft: `3px solid ${getCycleBorderColor(summary.action)}`,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '10px 14px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          userSelect: 'none',
        }}
      >
        {expanded
          ? <ChevronDown size={14} style={{ color: '#6c7086', flexShrink: 0 }} />
          : <ChevronRight size={14} style={{ color: '#6c7086', flexShrink: 0 }} />
        }
        <span style={{ color: '#6c7086', fontSize: '0.75rem', flexShrink: 0, width: '65px' }}>
          {timestamp ? new Date(timestamp).toLocaleTimeString() : ''}
        </span>
        {summary.eventType && (
          <span style={{
            background: '#313244',
            color: '#cdd6f4',
            padding: '1px 8px',
            borderRadius: '4px',
            fontSize: '0.7rem',
            fontWeight: 600,
            flexShrink: 0,
          }}>
            {summary.eventType}
          </span>
        )}
        {summary.action && (
          <span style={{ fontSize: '0.85rem', flexShrink: 0 }}>
            {actionIcons[summary.action] || '❓'} {summary.action}
          </span>
        )}
        {summary.response && (
          <span style={{
            color: '#a6adc8',
            fontSize: '0.8rem',
            fontStyle: 'italic',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            "{summary.response}"
          </span>
        )}
        {!summary.response && <span style={{ flex: 1 }} />}
        {summary.durationMs > 0 && (
          <span style={{ color: '#6c7086', fontSize: '0.75rem', flexShrink: 0 }}>
            {summary.durationMs < 1000 ? `${summary.durationMs}ms` : `${(summary.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>

      {/* Body */}
      {expanded && (
        <div style={{ padding: '0 14px 10px 14px' }}>
          {filteredLogs.map(log => {
            const phase = (log.details as Record<string, unknown>)?.phase as string | undefined
            const icon = (phase && phaseIcons[phase]) || (log.level === 'error' ? '❌' : log.level === 'warn' ? '⚠️' : '📝')
            const isRowExpanded = expandedRow === log.id

            return (
              <div
                key={log.id}
                style={{
                  background: '#11111b',
                  borderRadius: '4px',
                  marginBottom: '2px',
                  fontSize: '0.8rem',
                }}
              >
                <div
                  onClick={() => setExpandedRow(isRowExpanded ? null : log.id)}
                  style={{
                    padding: '5px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    cursor: log.details ? 'pointer' : 'default',
                  }}
                >
                  <span style={{ flexShrink: 0 }}>{icon}</span>
                  <span style={{ color: getLevelColor(log.level), whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
                    {log.message}
                  </span>
                  <span style={{ color: '#45475a', fontSize: '0.7rem', flexShrink: 0 }}>
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                {isRowExpanded && log.details && (
                  <pre
                    style={{
                      background: '#181825',
                      padding: '6px 10px',
                      margin: '0 10px 6px 10px',
                      borderRadius: '4px',
                      overflow: 'auto',
                      fontSize: '0.7rem',
                      color: '#a6adc8',
                      maxHeight: '200px',
                    }}
                  >
                    {JSON.stringify(log.details, null, 2)}
                  </pre>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// --- Standalone Log Row ---
function StandaloneLogRow({ log }: { log: AgentLog }) {
  const [expanded, setExpanded] = useState(false)
  const phase = (log.details as Record<string, unknown>)?.phase as string | undefined
  const isHookEvent = phase === 'hook_incoming' || phase === 'hook_filter' || phase === 'hook_accepted' || phase === 'hook_session_start'
  const isFiltered = phase === 'hook_filter'

  return (
    <div
      style={{
        background: isHookEvent ? '#1e1e2e' : '#11111b',
        borderRadius: '6px',
        marginBottom: isHookEvent ? '8px' : '4px',
        marginTop: isHookEvent ? '8px' : '0',
        borderLeft: `3px solid ${isFiltered ? '#f38ba8' : getLevelColor(log.level)}`,
        fontSize: '0.8rem',
        border: isHookEvent ? '1px solid #313244' : undefined,
      }}
    >
      <div
        onClick={() => log.details && setExpanded(!expanded)}
        style={{
          padding: isHookEvent ? '8px 12px' : '6px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          cursor: log.details ? 'pointer' : 'default',
        }}
      >
        {isHookEvent && (
          <span style={{ flexShrink: 0 }}>{phaseIcons[phase!] || '📨'}</span>
        )}
        <span style={{ color: '#6c7086', fontSize: '0.75rem', flexShrink: 0 }}>
          {new Date(log.timestamp).toLocaleTimeString()}
        </span>
        <span style={{ color: isFiltered ? '#f38ba8' : getLevelColor(log.level), flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontWeight: isHookEvent ? 500 : 400 }}>
          {log.message}
        </span>
        {log.details && (
          <span style={{ color: '#45475a', fontSize: '0.7rem', flexShrink: 0 }}>
            {expanded ? '▼' : '▶'}
          </span>
        )}
      </div>
      {expanded && log.details && (
        <pre
          style={{
            background: '#181825',
            padding: '8px 12px',
            margin: '0 12px 8px 12px',
            borderRadius: '4px',
            overflow: 'auto',
            fontSize: '0.7rem',
            color: '#a6adc8',
            maxHeight: '300px',
          }}
        >
          {JSON.stringify(log.details, null, 2)}
        </pre>
      )}
    </div>
  )
}

// --- Main Modal ---
export function AgentLogsModal({ agent, isOpen, onClose }: AgentLogsModalProps) {
  const [logs, setLogs] = useState<AgentLog[]>([])
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [filter, setFilter] = useState<'all' | 'action' | 'error' | 'hooks'>('all')
  const logsEndRef = useRef<HTMLDivElement>(null)

  const fetchData = useCallback(async () => {
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
      fetchData()
    }
  }, [isOpen, agent, fetchData])

  // Auto-refresh
  useEffect(() => {
    if (!isOpen || !autoRefresh || !agent) return
    const interval = setInterval(fetchData, 2000)
    return () => clearInterval(interval)
  }, [isOpen, autoRefresh, agent, fetchData])

  // Scroll to bottom on new logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  if (!isOpen || !agent) return null

  const groups = groupLogsByCycle(logs)
  const cycleGroups = groups.filter(g => g.type === 'cycle')
  const lastThreeCycleIds = new Set(
    cycleGroups.slice(-3).map(g => g.type === 'cycle' ? g.cycleId : '')
  )

  // Filter standalone logs
  const filteredGroups = groups.filter(g => {
    if (g.type === 'cycle') return true
    const log = g.log
    if (filter === 'all') return true
    if (filter === 'action') return log.level === 'action'
    if (filter === 'error') return log.level === 'error' || log.level === 'warn'
    if (filter === 'hooks') {
      const p = (log.details as Record<string, unknown>)?.phase as string | undefined
      return p === 'hook_incoming' || p === 'hook_filter' || p === 'hook_accepted' || p === 'hook_received' || p === 'hook_session_start'
    }
    return true
  })

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
            padding: '8px 20px',
            borderBottom: '1px solid #313244',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <select
            value={filter}
            onChange={e => setFilter(e.target.value as typeof filter)}
            style={{
              background: '#313244',
              color: '#cdd6f4',
              border: 'none',
              borderRadius: '6px',
              padding: '4px 8px',
              fontSize: '0.8rem',
            }}
          >
            <option value="all">All</option>
            <option value="hooks">Hooks</option>
            <option value="action">Actions</option>
            <option value="error">Errors</option>
          </select>

          <div style={{ flex: 1 }} />

          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', color: '#a6adc8' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
            />
            Auto
          </label>

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
            }}
          >
            <RefreshCw size={12} className={loading ? 'spinning' : ''} />
          </button>

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

        {/* Log content */}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
          {filteredGroups.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#6c7086', padding: '40px' }}>
              No logs yet. Start the agent to see activity.
            </div>
          ) : (
            filteredGroups.map((group) => {
              if (group.type === 'cycle') {
                return (
                  <CycleCard
                    key={group.cycleId}
                    cycleLogs={group.logs}
                    defaultExpanded={lastThreeCycleIds.has(group.cycleId)}
                    filter={filter}
                  />
                )
              } else {
                return <StandaloneLogRow key={group.log.id} log={group.log} />
              }
            })
          )}
          <div ref={logsEndRef} />
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
          <span>Status: {agent.status}</span>
          {agent.lastActivity && (
            <span>Last activity: {timeAgo(agent.lastActivity)}</span>
          )}
          <span style={{ marginLeft: 'auto' }}>
            hooks: [{agent.hookEvents.join(', ')}]
          </span>
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
