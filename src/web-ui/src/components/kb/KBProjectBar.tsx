import { useState } from 'react'
import { FolderOpen, Archive, Layers, Circle } from 'lucide-react'
import type { KBEntity } from '../../api/client'

const STATUS_CONFIG: Record<string, { color: string; label: string; order: number }> = {
  active:    { color: '#a6e3a1', label: 'Active',    order: 0 },
  'in-progress': { color: '#89b4fa', label: 'In Progress', order: 1 },
  blocked:   { color: '#f38ba8', label: 'Blocked',   order: 2 },
  pending:   { color: '#f9e2af', label: 'Pending',   order: 3 },
  review:    { color: '#cba6f7', label: 'In Review',  order: 4 },
  draft:     { color: '#6c7086', label: 'Draft',     order: 5 },
  resolved:  { color: '#585b70', label: 'Done',      order: 6 },
  archived:  { color: '#45475a', label: 'Archived',  order: 7 },
}

function getStatusConfig(status: string) {
  return STATUS_CONFIG[status] || STATUS_CONFIG.active
}

interface KBProjectBarProps {
  projects: KBEntity[]
  selectedProjectId: string | null
  onSelectProject: (id: string | null) => void
}

export function KBProjectBar({ projects, selectedProjectId, onSelectProject }: KBProjectBarProps) {
  const [showArchived, setShowArchived] = useState(false)

  const live = projects
    .filter(p => p.status !== 'archived')
    .sort((a, b) => getStatusConfig(a.status).order - getStatusConfig(b.status).order)
  const archived = projects.filter(p => p.status === 'archived')

  if (projects.length === 0) return null

  return (
    <div className="kb-project-bar">
      <div className="kb-project-bar-label">
        <FolderOpen size={12} />
        <span>Projects</span>
      </div>

      <div className="kb-project-pills">
        <button
          className={`kb-project-pill ${selectedProjectId === null ? 'active' : ''}`}
          onClick={() => onSelectProject(null)}
        >
          <Layers size={11} />
          All
        </button>

        {live.map(p => {
          const cfg = getStatusConfig(p.status)
          return (
            <button
              key={p.id}
              className={`kb-project-pill ${selectedProjectId === p.id ? 'active' : ''}`}
              onClick={() => onSelectProject(selectedProjectId === p.id ? null : p.id)}
              title={`${cfg.label}${p.properties.description ? ' — ' + p.properties.description : ''}`}
            >
              <Circle size={6} fill={cfg.color} stroke="none" />
              {p.title}
            </button>
          )
        })}

        {archived.length > 0 && (
          <button
            className={`kb-project-pill toggle-archived ${showArchived ? 'on' : ''}`}
            onClick={() => setShowArchived(!showArchived)}
          >
            <Archive size={10} />
            {archived.length} archived
          </button>
        )}

        {showArchived && archived.map(p => (
          <button
            key={p.id}
            className={`kb-project-pill archived ${selectedProjectId === p.id ? 'active' : ''}`}
            onClick={() => onSelectProject(selectedProjectId === p.id ? null : p.id)}
          >
            <Circle size={6} fill="#45475a" stroke="none" />
            {p.title}
          </button>
        ))}
      </div>
    </div>
  )
}
