import React from 'react'

interface ConnectionPathProps {
  fromX: number
  fromY: number
  toX: number
  toY: number
  color: string
  type: 'continuation' | 'fork' | 'merge'
  animated?: boolean
  strokeWidth?: number
}

// Generate a stable ID for marker based on color (remove # from hex)
function getMarkerId(color: string, type: string): string {
  const colorId = color.replace('#', '')
  return `arrow-${type}-${colorId}`
}

function ConnectionPath({
  fromX,
  fromY,
  toX,
  toY,
  color,
  type,
  animated = false,
  strokeWidth = 2,
}: ConnectionPathProps): React.ReactElement {
  const markerId = getMarkerId(color, type)

  let d: string

  switch (type) {
    case 'continuation':
      // Straight vertical line - arrow points down
      d = `M ${fromX} ${fromY} L ${toX} ${toY}`
      break

    case 'fork': {
      // Straight horizontal line from parent lane to fork node
      d = `M ${fromX} ${fromY} L ${toX} ${toY}`
      break
    }

    case 'merge': {
      // L-shape path with one rounded corner: goes down, curves, then straight to parent
      const radius = 12 // Rounded corner radius
      const dropDistance = 20 // How far down to go before curving back

      // Direction: are we going left or right to reach parent?
      const goingLeft = toX < fromX

      if (Math.abs(fromX - toX) < radius * 2) {
        // Too close, just draw a simple line
        d = `M ${fromX} ${fromY} L ${toX} ${toY}`
      } else if (goingLeft) {
        // Fork is to the right of parent, curve back left
        d = `M ${fromX} ${fromY}
             L ${fromX} ${fromY + dropDistance - radius}
             Q ${fromX} ${fromY + dropDistance}, ${fromX - radius} ${fromY + dropDistance}
             L ${toX} ${fromY + dropDistance}`
      } else {
        // Fork is to the left of parent, curve back right
        d = `M ${fromX} ${fromY}
             L ${fromX} ${fromY + dropDistance - radius}
             Q ${fromX} ${fromY + dropDistance}, ${fromX + radius} ${fromY + dropDistance}
             L ${toX} ${fromY + dropDistance}`
      }
      break
    }

    default:
      d = `M ${fromX} ${fromY} L ${toX} ${toY}`
  }

  const baseStyle: React.CSSProperties = {
    stroke: color,
    strokeWidth,
    fill: 'none',
    strokeLinecap: 'round',
  }

  // Arrow marker definition - points right by default, orient="auto" rotates it
  const arrowMarker = (
    <defs>
      <marker
        id={markerId}
        markerWidth="6"
        markerHeight="6"
        refX="5"
        refY="3"
        orient="auto"
        markerUnits="strokeWidth"
      >
        <path
          d="M 0 0 L 6 3 L 0 6 Z"
          fill={color}
        />
      </marker>
    </defs>
  )

  if (animated) {
    return (
      <>
        <style>
          {`
            @keyframes dash-animation {
              to {
                stroke-dashoffset: -20;
              }
            }
          `}
        </style>
        {arrowMarker}
        <path
          d={d}
          style={{
            ...baseStyle,
            strokeDasharray: '5, 5',
            animation: 'dash-animation 0.5s linear infinite',
          }}
          markerEnd={`url(#${markerId})`}
        />
      </>
    )
  }

  return (
    <>
      {arrowMarker}
      <path d={d} style={baseStyle} markerEnd={`url(#${markerId})`} />
    </>
  )
}

export default ConnectionPath
