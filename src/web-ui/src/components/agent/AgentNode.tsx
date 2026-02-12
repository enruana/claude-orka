/**
 * AgentNode - ReactFlow node for displaying an Agent
 *
 * Phase 1: Name, status dot, connection info, Start/Stop/Edit/Delete buttons
 */

import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { Agent, AgentStatus } from '../../api/agents'

export interface AgentNodeData {
  agent: Agent
  onStart?: (agentId: string) => void
  onStop?: (agentId: string) => void
  onEdit?: (agent: Agent) => void
  onDelete?: (agentId: string) => void
  onViewLogs?: (agent: Agent) => void
}

const statusLabels: Record<AgentStatus, string> = {
  idle: 'Idle',
  active: 'Active',
  error: 'Error',
}

const statusColors: Record<AgentStatus, string> = {
  idle: '#6c7086',
  active: '#a6e3a1',
  error: '#f38ba8',
}

function AgentNodeComponent({ data, selected }: { data: { data: AgentNodeData }; selected?: boolean }) {
  const { agent, onStart, onStop, onEdit, onDelete, onViewLogs } = data.data

  const handleStart = (e: React.MouseEvent) => {
    e.stopPropagation()
    onStart?.(agent.id)
  }

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation()
    onStop?.(agent.id)
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

  return (
    <div className={`agent-node ${selected ? 'selected' : ''}`} style={{ width: '280px' }}>
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

      {/* Status + connection info */}
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
          {agent.lastError}
        </div>
      )}

      {/* Action buttons */}
      <div
        style={{
          marginTop: '8px',
          display: 'flex',
          gap: '4px',
          alignItems: 'center',
        }}
      >
        <button
          onClick={handleViewLogs}
          className="nodrag node-action-btn secondary"
        >
          Logs
        </button>

        <div style={{ flex: 1 }} />

        {agent.status === 'idle' && (
          <button className="node-action-btn primary" onClick={handleStart}>
            Start
          </button>
        )}
        {agent.status === 'active' && (
          <button className="node-action-btn danger" onClick={handleStop}>
            Stop
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
    </div>
  )
}

export const AgentNode = memo(AgentNodeComponent)
