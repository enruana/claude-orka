import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Calendar, Circle, Plus, Pencil, Archive } from 'lucide-react'
import { api, type KBEvent, type KBEntity } from '../../api/client'

const TYPE_COLORS: Record<string, string> = {
  decision: '#a6e3a1', question: '#f9e2af', meeting: '#cba6f7',
  milestone: '#f5c2e7', person: '#89b4fa', direction: '#fab387',
  repo: '#89dceb', artifact: '#a6adc8', context: '#6c7086',
  project: '#f38ba8',
}

const TYPE_LABELS: Record<string, string> = {
  decision: 'Decision', question: 'Question', meeting: 'Meeting',
  milestone: 'Milestone', person: 'Person', direction: 'Direction',
  repo: 'Repo', artifact: 'Artifact', context: 'Context',
  project: 'Project',
}

const VISIBLE_EVENT_TYPES = new Set(['entity.created', 'entity.updated', 'entity.archived'])

interface DayGroup {
  date: string
  dayName: string    // "Mon"
  dayNum: string     // "21"
  events: KBEvent[]
  typeCounts: Map<string, number>
  isToday: boolean
}

interface WeekGroup {
  label: string
  days: DayGroup[]
}

function getWeekLabel(date: Date): string {
  const start = new Date(date)
  start.setDate(start.getDate() - start.getDay() + 1)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const fmt = (d: Date) => d.toLocaleDateString('en', { month: 'short', day: 'numeric' })
  return `${fmt(start)} – ${fmt(end)}`
}

function getWeekKey(date: Date): string {
  const d = new Date(date)
  d.setDate(d.getDate() - d.getDay() + 1)
  return d.toISOString().split('T')[0]
}

function getEntityType(event: KBEvent): string {
  return (event.data?.type as string) || ''
}

const todayStr = new Date().toISOString().split('T')[0]

interface KBTimelineProps {
  projectPath: string
  entities: KBEntity[]
  selectedId: string | null
  onSelectEntity: (id: string) => void
}

export function KBTimeline({ projectPath, entities, selectedId, onSelectEntity }: KBTimelineProps) {
  const [events, setEvents] = useState<KBEvent[]>([])
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getKBTimeline(projectPath).then(setEvents).catch(() => {})
  }, [projectPath])

  const weeks = useMemo(() => {
    const visible = events.filter(e => VISIBLE_EVENT_TYPES.has(e.type))
    if (visible.length === 0) return []

    const weekMap = new Map<string, Map<string, KBEvent[]>>()
    for (const event of visible) {
      const date = new Date(event.ts)
      const weekKey = getWeekKey(date)
      const dayKey = event.ts.split('T')[0]
      if (!weekMap.has(weekKey)) weekMap.set(weekKey, new Map())
      const dayMap = weekMap.get(weekKey)!
      if (!dayMap.has(dayKey)) dayMap.set(dayKey, [])
      dayMap.get(dayKey)!.push(event)
    }

    const result: WeekGroup[] = []
    for (const [, dayMap] of [...weekMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const days: DayGroup[] = []
      for (const [dateStr, dayEvents] of [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const date = new Date(dateStr + 'T00:00:00')
        const typeCounts = new Map<string, number>()
        for (const e of dayEvents) {
          const t = getEntityType(e)
          if (t) typeCounts.set(t, (typeCounts.get(t) || 0) + 1)
        }
        days.push({
          date: dateStr,
          dayName: date.toLocaleDateString('en', { weekday: 'short' }),
          dayNum: String(date.getDate()),
          events: dayEvents,
          typeCounts,
          isToday: dateStr === todayStr,
        })
      }
      const firstDate = new Date(days[0].date + 'T00:00:00')
      result.push({ label: getWeekLabel(firstDate), days })
    }
    return result
  }, [events])

  const dayEvents = useMemo(() => {
    if (!selectedDay) return []
    return events
      .filter(e => VISIBLE_EVENT_TYPES.has(e.type) && e.ts.startsWith(selectedDay))
      .sort((a, b) => a.ts.localeCompare(b.ts))
  }, [events, selectedDay])

  const entityMap = useMemo(() => {
    const map = new Map<string, KBEntity>()
    entities.forEach(e => map.set(e.id, e))
    return map
  }, [entities])

  const scrollLeft = useCallback(() => {
    scrollRef.current?.scrollBy({ left: -250, behavior: 'smooth' })
  }, [])
  const scrollRight = useCallback(() => {
    scrollRef.current?.scrollBy({ left: 250, behavior: 'smooth' })
  }, [])

  if (weeks.length === 0) return null

  // Max events in a day for scaling the activity bar
  const maxDayEvents = Math.max(...weeks.flatMap(w => w.days.map(d => d.events.length)), 1)

  return (
    <div className="kb-timeline">
      <div className="kb-timeline-bar">
        <button className="kb-timeline-arrow" onClick={scrollLeft}>
          <ChevronLeft size={14} />
        </button>

        <div className="kb-timeline-scroll" ref={scrollRef}>
          {weeks.map((week) => (
            <div key={week.label} className="kb-timeline-week">
              <div className="kb-timeline-week-label">{week.label}</div>
              <div className="kb-timeline-days">
                {week.days.map((day) => {
                  const isSelected = selectedDay === day.date
                  const intensity = Math.min(day.events.length / maxDayEvents, 1)
                  // Stack colored segments as a mini bar
                  const sortedTypes = [...day.typeCounts.entries()]
                    .sort(([,a], [,b]) => b - a)

                  return (
                    <button
                      key={day.date}
                      className={`kb-timeline-day ${isSelected ? 'selected' : ''} ${day.isToday ? 'today' : ''}`}
                      onClick={() => setSelectedDay(isSelected ? null : day.date)}
                      title={`${day.date}\n${sortedTypes.map(([t, c]) => `${c} ${t}`).join(', ')}`}
                    >
                      <span className="kb-timeline-day-name">{day.dayName}</span>
                      <span className="kb-timeline-day-num">{day.dayNum}</span>
                      <div className="kb-timeline-activity">
                        {sortedTypes.map(([type, count]) => (
                          <div
                            key={type}
                            className="kb-timeline-segment"
                            style={{
                              background: TYPE_COLORS[type] || '#6c7086',
                              flex: count,
                              opacity: 0.6 + intensity * 0.4,
                            }}
                          />
                        ))}
                      </div>
                      <span className="kb-timeline-day-count">{day.events.length}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <button className="kb-timeline-arrow" onClick={scrollRight}>
          <ChevronRight size={14} />
        </button>
      </div>

      {selectedDay && dayEvents.length > 0 && (
        <div className="kb-timeline-detail">
          <div className="kb-timeline-detail-header">
            <Calendar size={13} />
            <span>{new Date(selectedDay + 'T00:00:00').toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span>
            <span className="kb-timeline-detail-count">{dayEvents.length} events</span>
          </div>
          <div className="kb-timeline-detail-events">
            {dayEvents.map((event) => {
              const entity = event.entityId ? entityMap.get(event.entityId) : null
              const entityType = getEntityType(event)
              const color = TYPE_COLORS[entityType] || '#6c7086'
              const time = event.ts.split('T')[1]?.slice(0, 5) || ''
              const isEntitySelected = event.entityId === selectedId

              const ActionIcon = event.type === 'entity.created' ? Plus
                : event.type === 'entity.updated' ? Pencil : Archive

              const actionLabel = event.type === 'entity.created' ? 'New'
                : event.type === 'entity.updated' ? 'Updated' : 'Archived'

              return (
                <button
                  key={event.id}
                  className={`kb-timeline-event ${isEntitySelected ? 'selected' : ''}`}
                  onClick={() => event.entityId && onSelectEntity(event.entityId)}
                >
                  <span className="kb-timeline-event-time">{time}</span>
                  <div className="kb-timeline-event-badge" style={{ background: `${color}20`, color }}>
                    <ActionIcon size={9} />
                    <span>{actionLabel}</span>
                  </div>
                  <span className="kb-timeline-event-type-label" style={{ color }}>
                    {TYPE_LABELS[entityType] || entityType}
                  </span>
                  <span className="kb-timeline-event-title">
                    {entity?.title || event.entityId}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
