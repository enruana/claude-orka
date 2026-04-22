import { useState, useMemo } from 'react'
import {
  ChevronDown, ChevronRight, HelpCircle, CheckCircle,
  Calendar, Flag, User, Compass, GitBranch, FileText,
  BookOpen, Search, Circle, FolderKanban, X, Archive,
} from 'lucide-react'
import type { KBEntity } from '../../api/client'

const TYPE_ICONS: Record<string, typeof CheckCircle> = {
  decision: CheckCircle, question: HelpCircle, meeting: Calendar,
  milestone: Flag, person: User, direction: Compass,
  repo: GitBranch, artifact: FileText, context: BookOpen,
  project: FolderKanban,
}

const TYPE_COLORS: Record<string, string> = {
  decision: '#a6e3a1', question: '#f9e2af', meeting: '#cba6f7',
  milestone: '#f5c2e7', person: '#89b4fa', direction: '#fab387',
  repo: '#89dceb', artifact: '#a6adc8', context: '#6c7086',
  project: '#f38ba8',
}

const STATUS_COLORS: Record<string, string> = {
  active: '#a6e3a1', 'in-progress': '#89b4fa', blocked: '#f38ba8',
  pending: '#f9e2af', review: '#cba6f7', draft: '#6c7086',
  resolved: '#585b70', superseded: '#585b70', archived: '#45475a',
}

const PROJECT_STATUS_LABELS: Record<string, string> = {
  active: 'Active', 'in-progress': 'In Progress', blocked: 'Blocked',
  pending: 'Pending', review: 'In Review', draft: 'Draft',
  resolved: 'Done', archived: 'Archived',
}

interface Section {
  key: string
  label: string
  icon: typeof CheckCircle
  color: string
  filter: (e: KBEntity) => boolean
}

const SECTIONS: Section[] = [
  { key: 'questions', label: 'Open Questions', icon: HelpCircle, color: '#f9e2af', filter: (e) => e.type === 'question' && e.status === 'active' },
  { key: 'decisions', label: 'Decisions', icon: CheckCircle, color: '#a6e3a1', filter: (e) => e.type === 'decision' },
  { key: 'milestones', label: 'Milestones', icon: Flag, color: '#f5c2e7', filter: (e) => e.type === 'milestone' },
  { key: 'meetings', label: 'Meetings', icon: Calendar, color: '#cba6f7', filter: (e) => e.type === 'meeting' },
  { key: 'directions', label: 'Directions', icon: Compass, color: '#fab387', filter: (e) => e.type === 'direction' },
  { key: 'people', label: 'People', icon: User, color: '#89b4fa', filter: (e) => e.type === 'person' },
  { key: 'repos', label: 'Repositories', icon: GitBranch, color: '#89dceb', filter: (e) => e.type === 'repo' },
  { key: 'artifacts', label: 'Artifacts', icon: FileText, color: '#a6adc8', filter: (e) => e.type === 'artifact' },
  { key: 'context', label: 'Context', icon: BookOpen, color: '#6c7086', filter: (e) => e.type === 'context' },
]

interface KBGuidePanelProps {
  entities: KBEntity[]
  allEntities: KBEntity[]
  selectedId: string | null
  selectedProjectId: string | null
  onSelect: (id: string) => void
  onSelectProject: (id: string | null) => void
}

export function KBGuidePanel({ entities, allEntities, selectedId, selectedProjectId, onSelect, onSelectProject }: KBGuidePanelProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const projects = useMemo(() => allEntities.filter(e => e.type === 'project'), [allEntities])
  const activeProjects = useMemo(() => projects.filter(p => p.status !== 'archived'), [projects])
  const archivedProjects = useMemo(() => projects.filter(p => p.status === 'archived'), [projects])

  const selectedProject = useMemo(() =>
    selectedProjectId ? projects.find(p => p.id === selectedProjectId) : null
  , [selectedProjectId, projects])

  const filteredEntities = useMemo(() => {
    if (!search) return entities
    const q = search.toLowerCase()
    return entities.filter((e) =>
      e.title.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)
    )
  }, [entities, search])

  const toggleSection = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="kb-guide">
      <div className="kb-guide-header">
        <h3>Knowledge Base</h3>
        <span className="kb-guide-count">{entities.length} entities</span>
      </div>

      {/* Project selector */}
      {projects.length > 0 && (
        <div className="kb-guide-project-selector">
          <div className="kb-guide-project-label">
            <FolderKanban size={11} />
            <span>Project</span>
          </div>

          {selectedProject ? (
            <div className="kb-guide-project-active">
              <button
                className="kb-guide-project-current"
                onClick={() => { onSelectProject(selectedProject.id); onSelect(selectedProject.id) }}
              >
                <Circle size={6} fill={STATUS_COLORS[selectedProject.status] || '#a6e3a1'} stroke="none" />
                <span className="kb-guide-project-name">{selectedProject.title}</span>
                <span className="kb-guide-project-status">{PROJECT_STATUS_LABELS[selectedProject.status] || selectedProject.status}</span>
              </button>
              <button className="kb-guide-project-clear" onClick={() => onSelectProject(null)} title="Show all">
                <X size={12} />
              </button>
            </div>
          ) : (
            <div className="kb-guide-project-list">
              {activeProjects.map(p => (
                <button
                  key={p.id}
                  className="kb-guide-project-item"
                  onClick={() => { onSelectProject(p.id); onSelect(p.id) }}
                >
                  <Circle size={6} fill={STATUS_COLORS[p.status] || '#a6e3a1'} stroke="none" />
                  <span>{p.title}</span>
                  <span className="kb-guide-project-status">{PROJECT_STATUS_LABELS[p.status] || p.status}</span>
                </button>
              ))}
              {archivedProjects.length > 0 && (
                <button
                  className="kb-guide-project-archived-toggle"
                  onClick={() => setShowArchived(!showArchived)}
                >
                  <Archive size={10} />
                  <span>{archivedProjects.length} archived</span>
                  {showArchived ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                </button>
              )}
              {showArchived && archivedProjects.map(p => (
                <button
                  key={p.id}
                  className="kb-guide-project-item archived"
                  onClick={() => { onSelectProject(p.id); onSelect(p.id) }}
                >
                  <Circle size={6} fill="#45475a" stroke="none" />
                  <span>{p.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="kb-guide-search">
        <Search size={12} />
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="kb-guide-sections">
        {SECTIONS.map((section) => {
          const items = filteredEntities.filter(section.filter)
          if (items.length === 0) return null

          const isCollapsed = collapsed[section.key]
          const SectionIcon = section.icon

          return (
            <div key={section.key} className="kb-guide-section">
              <button
                className="kb-guide-section-header"
                onClick={() => toggleSection(section.key)}
              >
                <div className="kb-guide-section-left">
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <SectionIcon size={13} style={{ color: section.color }} />
                  <span>{section.label}</span>
                </div>
                <span className="kb-guide-section-count" style={{ color: section.color }}>
                  {items.length}
                </span>
              </button>

              {!isCollapsed && (
                <div className="kb-guide-items">
                  {items.map((entity) => {
                    const isSelected = selectedId === entity.id
                    const statusColor = STATUS_COLORS[entity.status] || '#585b70'

                    return (
                      <button
                        key={entity.id}
                        className={`kb-guide-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => onSelect(entity.id)}
                        style={isSelected ? { borderLeftColor: section.color } : undefined}
                      >
                        <div className="kb-guide-item-title">
                          <Circle size={5} fill={statusColor} stroke="none" />
                          <span>{entity.title}</span>
                        </div>
                        {entity.tags.length > 0 && (
                          <div className="kb-guide-item-tags">
                            {entity.tags.slice(0, 3).map((tag) => (
                              <span key={tag}>#{tag}</span>
                            ))}
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
