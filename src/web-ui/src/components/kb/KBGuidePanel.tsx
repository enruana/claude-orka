import { useState, useMemo } from 'react'
import {
  ChevronDown, ChevronRight, HelpCircle, CheckCircle,
  Calendar, Flag, User, Compass, GitBranch, FileText,
  BookOpen, Search, Circle, FolderKanban,
} from 'lucide-react'
import type { KBEntity } from '../../api/client'

const TYPE_ICONS: Record<string, typeof CheckCircle> = {
  decision: CheckCircle, question: HelpCircle, meeting: Calendar,
  milestone: Flag, person: User, direction: Compass,
  repo: GitBranch, artifact: FileText, context: BookOpen,
}

const TYPE_COLORS: Record<string, string> = {
  decision: '#a6e3a1', question: '#f9e2af', meeting: '#cba6f7',
  milestone: '#f5c2e7', person: '#89b4fa', direction: '#fab387',
  repo: '#89dceb', artifact: '#a6adc8', context: '#6c7086',
}

const STATUS_COLORS: Record<string, string> = {
  active: '#a6e3a1', resolved: '#89b4fa', superseded: '#6c7086',
  archived: '#585b70', draft: '#f9e2af',
}

interface Section {
  key: string
  label: string
  icon: typeof CheckCircle
  color: string
  filter: (e: KBEntity) => boolean
}

const SECTIONS: Section[] = [
  { key: 'projects', label: 'Projects', icon: FolderKanban, color: '#f38ba8', filter: (e) => e.type === 'project' },
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
  selectedId: string | null
  onSelect: (id: string) => void
}

export function KBGuidePanel({ entities, selectedId, onSelect }: KBGuidePanelProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState('')

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
