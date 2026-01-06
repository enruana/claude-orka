import React from 'react'

interface BranchLineProps {
  x: number
  startY: number
  endY: number
  color: string
  isActive?: boolean
  strokeWidth?: number
}

/**
 * Renders a vertical branch line in the timeline
 */
export function BranchLine({
  x,
  startY,
  endY,
  color,
  isActive = false,
  strokeWidth = 2,
}: BranchLineProps) {
  const lineId = `branch-line-${x}-${startY}`

  return (
    <g className="branch-line">
      {/* Main line */}
      <line
        x1={x}
        y1={startY}
        x2={x}
        y2={endY}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />

      {/* Animated dash overlay for active branches */}
      {isActive && (
        <line
          x1={x}
          y1={startY}
          x2={x}
          y2={endY}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray="4 4"
          style={{
            animation: 'dashMove 1s linear infinite',
          }}
        />
      )}

      <style>{`
        @keyframes dashMove {
          from {
            stroke-dashoffset: 8;
          }
          to {
            stroke-dashoffset: 0;
          }
        }
      `}</style>
    </g>
  )
}

export default BranchLine
