import { Handle, Position } from 'reactflow'

interface CompactNodeProps {
  data: {
    label: string
    status: 'closed' | 'merged'
    claudeSessionId: string
    selected: boolean
  }
}

export function CompactNode({ data }: CompactNodeProps) {
  const borderColor = data.status === 'merged' ? '#94e2d5' : '#f38ba8'
  const bgColor = data.status === 'merged' ? 'rgba(148, 226, 213, 0.1)' : 'rgba(243, 139, 168, 0.1)'

  return (
    <div
      style={{
        width: '48px',
        height: '48px',
        borderRadius: '50%',
        border: `3px solid ${borderColor}`,
        background: data.selected ? bgColor : 'rgba(30, 30, 46, 0.95)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        backdropFilter: 'blur(10px)',
      }}
      title={`${data.label} (${data.status})`}
    >
      <Handle type="target" position={Position.Top} />
      <span
        style={{
          fontSize: '10px',
          fontWeight: 600,
          color: borderColor,
          textAlign: 'center',
        }}
      >
        {data.status === 'merged' ? 'M' : 'C'}
      </span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
