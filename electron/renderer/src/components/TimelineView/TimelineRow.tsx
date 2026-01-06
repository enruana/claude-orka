import React from 'react'
import type { LayoutNode, BranchStatus } from './types'

interface TimelineRowProps {
  node: LayoutNode
  rowHeight: number
  isSelected?: boolean
  onClick?: () => void
}

/**
 * Renders a single row in the info panel, aligned with its node
 */
export function TimelineRow({
  node,
  rowHeight,
  isSelected = false,
  onClick,
}: TimelineRowProps) {
  const { event, branch } = node

  const getStatusIcon = (status?: BranchStatus) => {
    switch (status) {
      case 'active':
        return '●'
      case 'saved':
        return '◐'
      case 'merged':
        return '◆'
      case 'closed':
        return '○'
      default:
        return '●'
    }
  }

  const getStatusColor = (status?: BranchStatus) => {
    switch (status) {
      case 'active':
        return '#a6e3a1'
      case 'saved':
        return '#f9e2af'
      case 'merged':
        return '#94e2d5'
      case 'closed':
        return '#6c7086'
      default:
        return '#cdd6f4'
    }
  }

  const getEventTypeLabel = () => {
    switch (event.type) {
      case 'session-start':
        return 'Session'
      case 'fork-create':
        return 'Fork'
      case 'fork-merge':
        return 'Merge'
      case 'fork-close':
        return 'Close'
      case 'fork-save':
        return 'Save'
      default:
        return ''
    }
  }

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  return (
    <div
      className={`timeline-row ${isSelected ? 'selected' : ''}`}
      style={{
        height: rowHeight,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        cursor: 'pointer',
        backgroundColor: isSelected ? 'rgba(137, 180, 250, 0.15)' : 'transparent',
        borderLeft: `3px solid ${isSelected ? branch.color : 'transparent'}`,
        transition: 'background-color 0.15s ease',
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (!isSelected) {
          e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)'
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          e.currentTarget.style.backgroundColor = 'transparent'
        }
      }}
    >
      {/* Status indicator */}
      <span
        style={{
          color: getStatusColor(event.status),
          marginRight: 8,
          fontSize: 10,
        }}
      >
        {getStatusIcon(event.status)}
      </span>

      {/* Event type badge */}
      <span
        style={{
          backgroundColor: branch.color,
          color: '#1e1e2e',
          padding: '2px 6px',
          borderRadius: 4,
          fontSize: 10,
          fontWeight: 600,
          marginRight: 8,
          minWidth: 45,
          textAlign: 'center',
        }}
      >
        {getEventTypeLabel()}
      </span>

      {/* Label */}
      <span
        style={{
          flex: 1,
          color: '#cdd6f4',
          fontSize: 13,
          fontWeight: isSelected ? 500 : 400,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {event.label}
      </span>

      {/* Timestamp */}
      <span
        style={{
          color: '#6c7086',
          fontSize: 11,
          marginLeft: 8,
        }}
      >
        {formatTime(event.timestamp)}
      </span>
    </div>
  )
}

export default TimelineRow
