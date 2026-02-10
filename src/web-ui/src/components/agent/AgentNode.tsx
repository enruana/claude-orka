/**
 * AgentNode - ReactFlow node for displaying an Agent with live logs
 */

import { memo, useState, useEffect, useRef } from 'react'
import { Handle, Position, NodeProps } from '@xyflow/react'
import { Maximize2, Zap } from 'lucide-react'
import type { Agent, AgentStatus } from '../../api/agents'

interface AgentLog {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug' | 'action'
  message: string
}

interface AgentNodeData {
  agent: Agent
  onStart?: (agentId: string) => void
  onStop?: (agentId: string) => void
  onPause?: (agentId: string) => void
  onResume?: (agentId: string) => void
  onEdit?: (agent: Agent) => void
  onDelete?: (agentId: string) => void
  onViewLogs?: (agent: Agent) => void
  onTrigger?: (agentId: string) => void
}

const statusLabels: Record<AgentStatus, string> = {
  idle: 'Idle',
  active: 'Active',
  paused: 'Paused',
  waiting_human: 'Waiting for Human',
  error: 'Error',
}

const statusColors: Record<AgentStatus, string> = {
  idle: '#6c7086',
  active: '#a6e3a1',
  paused: '#f9e2af',
  waiting_human: '#fab387',
  error: '#f38ba8',
}

const levelColors: Record<AgentLog['level'], string> = {
  info: '#89b4fa',
  warn: '#f9e2af',
  error: '#f38ba8',
  debug: '#6c7086',
  action: '#a6e3a1',
}

const levelIcons: Record<AgentLog['level'], string> = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
  debug: '🔍',
  action: '▶️',
}

function AgentNodeComponent({ data, selected }: NodeProps<{ data: AgentNodeData }>) {
  const { agent, onStart, onStop, onPause, onResume, onEdit, onDelete, onViewLogs, onTrigger } = data.data
  const [logs, setLogs] = useState<AgentLog[]>([])
  const [isTriggering, setIsTriggering] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  // Fetch logs periodically
  useEffect(() => {
    const fetchLogs = async () => {
      try {
        // Use window.location.origin for mobile/VPN compatibility
        const baseUrl = window.location.origin
        const res = await fetch(`${baseUrl}/api/agents/${agent.id}/logs`)
        if (res.ok) {
          const data = await res.json()
          setLogs(data.logs?.slice(-20) || []) // Keep last 20 logs
        }
      } catch (err) {
        console.error('Failed to fetch agent logs:', err)
      }
    }

    fetchLogs()
    const interval = setInterval(fetchLogs, 2000)
    return () => clearInterval(interval)
  }, [agent.id])

  // Auto-scroll to bottom
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs])

  const handleStart = (e: React.MouseEvent) => {
    e.stopPropagation()
    onStart?.(agent.id)
  }

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation()
    onStop?.(agent.id)
  }

  const handlePause = (e: React.MouseEvent) => {
    e.stopPropagation()
    onPause?.(agent.id)
  }

  const handleResume = (e: React.MouseEvent) => {
    e.stopPropagation()
    onResume?.(agent.id)
  }

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    onEdit?.(agent)
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm(`Delete agent "${agent.name}"?`)) {
      onDelete?.(agent.id)
    }
  }

  const handleViewLogs = (e: React.MouseEvent) => {
    e.stopPropagation()
    onViewLogs?.(agent)
  }

  const handleTrigger = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isTriggering) return
    setIsTriggering(true)
    try {
      await onTrigger?.(agent.id)
    } finally {
      setIsTriggering(false)
    }
  }

  return (
    <div className={`agent-node ${selected ? 'selected' : ''}`} style={{ width: '320px' }}>
      {/* Input handle - for receiving connections from projects */}
      <Handle type="target" position={Position.Left} />

      <div className="node-header">
        <span className="icon">🤖</span>
        <span className="title">{agent.name}</span>
        <span
          style={{
            marginLeft: 'auto',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: statusColors[agent.status],
            boxShadow: agent.status === 'active' ? `0 0 8px ${statusColors[agent.status]}` : 'none',
          }}
        />
      </div>

      <div className="node-status">
        <span>{statusLabels[agent.status]}</span>
        {agent.connection && (
          <span style={{ marginLeft: '8px', color: '#6c7086', fontSize: '0.75rem' }}>
            → {agent.connection.projectPath.split('/').pop()}
          </span>
        )}
      </div>

      {/* Live Logs Preview */}
      <div
        style={{
          position: 'relative',
          marginTop: '8px',
        }}
      >
        {/* Action buttons - outside scroll container */}
        <div
          style={{
            position: 'absolute',
            top: '4px',
            right: '4px',
            display: 'flex',
            gap: '4px',
            zIndex: 10,
          }}
        >
          {/* Trigger button */}
          {agent.connection && (
            <button
              onClick={handleTrigger}
              disabled={isTriggering}
              className="nodrag"
              style={{
                background: isTriggering ? 'rgba(166, 227, 161, 0.3)' : 'rgba(0, 0, 0, 0.7)',
                border: 'none',
                borderRadius: '4px',
                padding: '4px',
                cursor: isTriggering ? 'wait' : 'pointer',
                color: '#a6e3a1',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              title="Trigger Agent (Manual)"
            >
              <Zap size={12} style={{ animation: isTriggering ? 'pulse 0.5s infinite' : 'none' }} />
            </button>
          )}

          {/* Expand button */}
          <button
            onClick={handleViewLogs}
            className="nodrag"
            style={{
              background: 'rgba(0, 0, 0, 0.7)',
              border: 'none',
              borderRadius: '4px',
              padding: '4px',
              cursor: 'pointer',
              color: '#89b4fa',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title="Expand Logs"
          >
            <Maximize2 size={12} />
          </button>
        </div>

        {/* Scrollable logs container */}
        <div
          className="logs-preview nodrag nopan nowheel"
          style={{
            background: '#11111b',
            borderRadius: '6px',
            height: '150px',
            overflow: 'auto',
            fontFamily: 'monospace',
            fontSize: '0.45rem',
          }}
        >
          {logs.length === 0 ? (
            <div
              style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#6c7086',
              }}
            >
              No logs yet
            </div>
          ) : (
            <div style={{ padding: '8px', paddingTop: '28px' }}>
              {logs.map(log => (
                <div
                  key={log.id}
                  style={{
                    padding: '2px 0',
                    borderBottom: '1px solid #1e1e2e',
                    display: 'flex',
                    gap: '4px',
                    alignItems: 'flex-start',
                  }}
                >
                  <span style={{ flexShrink: 0 }}>{levelIcons[log.level]}</span>
                  <span style={{ color: '#6c7086', flexShrink: 0, fontSize: '0.4rem' }}>
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span
                    style={{
                      color: levelColors[log.level],
                      wordBreak: 'break-word',
                      flex: 1,
                    }}
                  >
                    {log.message}
                  </span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>

      {agent.lastError && (
        <div
          style={{
            marginTop: '8px',
            padding: '6px 8px',
            background: 'rgba(243, 139, 168, 0.1)',
            borderRadius: '4px',
            color: '#f38ba8',
            fontSize: '0.75rem',
          }}
        >
          ⚠️ {agent.lastError}
        </div>
      )}

      <div className="node-actions" style={{ marginTop: '8px' }}>
        {agent.status === 'idle' && (
          <button className="node-action-btn primary" onClick={handleStart}>
            Start
          </button>
        )}
        {agent.status === 'active' && (
          <>
            <button className="node-action-btn secondary" onClick={handlePause}>
              Pause
            </button>
            <button className="node-action-btn danger" onClick={handleStop}>
              Stop
            </button>
          </>
        )}
        {agent.status === 'paused' && (
          <>
            <button className="node-action-btn primary" onClick={handleResume}>
              Resume
            </button>
            <button className="node-action-btn danger" onClick={handleStop}>
              Stop
            </button>
          </>
        )}
        {agent.status === 'waiting_human' && (
          <button className="node-action-btn primary" onClick={handleResume}>
            Acknowledge
          </button>
        )}
        {agent.status === 'error' && (
          <button className="node-action-btn primary" onClick={handleStart}>
            Retry
          </button>
        )}
      </div>

      <div className="node-actions" style={{ marginTop: '8px' }}>
        <button className="node-action-btn secondary" onClick={handleEdit}>
          Edit
        </button>
        <button className="node-action-btn danger" onClick={handleDelete}>
          Delete
        </button>
      </div>
    </div>
  )
}

export const AgentNode = memo(AgentNodeComponent)
