/**
 * ConnectionEdge - Custom edge with disconnect button
 */

import { BaseEdge, getBezierPath, EdgeLabelRenderer } from '@xyflow/react'
import { X } from 'lucide-react'

interface ConnectionEdgeData {
  onDisconnect?: (agentId: string) => void
  agentId?: string
  isActive?: boolean
}

interface ConnectionEdgeProps {
  id: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourcePosition: any
  targetPosition: any
  style?: Record<string, any>
  markerEnd?: string
  data?: ConnectionEdgeData
}

export function ConnectionEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data,
}: ConnectionEdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  const handleDisconnect = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (data?.agentId && data?.onDisconnect) {
      data.onDisconnect(data.agentId)
    }
  }

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          strokeWidth: 2,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
        >
          <button
            onClick={handleDisconnect}
            style={{
              width: '20px',
              height: '20px',
              borderRadius: '50%',
              background: '#1e1e2e',
              border: '2px solid #f38ba8',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#f38ba8'
              e.currentTarget.style.transform = 'scale(1.2)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#1e1e2e'
              e.currentTarget.style.transform = 'scale(1)'
            }}
            title="Disconnect"
          >
            <X size={12} color="#f38ba8" style={{ transition: 'color 0.2s' }} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
