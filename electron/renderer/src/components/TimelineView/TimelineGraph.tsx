import React from 'react'
import type { TimelineLayout, LayoutConfig, DEFAULT_LAYOUT_CONFIG } from './types'
import TimelineNode from './TimelineNode'
import ConnectionPath from './ConnectionPath'

interface TimelineGraphProps {
  layout: TimelineLayout
  config: LayoutConfig
  selectedNodeId?: string
  onNodeClick?: (nodeId: string) => void
}

/**
 * SVG component that renders the timeline graph with nodes and connections
 */
export function TimelineGraph({
  layout,
  config,
  selectedNodeId,
  onNodeClick,
}: TimelineGraphProps) {
  const { nodes, connections } = layout
  const { nodeRadius } = config

  return (
    <svg
      width={layout.totalWidth}
      height={layout.totalHeight}
      style={{
        display: 'block',
        overflow: 'visible',
      }}
    >
      {/* Background grid (optional, subtle) */}
      <defs>
        <pattern
          id="grid"
          width={config.laneWidth}
          height={config.rowHeight}
          patternUnits="userSpaceOnUse"
        >
          <path
            d={`M ${config.laneWidth} 0 L 0 0 0 ${config.rowHeight}`}
            fill="none"
            stroke="rgba(255,255,255,0.03)"
            strokeWidth="1"
          />
        </pattern>
      </defs>

      {/* Connections layer (behind nodes) */}
      <g className="connections-layer">
        {connections.map((connection) => (
          <ConnectionPath
            key={connection.id}
            fromX={connection.fromX}
            fromY={connection.fromY}
            toX={connection.toX}
            toY={connection.toY}
            color={connection.color}
            type={connection.type}
            animated={connection.animated}
            strokeWidth={2}
          />
        ))}
      </g>

      {/* Nodes layer (on top) */}
      <g className="nodes-layer">
        {nodes.map((node) => {
          const isSelected = node.event.id === selectedNodeId ||
            node.event.branchId === selectedNodeId

          return (
            <TimelineNode
              key={node.event.id}
              nodeId={node.event.id}
              x={node.x}
              y={node.y}
              radius={nodeRadius}
              color={node.branch.color}
              type={node.event.type}
              isSelected={isSelected}
              isActive={node.branch.status === 'active'}
              onClick={() => onNodeClick?.(node.event.branchId)}
            />
          )
        })}
      </g>
    </svg>
  )
}

export default TimelineGraph
