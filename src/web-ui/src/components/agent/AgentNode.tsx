/**
 * AgentNode - ReactFlow node for displaying an Agent with live status
 */

import { memo, useState, useEffect } from 'react'
import { Handle, Position, NodeProps } from '@xyflow/react'
import { Maximize2, Zap } from 'lucide-react'
import type { Agent, AgentStatus, AgentStatusSummary } from '../../api/agents'

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

const phaseLabels: Record<string, string> = {
  idle: 'Idle',
  capture: 'Capturing...',
  analyze: 'Analyzing...',
  decide: 'Deciding...',
  execute: 'Executing...',
  done: 'Done',
}

const phaseIcons: Record<string, string> = {
  idle: '💤',
  capture: '📸',
  analyze: '🔍',
  decide: '🤖',
  execute: '🎯',
  done: '✅',
}

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

function AgentNodeComponent({ data, selected }: NodeProps<{ data: AgentNodeData }>) {
  const { agent, onStart, onStop, onPause, onResume, onEdit, onDelete, onViewLogs, onTrigger } = data.data
  const [status, setStatus] = useState<AgentStatusSummary | null>(null)
  const [isTriggering, setIsTriggering] = useState(false)

  // Fetch status periodically
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const baseUrl = window.location.origin
        const res = await fetch(`${baseUrl}/api/agents/${agent.id}/status`)
        if (res.ok) {
          const data = await res.json()
          setStatus(data)
        }
      } catch (err) {
        console.error('Failed to fetch agent status:', err)
      }
    }

    fetchStatus()
    const interval = setInterval(fetchStatus, 2000)
    return () => clearInterval(interval)
  }, [agent.id])

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

  const currentPhase = status?.currentPhase || 'idle'
  const isActivePhase = ['capture', 'analyze', 'decide', 'execute'].includes(currentPhase)
  const lastDecision = status?.lastDecision
  const terminalSnapshot = status?.lastTerminalSnapshot
  const snapshotLines = terminalSnapshot?.split('\n').slice(-8) || []

  return (
    <div className={`agent-node ${selected ? 'selected' : ''}`} style={{ width: '340px' }}>
      {/* Input handle */}
      <Handle type="target" position={Position.Left} />

      {/* Header */}
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

      {/* Connection info with branch */}
      <div className="node-status">
        <span>{statusLabels[agent.status]}</span>
        {agent.connection && (
          <span style={{ marginLeft: '8px', color: '#89b4fa', fontSize: '0.6rem' }}>
            → {agent.connection.projectPath.split('/').pop()}
            {agent.connection.branchId && (
              <span style={{ color: '#a6e3a1' }}> ({agent.connection.branchId})</span>
            )}
          </span>
        )}
      </div>

      {/* Phase indicator */}
      <div
        style={{
          marginTop: '6px',
          padding: '4px 8px',
          background: '#181825',
          borderRadius: '4px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '0.6rem',
        }}
      >
        <span style={{ fontSize: '0.65rem' }}>{phaseIcons[currentPhase] || '💤'}</span>
        <span style={{ color: isActivePhase ? '#a6e3a1' : '#6c7086', fontWeight: 500 }}>
          {phaseLabels[currentPhase] || 'Idle'}
        </span>
        {isActivePhase && (
          <span
            style={{
              marginLeft: 'auto',
              width: '5px',
              height: '5px',
              borderRadius: '50%',
              background: '#a6e3a1',
              animation: 'pulse 1s ease-in-out infinite',
            }}
          />
        )}
        {status?.processingDuration && status.processingDuration > 0 && (
          <span style={{ marginLeft: 'auto', color: '#6c7086', fontSize: '0.55rem' }}>
            {(status.processingDuration / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {/* Last Decision Card */}
      {lastDecision && (
        <div
          style={{
            marginTop: '4px',
            padding: '5px 8px',
            background: '#181825',
            borderRadius: '4px',
            borderLeft: '2px solid #89b4fa',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '3px' }}>
            <span style={{ fontSize: '0.55rem', color: '#6c7086', textTransform: 'uppercase', fontWeight: 600 }}>
              Last Decision
            </span>
            <span style={{ marginLeft: 'auto', fontSize: '0.5rem', color: '#6c7086' }}>
              {timeAgo(lastDecision.timestamp)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
            <span style={{ fontSize: '0.6rem' }}>{actionIcons[lastDecision.action] || '❓'}</span>
            <span style={{ color: '#cdd6f4', fontSize: '0.6rem', fontWeight: 500 }}>
              {lastDecision.action}
            </span>
            {/* Confidence bar */}
            <div
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: '3px',
              }}
            >
              <div
                style={{
                  width: '32px',
                  height: '3px',
                  background: '#313244',
                  borderRadius: '2px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${lastDecision.confidence * 100}%`,
                    height: '100%',
                    background: lastDecision.confidence >= 0.7 ? '#a6e3a1' : lastDecision.confidence >= 0.4 ? '#f9e2af' : '#f38ba8',
                    borderRadius: '2px',
                  }}
                />
              </div>
              <span style={{ fontSize: '0.5rem', color: '#6c7086' }}>
                {(lastDecision.confidence * 100).toFixed(0)}%
              </span>
            </div>
          </div>
          {lastDecision.response && (
            <div style={{ color: '#a6adc8', fontSize: '0.55rem', marginBottom: '1px', fontStyle: 'italic' }}>
              "{lastDecision.response.length > 60 ? lastDecision.response.slice(0, 60) + '...' : lastDecision.response}"
            </div>
          )}
          <div style={{ color: '#6c7086', fontSize: '0.5rem' }}>
            {lastDecision.reason.length > 80 ? lastDecision.reason.slice(0, 80) + '...' : lastDecision.reason}
          </div>
        </div>
      )}

      {/* Terminal Snapshot */}
      {snapshotLines.length > 0 && (
        <div
          style={{
            marginTop: '4px',
            borderRadius: '4px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '3px 8px',
              background: '#181825',
              borderBottom: '1px solid #1e1e2e',
              fontSize: '0.5rem',
              color: '#6c7086',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Terminal Snapshot
          </div>
          <div
            className="nodrag nopan nowheel"
            style={{
              background: '#11111b',
              padding: '4px 6px',
              fontFamily: 'monospace',
              fontSize: '0.45rem',
              lineHeight: '1.35',
              color: '#a6adc8',
              maxHeight: '70px',
              overflow: 'auto',
              whiteSpace: 'pre',
            }}
          >
            {snapshotLines.join('\n')}
          </div>
        </div>
      )}

      {/* No activity placeholder */}
      {!lastDecision && !terminalSnapshot && agent.status !== 'idle' && (
        <div
          style={{
            marginTop: '4px',
            padding: '8px',
            background: '#181825',
            borderRadius: '4px',
            textAlign: 'center',
            color: '#6c7086',
            fontSize: '0.55rem',
          }}
        >
          No activity yet
        </div>
      )}

      {agent.lastError && (
        <div
          style={{
            marginTop: '4px',
            padding: '4px 6px',
            background: 'rgba(243, 139, 168, 0.1)',
            borderRadius: '4px',
            color: '#f38ba8',
            fontSize: '0.55rem',
          }}
        >
          ⚠️ {agent.lastError}
        </div>
      )}

      {/* Action buttons row */}
      <div
        style={{
          marginTop: '8px',
          display: 'flex',
          gap: '4px',
          alignItems: 'center',
        }}
      >
        {/* Trigger button */}
        {agent.connection && (
          <button
            onClick={handleTrigger}
            disabled={isTriggering}
            className="nodrag node-action-btn secondary"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              opacity: isTriggering ? 0.6 : 1,
              cursor: isTriggering ? 'wait' : 'pointer',
            }}
          >
            <Zap size={12} style={{ animation: isTriggering ? 'pulse 0.5s infinite' : 'none' }} />
            Trigger
          </button>
        )}

        {/* Expand logs */}
        <button
          onClick={handleViewLogs}
          className="nodrag node-action-btn secondary"
          style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          <Maximize2 size={12} />
          Logs
        </button>

        <div style={{ flex: 1 }} />

        {/* Status-dependent buttons */}
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

      <div className="node-actions" style={{ marginTop: '4px' }}>
        <button className="node-action-btn secondary" onClick={handleEdit}>
          Edit
        </button>
        <button className="node-action-btn danger" onClick={handleDelete}>
          Delete
        </button>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  )
}

export const AgentNode = memo(AgentNodeComponent)
