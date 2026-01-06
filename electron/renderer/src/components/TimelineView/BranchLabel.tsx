import React from 'react'
import type { BranchLane, BranchStatus } from './types'

interface BranchLabelProps {
  branch: BranchLane
  y: number
  isVisible?: boolean
  onClick?: () => void
}

/**
 * Renders a branch label/tag that appears alongside nodes
 */
export function BranchLabel({
  branch,
  y,
  isVisible = true,
  onClick,
}: BranchLabelProps) {
  if (!isVisible) return null

  const getStatusBadge = (status: BranchStatus) => {
    switch (status) {
      case 'active':
        return { text: '', color: '' }
      case 'saved':
        return { text: 'SAVED', color: '#f9e2af' }
      case 'merged':
        return { text: 'MERGED', color: '#94e2d5' }
      case 'closed':
        return { text: 'CLOSED', color: '#6c7086' }
      default:
        return { text: '', color: '' }
    }
  }

  const statusBadge = getStatusBadge(branch.status)

  return (
    <div
      style={{
        position: 'absolute',
        left: 24,
        top: y - 12,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        cursor: onClick ? 'pointer' : 'default',
      }}
      onClick={onClick}
    >
      {/* Branch name tag */}
      <span
        style={{
          backgroundColor: branch.color,
          color: '#1e1e2e',
          padding: '3px 8px',
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 600,
          maxWidth: 120,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {branch.name}
      </span>

      {/* Status badge if not active */}
      {statusBadge.text && (
        <span
          style={{
            backgroundColor: statusBadge.color,
            color: '#1e1e2e',
            padding: '2px 5px',
            borderRadius: 3,
            fontSize: 9,
            fontWeight: 700,
          }}
        >
          {statusBadge.text}
        </span>
      )}
    </div>
  )
}

export default BranchLabel
