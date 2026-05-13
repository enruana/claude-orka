import { useState, useMemo } from 'react'
import {
  ChevronDown, ChevronRight, HelpCircle, CheckCircle,
  Calendar, Flag, User, Compass, GitBranch, FileText,
  BookOpen, Search, Circle, FolderKanban, X,
  Target, Layers, ListChecks, Lightbulb, Bug, Activity,
} from 'lucide-react'
import type { KBEntity } from '../../api/client'

const TYPE_ICONS: Record<string, typeof CheckCircle> = {
  // Knowledge tier
  decision: CheckCircle, question: HelpCircle, meeting: Calendar,
  milestone: Flag, direction: Compass,
  // Work tier (v2)
  goal: Target, initiative: Layers, project: FolderKanban,
  task: ListChecks, spike: Lightbulb, bug: Bug,
  // Reference tier
  person: User, repo: GitBranch, artifact: FileText, context: BookOpen,
  // Provenance
  activity: Activity,
}

const TYPE_COLORS: Record<string, string> = {
  // Knowledge tier
  decision: '#a6e3a1', question: '#f9e2af', meeting: '#cba6f7',
  milestone: '#f5c2e7', direction: '#fab387',
  // Work tier (v2)
  goal: '#f38ba8', initiative: '#eba0ac', project: '#f38ba8',
  task: '#94e2d5', spike: '#eed49f', bug: '#ed8796',
  // Reference tier
  person: '#89b4fa', repo: '#89dceb', artifact: '#a6adc8', context: '#6c7086',
  // Provenance tier
  activity: '#7f849c',
}

const STATUS_COLORS: Record<string, string> = {
  // v1 + shared
  active: '#a6e3a1', 'in-progress': '#89b4fa', blocked: '#f38ba8',
  pending: '#f9e2af', review: '#cba6f7', draft: '#6c7086',
  resolved: '#585b70', superseded: '#585b70', archived: '#45475a',
  // v2 — work tier
  planning: '#f9e2af', todo: '#6c7086', done: '#585b70', cancelled: '#45475a',
  // v2 — spike
  open: '#a6e3a1', concluded: '#585b70',
  // v2 — bug
  investigating: '#89b4fa', fixed: '#a6e3a1', wontfix: '#45475a', duplicate: '#6c7086',
  // v2 — question / meeting / milestone
  answered: '#a6e3a1', closed: '#585b70',
  scheduled: '#f9e2af', held: '#a6e3a1',
  reached: '#a6e3a1',
}

// Status groups — ordered from most-prominent (alive/active work) to least (done).
// Items within each section are rendered under these mini-headers.
type StatusGroupKey = 'active' | 'inProgress' | 'pending' | 'done'

const STATUS_GROUPS: Array<{ key: StatusGroupKey; label: string; statuses: string[] }> = [
  // Live/active work — visually prominent
  { key: 'active', label: 'Active',
    statuses: ['active', 'open', 'investigating', 'scheduled', 'planning'] },
  // Work in motion
  { key: 'inProgress', label: 'In Progress',
    statuses: ['in-progress', 'review', 'draft', 'todo'] },
  // Waiting / on hold
  { key: 'pending', label: 'Pending',
    statuses: ['pending', 'blocked', 'held'] },
  // Terminal states — dimmed
  { key: 'done', label: 'Done',
    statuses: ['done', 'resolved', 'fixed', 'answered', 'closed', 'concluded',
               'reached', 'archived', 'cancelled', 'wontfix', 'duplicate', 'superseded'] },
]

const STATUS_TO_GROUP: Record<string, StatusGroupKey> = (() => {
  const map: Record<string, StatusGroupKey> = {}
  for (const g of STATUS_GROUPS) {
    for (const s of g.statuses) map[s] = g.key
  }
  return map
})()

function groupByStatus(entities: KBEntity[]): Record<StatusGroupKey, KBEntity[]> {
  const groups: Record<StatusGroupKey, KBEntity[]> = {
    active: [], inProgress: [], pending: [], done: [],
  }
  for (const e of entities) {
    const bucket = STATUS_TO_GROUP[e.status] || 'active' // unknown statuses → treat as active
    groups[bucket].push(e)
  }
  return groups
}

interface Section {
  key: string
  label: string
  icon: typeof CheckCircle
  color: string
  filter: (e: KBEntity) => boolean
  // If true, ignore the project filter and always source from allEntities
  unscopedByProject?: boolean
}

const SECTIONS: Section[] = [
  // Active work — what needs attention now
  { key: 'tasks', label: 'Tasks', icon: ListChecks, color: '#94e2d5',
    filter: (e) => e.type === 'task' },
  { key: 'spikes', label: 'Spikes', icon: Lightbulb, color: '#eed49f',
    filter: (e) => e.type === 'spike' },
  { key: 'bugs', label: 'Bugs', icon: Bug, color: '#ed8796',
    filter: (e) => e.type === 'bug' },
  { key: 'projects', label: 'Projects', icon: FolderKanban, color: '#f38ba8',
    filter: (e) => e.type === 'project', unscopedByProject: true },
  // Knowledge
  { key: 'questions', label: 'Questions', icon: HelpCircle, color: '#f9e2af',
    filter: (e) => e.type === 'question' },
  { key: 'decisions', label: 'Decisions', icon: CheckCircle, color: '#a6e3a1', filter: (e) => e.type === 'decision' },
  { key: 'milestones', label: 'Milestones', icon: Flag, color: '#f5c2e7', filter: (e) => e.type === 'milestone' },
  { key: 'meetings', label: 'Meetings', icon: Calendar, color: '#cba6f7', filter: (e) => e.type === 'meeting' },
  // Strategic
  { key: 'goals', label: 'Goals', icon: Target, color: '#f38ba8', filter: (e) => e.type === 'goal' },
  { key: 'initiatives', label: 'Initiatives', icon: Layers, color: '#eba0ac', filter: (e) => e.type === 'initiative' },
  { key: 'directions', label: 'Directions', icon: Compass, color: '#fab387', filter: (e) => e.type === 'direction' },
  // Reference
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState('')

  const selectedProject = useMemo(() =>
    selectedProjectId ? allEntities.find(e => e.id === selectedProjectId && e.type === 'project') : null
  , [selectedProjectId, allEntities])

  const filterBySearch = (list: KBEntity[]) => {
    if (!search) return list
    const q = search.toLowerCase()
    return list.filter((e) =>
      e.title.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)
    )
  }

  const filteredEntities = useMemo(() => filterBySearch(entities), [entities, search])
  const filteredAllEntities = useMemo(() => filterBySearch(allEntities), [allEntities, search])

  const toggleSection = (key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const handleItemClick = (entity: KBEntity) => {
    onSelect(entity.id)
    if (entity.type === 'project') {
      // Toggle: clicking already-selected project clears the filter
      if (selectedProjectId === entity.id) {
        onSelectProject(null)
      } else {
        onSelectProject(entity.id)
      }
    }
  }

  return (
    <div className="kb-guide">
      <div className="kb-guide-header">
        <h3>Knowledge Base</h3>
        <span className="kb-guide-count">{entities.length} entities</span>
      </div>

      {/* Active project filter chip — shown only when filtering */}
      {selectedProject && (
        <div className="kb-guide-filter-chip">
          <Circle size={6} fill={STATUS_COLORS[selectedProject.status] || '#a6e3a1'} stroke="none" />
          <span className="kb-guide-filter-chip-label">
            <span className="kb-guide-filter-chip-prefix">Filter:</span>
            <span className="kb-guide-filter-chip-name">{selectedProject.title}</span>
          </span>
          <button
            className="kb-guide-filter-chip-clear"
            onClick={() => onSelectProject(null)}
            title="Clear filter"
          >
            <X size={11} />
          </button>
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
          // Projects section ignores the project filter so users can always
          // switch projects from here. Other sections respect the filter.
          const source = section.unscopedByProject ? filteredAllEntities : filteredEntities
          const items = source.filter(section.filter)
          if (items.length === 0) return null

          // When the user is searching, auto-expand sections so results are visible.
          const isExpanded = search ? true : !!expanded[section.key]
          const SectionIcon = section.icon

          return (
            <div key={section.key} className="kb-guide-section">
              <button
                className="kb-guide-section-header"
                onClick={() => toggleSection(section.key)}
              >
                <div className="kb-guide-section-left">
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <SectionIcon size={13} style={{ color: section.color }} />
                  <span>{section.label}</span>
                </div>
                <span className="kb-guide-section-count" style={{ color: section.color }}>
                  {items.length}
                </span>
              </button>

              {isExpanded && (
                <div className="kb-guide-items">
                  {STATUS_GROUPS.map((group) => {
                    const groupItems = groupByStatus(items)[group.key]
                    if (groupItems.length === 0) return null

                    return (
                      <div key={group.key} className={`kb-guide-status-group kb-guide-status-group-${group.key}`}>
                        <div className="kb-guide-status-group-header">
                          <span className="kb-guide-status-group-label">{group.label}</span>
                          <span className="kb-guide-status-group-count">{groupItems.length}</span>
                        </div>
                        {groupItems.map((entity) => {
                          const isSelected = selectedId === entity.id
                          const isFilterProject = entity.type === 'project' && selectedProjectId === entity.id
                          const statusColor = STATUS_COLORS[entity.status] || '#585b70'

                          return (
                            <button
                              key={entity.id}
                              className={`kb-guide-item ${isSelected ? 'selected' : ''} ${isFilterProject ? 'is-filter' : ''}`}
                              onClick={() => handleItemClick(entity)}
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
