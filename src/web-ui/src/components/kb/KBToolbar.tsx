import { Search, Maximize, LayoutGrid } from 'lucide-react'

const ENTITY_TYPES = [
  { value: '', label: 'All Types' },
  { value: 'decision', label: 'Decisions' },
  { value: 'question', label: 'Questions' },
  { value: 'person', label: 'People' },
  { value: 'meeting', label: 'Meetings' },
  { value: 'direction', label: 'Directions' },
  { value: 'repo', label: 'Repos' },
  { value: 'artifact', label: 'Artifacts' },
  { value: 'milestone', label: 'Milestones' },
  { value: 'context', label: 'Context' },
]

const STATUS_OPTIONS = [
  { value: '', label: 'All Status' },
  { value: 'active', label: 'Active' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'archived', label: 'Archived' },
  { value: 'superseded', label: 'Superseded' },
]

interface KBToolbarProps {
  typeFilter: string
  statusFilter: string
  searchQuery: string
  entityCount: number
  edgeCount: number
  onTypeChange: (type: string) => void
  onStatusChange: (status: string) => void
  onSearchChange: (query: string) => void
  onFitView: () => void
  onAutoLayout: () => void
}

export function KBToolbar({
  typeFilter, statusFilter, searchQuery,
  entityCount, edgeCount,
  onTypeChange, onStatusChange, onSearchChange,
  onFitView, onAutoLayout,
}: KBToolbarProps) {
  return (
    <div className="kb-toolbar">
      <div className="kb-toolbar-filters">
        <select
          className="kb-toolbar-select"
          value={typeFilter}
          onChange={(e) => onTypeChange(e.target.value)}
        >
          {ENTITY_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>

        <select
          className="kb-toolbar-select"
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value)}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>

        <div className="kb-toolbar-search">
          <Search size={13} />
          <input
            type="text"
            placeholder="Search entities..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      </div>

      <div className="kb-toolbar-right">
        <span className="kb-toolbar-stats">
          {entityCount} entities | {edgeCount} edges
        </span>
        <button className="kb-toolbar-btn" onClick={onAutoLayout} title="Auto layout">
          <LayoutGrid size={14} />
        </button>
        <button className="kb-toolbar-btn" onClick={onFitView} title="Fit view">
          <Maximize size={14} />
        </button>
      </div>
    </div>
  )
}
