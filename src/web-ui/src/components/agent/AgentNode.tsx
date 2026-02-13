/**
 * AgentNode - Rich ReactFlow node for displaying an Agent
 *
 * Shows: status accent bar, Bot icon, status badge, connection info,
 * master prompt preview, hook event pills, feature badges, error box,
 * and an icon action toolbar.
 */

import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import {
  Bot,
  Play,
  Square,
  RotateCcw,
  Pencil,
  Trash2,
  ScrollText,
  Link,
  Unlink,
  Send,
  ShieldCheck,
  ScanSearch,
  AlertTriangle,
} from 'lucide-react'
import type { Agent, AgentStatus, AgentHookTrigger } from '../../api/agents'

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

const hookShortNames: Record<AgentHookTrigger, string> = {
  Stop: 'Stop',
  Notification: 'Notif',
  SubagentStop: 'SubStop',
  PreCompact: 'Compact',
  SessionStart: 'SessStart',
  SessionEnd: 'SessEnd',
  PreToolUse: 'PreTool',
  PostToolUse: 'PostTool',
}

function AgentNodeComponent({ data, selected }: { data: { data: AgentNodeData }; selected?: boolean }) {
  const { agent, onStart, onStop, onEdit, onDelete, onViewLogs } = data.data
  const accentColor = statusColors[agent.status]

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

  const promptPreview = agent.masterPrompt
    ? agent.masterPrompt.length > 80
      ? `"${agent.masterPrompt.slice(0, 80)}..."`
      : `"${agent.masterPrompt}"`
    : null

  const projectName = agent.connection?.projectPath.split('/').pop()

  return (
    <div className={`agent-node ${selected ? 'selected' : ''}`} style={{ width: '280px' }}>
      {/* Status accent bar */}
      <div className="agent-node-accent" style={{ background: accentColor }} />

      {/* Input handle */}
      <Handle type="target" position={Position.Left} />

      {/* Header: Bot icon + name + status badge */}
      <div className="node-header">
        <Bot size={18} style={{ color: accentColor, flexShrink: 0 }} />
        <span className="title">{agent.name}</span>
        <span
          className="status-badge"
          style={{
            background: `${accentColor}22`,
            color: accentColor,
            borderColor: `${accentColor}44`,
          }}
        >
          {statusLabels[agent.status]}
        </span>
      </div>

      {/* Connection info */}
      <div className="agent-node-connection">
        {agent.connection ? (
          <>
            <Link size={12} style={{ flexShrink: 0 }} />
            <span className="connection-text">
              {projectName}
              {agent.connection.branchId && (
                <span className="connection-branch"> ({agent.connection.branchId})</span>
              )}
            </span>
          </>
        ) : (
          <>
            <Unlink size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
            <span style={{ opacity: 0.5 }}>Not connected</span>
          </>
        )}
      </div>

      {/* Master prompt preview */}
      {promptPreview && (
        <div className="master-prompt-preview">
          {promptPreview}
        </div>
      )}

      {/* Hook event pills */}
      {agent.hookEvents.length > 0 && (
        <div className="hook-pills">
          {agent.hookEvents.map((evt) => (
            <span key={evt} className="hook-pill">
              {hookShortNames[evt]}
            </span>
          ))}
        </div>
      )}

      {/* Feature badges */}
      {(agent.telegram?.enabled || agent.autoApprove || agent.watchdog?.enabled) && (
        <div className="feature-badges">
          {agent.telegram?.enabled && (
            <span className="feature-badge">
              <Send size={11} />
              Telegram
            </span>
          )}
          {agent.autoApprove && (
            <span className="feature-badge">
              <ShieldCheck size={11} />
              Auto-approve
            </span>
          )}
          {agent.watchdog?.enabled && (
            <span className="feature-badge">
              <ScanSearch size={11} />
              Watchdog
            </span>
          )}
        </div>
      )}

      {/* Error box */}
      {agent.lastError && (
        <div className="error-box">
          <AlertTriangle size={12} style={{ flexShrink: 0 }} />
          <span>{agent.lastError}</span>
        </div>
      )}

      {/* Action toolbar */}
      <div className="action-toolbar">
        <button
          onClick={handleViewLogs}
          className="nodrag node-action-btn secondary"
          title="View logs"
        >
          <ScrollText size={13} />
          Logs
        </button>

        <div style={{ flex: 1 }} />

        {agent.status === 'idle' && (
          <button className="nodrag node-action-btn primary" onClick={handleStart} title="Start agent">
            <Play size={13} />
            Start
          </button>
        )}
        {agent.status === 'active' && (
          <button className="nodrag node-action-btn danger" onClick={handleStop} title="Stop agent">
            <Square size={13} />
            Stop
          </button>
        )}
        {agent.status === 'error' && (
          <button className="nodrag node-action-btn primary" onClick={handleStart} title="Retry agent">
            <RotateCcw size={13} />
            Retry
          </button>
        )}

        <button className="nodrag icon-btn secondary" onClick={handleEdit} title="Edit agent">
          <Pencil size={13} />
        </button>
        <button className="nodrag icon-btn danger" onClick={handleDelete} title="Delete agent">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

export const AgentNode = memo(AgentNodeComponent)
