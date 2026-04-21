import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { KBEntity } from '../../api/client'

// Timeline entities are prominent (colored + larger)
const TIMELINE_TYPES = new Set(['meeting', 'milestone', 'decision', 'direction', 'project'])

const TYPE_COLORS: Record<string, string> = {
  decision:  '#a6e3a1',
  question:  '#f9e2af',
  person:    '#89b4fa',
  meeting:   '#cba6f7',
  direction: '#fab387',
  repo:      '#89dceb',
  artifact:  '#a6adc8',
  milestone: '#f5c2e7',
  context:   '#6c7086',
  project:   '#f38ba8',
}

interface KBEntityNodeProps {
  data: {
    entity: KBEntity
    selected: boolean
    dimmed?: boolean
  }
}

function KBEntityNodeComponent({ data }: KBEntityNodeProps) {
  const { entity, selected, dimmed } = data
  const color = TYPE_COLORS[entity.type] || '#6c7086'
  const isTimeline = TIMELINE_TYPES.has(entity.type)
  const size = isTimeline ? 60 : 36
  const fontSize = isTimeline ? 10 : 8
  const label = entity.title.length > (isTimeline ? 18 : 12)
    ? entity.title.slice(0, isTimeline ? 18 : 12) + '...'
    : entity.title

  return (
    <>
      <Handle type="target" position={Position.Left} className="kb-handle-circle" />
      <div
        className={`kb-circle-node ${selected ? 'selected' : ''} ${isTimeline ? 'timeline' : 'secondary'} ${dimmed ? 'dimmed' : ''}`}
        style={{
          width: size,
          height: size,
          background: isTimeline
            ? color
            : `${color}30`,
          borderColor: selected ? '#fff' : `${color}90`,
          boxShadow: selected
            ? `0 0 24px ${color}88, 0 0 48px ${color}44`
            : isTimeline
              ? `0 0 16px ${color}55, 0 0 32px ${color}22`
              : `0 0 8px ${color}22`,
        }}
      >
        {isTimeline && (
          <span className="kb-circle-label" style={{ fontSize }}>
            {label}
          </span>
        )}
      </div>
      {/* Title below node */}
      <div
        className="kb-circle-title"
        style={{
          maxWidth: isTimeline ? 110 : 80,
          fontSize: isTimeline ? 10 : 9,
          color: isTimeline ? '#cdd6f4' : `${color}cc`,
        }}
      >
        {!isTimeline && label}
      </div>
      <Handle type="source" position={Position.Right} className="kb-handle-circle" />
    </>
  )
}

export const KBEntityNode = memo(KBEntityNodeComponent)
