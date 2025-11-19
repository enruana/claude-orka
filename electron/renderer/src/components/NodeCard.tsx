import { Handle, Position } from 'reactflow'
import { Circle, CheckCircle, PlayCircle } from 'lucide-react'

interface NodeCardProps {
  data: {
    label: string
    status: string
    claudeSessionId?: string
    selected: boolean
  }
}

export function NodeCard({ data }: NodeCardProps) {
  const getStatusIcon = () => {
    switch (data.status) {
      case 'active':
        return <PlayCircle className="status-icon active" size={16} />
      case 'saved':
        return <CheckCircle className="status-icon saved" size={16} />
      default:
        return <Circle className="status-icon" size={16} />
    }
  }

  const getStatusColor = () => {
    switch (data.status) {
      case 'active':
        return 'active'
      case 'saved':
        return 'saved'
      case 'merged':
        return 'merged'
      default:
        return ''
    }
  }

  return (
    <div className={`node-card ${data.selected ? 'selected' : ''} ${getStatusColor()}`}>
      <Handle type="target" position={Position.Top} className="node-handle" />

      <div className="node-header">
        {getStatusIcon()}
        <span className="node-label">{data.label}</span>
      </div>

      {data.claudeSessionId && (
        <div className="node-id">
          {data.claudeSessionId.slice(0, 8)}...
        </div>
      )}

      <div className="node-status-badge">
        {data.status}
      </div>

      <Handle type="source" position={Position.Bottom} className="node-handle" />
    </div>
  )
}
