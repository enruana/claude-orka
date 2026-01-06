import React from 'react'
import iconSrc from '../../assets/icon.png'

interface TimelineNodeProps {
  x: number
  y: number
  radius: number
  color: string
  type: 'session-start' | 'fork-create' | 'fork-merge' | 'fork-close' | 'fork-save'
  isSelected?: boolean
  isActive?: boolean
  onClick?: () => void
  nodeId: string
}

const TimelineNode: React.FC<TimelineNodeProps> = ({
  x,
  y,
  radius,
  color,
  type,
  isSelected = false,
  isActive = false,
  onClick,
  nodeId,
}) => {
  // Icon size slightly smaller than the circle to fit inside
  const iconSize = radius * 1.8
  const clipId = `clip-${nodeId}`

  return (
    <>
      <style>
        {`
          @keyframes pulse {
            0%, 100% {
              opacity: 1;
              transform: scale(1);
            }
            50% {
              opacity: 0.7;
              transform: scale(1.05);
            }
          }

          .timeline-node {
            cursor: pointer;
            transition: transform 0.15s ease-in-out;
          }

          .timeline-node:hover {
            transform: scale(1.1);
          }

          .timeline-node-active {
            animation: pulse 1.5s ease-in-out infinite;
            transform-origin: ${x}px ${y}px;
          }
        `}
      </style>

      {/* Clip path for circular image */}
      <defs>
        <clipPath id={clipId}>
          <circle cx={x} cy={y} r={radius - 2} />
        </clipPath>
      </defs>

      <g
        className={`timeline-node ${isActive ? 'timeline-node-active' : ''}`}
        onClick={onClick}
        style={{ transformOrigin: `${x}px ${y}px` }}
      >
        {/* Glow effect when selected */}
        {isSelected && (
          <circle
            cx={x}
            cy={y}
            r={radius + 6}
            fill="none"
            stroke={color}
            strokeWidth={3}
            opacity={0.4}
          />
        )}

        {/* Outer glow for selected state */}
        {isSelected && (
          <circle
            cx={x}
            cy={y}
            r={radius + 10}
            fill="none"
            stroke={color}
            strokeWidth={2}
            opacity={0.2}
          />
        )}

        {/* Background circle */}
        <circle
          cx={x}
          cy={y}
          r={radius}
          fill="#1e1e2e"
        />

        {/* Icon image clipped to circle */}
        <image
          href={iconSrc}
          x={x - iconSize / 2}
          y={y - iconSize / 2}
          width={iconSize}
          height={iconSize}
          clipPath={`url(#${clipId})`}
        />

        {/* Border circle */}
        <circle
          cx={x}
          cy={y}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
        />
      </g>
    </>
  )
}

export default TimelineNode
