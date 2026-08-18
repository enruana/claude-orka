import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Beaker, FileText, Palette, Search, MoreHorizontal, Sparkles, ExternalLink } from 'lucide-react'
import { api, type BoardLocalTaskType, type KBEntity } from '../../api/client'

/**
 * Modal for creating a local (non-Jira) board task.
 *
 * Two flavors:
 *
 *  - **New** — from scratch. Title + description + taskType. Auto-key
 *    is generated (`LOCAL-<nanoid>`). When the user moves it to In
 *    Progress, the init skill runs its local branch (no Jira, no PR
 *    setup) and creates a KB entity for it.
 *
 *  - **Port from KB** — pick an existing KB entity (project / task /
 *    meeting / spike / decision / …). Its title + summary prefill the
 *    task, and its id is stored on the BoardTask as `kbEntityId`. When
 *    the user moves the task to In Progress, the init skill's Step 1
 *    resumes that entity in place — no duplicate creation, all docs +
 *    decisions + links carry over.
 *
 * Priority / labels are edited later via the normal task modal.
 */

interface Props {
  boardName: string
  projectPath: string
  /** Real columns of the parent board. The dialog shows a chip picker
   *  so the user chooses where the new card lands. Server rejects any
   *  status not in this list — no point offering `'todo'` on a board
   *  whose columns are `backlog / open / in-progress / review / done`.
   */
  columns: string[]
  onSave: (input: {
    title: string
    description?: string
    taskType: BoardLocalTaskType
    status: string
    kbEntityId?: string
  }) => Promise<void> | void
  onClose: () => void
}

interface TypeOption {
  value: BoardLocalTaskType
  label: string
  hint: string
  icon: React.ReactNode
}

const TYPE_OPTIONS: TypeOption[] = [
  {
    value: 'research',
    label: 'Research',
    hint: 'Deep dive into an area of the codebase or a topic — outcome is a doc + KB decisions.',
    icon: <Search size={14} />,
  },
  {
    value: 'document',
    label: 'Document',
    hint: 'Produce a doc — meeting notes, runbook, migration guide, README.',
    icon: <FileText size={14} />,
  },
  {
    value: 'design',
    label: 'Design doc',
    hint: 'TDR / PRD / architecture proposal — outcome is a versioned doc + decisions.',
    icon: <Palette size={14} />,
  },
  {
    value: 'spike',
    label: 'Spike',
    hint: 'Timeboxed exploration to answer a specific question, may produce a prototype.',
    icon: <Beaker size={14} />,
  },
  {
    value: 'other',
    label: 'Other',
    hint: 'Any other internal task.',
    icon: <MoreHorizontal size={14} />,
  },
]

/**
 * Map a KB entity type to a sensible default `taskType`. Most work
 * items map cleanly; anything else falls to `other`.
 */
function defaultTaskTypeForEntity(entityType: string): BoardLocalTaskType {
  switch (entityType) {
    case 'spike': return 'spike'
    case 'decision': return 'design'
    case 'meeting': return 'document'
    case 'question': return 'research'
    case 'project':
    case 'initiative':
    case 'goal':
    case 'task':
    case 'bug': return 'other'
    default: return 'other'
  }
}

type Mode = 'new' | 'port'

/**
 * Pick a sensible default column: prefer the first "backlog-like"
 * status if the board has one, otherwise fall back to the first column.
 * Keeps the picker useful even on custom boards.
 */
function defaultStatus(columns: string[]): string {
  const preferred = ['backlog', 'todo', 'to-do', 'open', 'new']
  const lower = columns.map((c) => c.toLowerCase())
  for (const p of preferred) {
    const idx = lower.indexOf(p)
    if (idx >= 0) return columns[idx]
  }
  return columns[0] ?? 'backlog'
}

export function AddLocalTaskDialog({ boardName, projectPath, columns, onSave, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('new')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [taskType, setTaskType] = useState<BoardLocalTaskType>('research')
  const [status, setStatus] = useState<string>(() => defaultStatus(columns))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  // KB port state
  const [kbEntities, setKbEntities] = useState<KBEntity[]>([])
  const [kbLoading, setKbLoading] = useState(false)
  const [kbError, setKbError] = useState<string | null>(null)
  const [kbSearch, setKbSearch] = useState('')
  const [kbPicked, setKbPicked] = useState<KBEntity | null>(null)

  // Focus title on open — mirrors GH's "New issue" dialog.
  useEffect(() => {
    if (mode === 'new') setTimeout(() => titleRef.current?.focus(), 30)
  }, [mode])

  // Esc closes only if we're not saving mid-flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saving, onClose])

  // Lazy-load KB entities the first time the user switches to "port" mode.
  // Keeps the "New" flow fast (no KB fetch cost when the user doesn't
  // need it). Filters to work-tier + meeting types — those are the ones
  // that make sense to track like tickets.
  useEffect(() => {
    if (mode !== 'port' || kbEntities.length > 0 || kbLoading) return
    setKbLoading(true)
    setKbError(null)
    ;(async () => {
      try {
        const all = await api.getKBEntities(projectPath)
        const workLike = new Set([
          'task', 'project', 'initiative', 'spike', 'bug',
          'meeting', 'decision', 'question', 'goal',
        ])
        const filtered = all
          .filter((e) => workLike.has(String(e.type)))
          // Newest first — kb entities carry updatedAt / createdAt.
          .sort((a, b) => {
            const ta = (a as any).updatedAt || (a as any).createdAt || ''
            const tb = (b as any).updatedAt || (b as any).createdAt || ''
            return String(tb).localeCompare(String(ta))
          })
        setKbEntities(filtered)
      } catch (err: any) {
        setKbError(err?.message || 'Failed to load KB entities')
      } finally {
        setKbLoading(false)
      }
    })()
  }, [mode, projectPath, kbEntities.length, kbLoading])

  // Client-side filter over the loaded entities.
  const filteredKb = useMemo(() => {
    if (!kbSearch.trim()) return kbEntities
    const q = kbSearch.toLowerCase()
    return kbEntities.filter((e) => {
      const title = String((e as any).title || '').toLowerCase()
      const type = String(e.type || '').toLowerCase()
      const id = String(e.id || '').toLowerCase()
      return title.includes(q) || type.includes(q) || id.includes(q)
    })
  }, [kbEntities, kbSearch])

  // When the user picks a KB entity, seed the task fields from it. Title
  // is required; description is best-effort (pull the entity's summary
  // property or fall back to a short "Ported from ..." line).
  useEffect(() => {
    if (!kbPicked) return
    const pTitle = String((kbPicked as any).title || '').trim()
    const pSummary = String(
      (kbPicked as any).properties?.summary
      || (kbPicked as any).properties?.description
      || (kbPicked as any).summary
      || ''
    ).trim()
    setTitle(pTitle || `Work on ${kbPicked.id}`)
    setDescription(pSummary || `Ported from KB entity ${kbPicked.id} (${kbPicked.type}).`)
    setTaskType(defaultTaskTypeForEntity(String(kbPicked.type)))
  }, [kbPicked])

  const handleSave = async () => {
    const t = title.trim()
    if (!t) {
      setError('Title is required.')
      titleRef.current?.focus()
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave({
        title: t,
        description: description.trim() || undefined,
        taskType,
        status,
        kbEntityId: mode === 'port' && kbPicked ? kbPicked.id : undefined,
      })
      onClose()
    } catch (err: any) {
      setError(err?.message || 'Failed to create task')
    } finally {
      setSaving(false)
    }
  }

  const canSave = title.trim().length > 0 && (mode === 'new' || kbPicked !== null)

  return (
    <div
      className="add-local-task-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div className="add-local-task-panel">
        <header className="add-local-task-head">
          <div>
            <div className="add-local-task-eyebrow">New task in {boardName}</div>
            <h2>{mode === 'new' ? 'New internal task' : 'Port from KB entity'}</h2>
          </div>
          <button
            className="add-local-task-close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="add-local-task-mode-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'new'}
            className={`add-local-task-mode ${mode === 'new' ? 'active' : ''}`}
            onClick={() => { setMode('new'); setKbPicked(null); setError(null) }}
            disabled={saving}
          >
            <Sparkles size={13} /> New from scratch
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'port'}
            className={`add-local-task-mode ${mode === 'port' ? 'active' : ''}`}
            onClick={() => { setMode('port'); setError(null) }}
            disabled={saving}
          >
            <ExternalLink size={13} /> Port from KB entity
          </button>
        </div>

        {mode === 'new' && (
          <p className="add-local-task-hint">
            Tracks work that doesn't live in Jira — research, docs, design proposals.
            Sync leaves it alone. When you move it to <strong>In Progress</strong>, the
            init skill will run its non-Jira branch and set up a fresh KB entity for it.
          </p>
        )}

        {mode === 'port' && (
          <p className="add-local-task-hint">
            Pick a KB entity (project, task, meeting, decision, spike, …).
            The new board task is <strong>pre-linked</strong> to it — when you move it to
            <strong> In Progress</strong>, the init skill loads all its docs, decisions
            and history instead of creating a duplicate. Title and description prefill
            from the entity; edit them if you want to reframe the work.
          </p>
        )}

        {mode === 'port' && (
          <div className="add-local-task-field">
            <span>Pick a KB entity</span>
            <input
              type="text"
              value={kbSearch}
              onChange={(e) => setKbSearch(e.target.value)}
              placeholder="Search by title, type, or id…"
              disabled={saving || kbLoading}
            />
            <div className="add-local-task-kb-list">
              {kbLoading && (
                <div className="add-local-task-kb-empty">Loading KB entities…</div>
              )}
              {kbError && (
                <div className="add-local-task-error">{kbError}</div>
              )}
              {!kbLoading && !kbError && filteredKb.length === 0 && (
                <div className="add-local-task-kb-empty">
                  {kbEntities.length === 0
                    ? 'No KB entities yet in this project.'
                    : 'No matches.'}
                </div>
              )}
              {filteredKb.slice(0, 60).map((e) => {
                const t = String((e as any).title || e.id)
                const isPicked = kbPicked?.id === e.id
                return (
                  <button
                    type="button"
                    key={e.id}
                    className={`add-local-task-kb-item ${isPicked ? 'picked' : ''}`}
                    onClick={() => setKbPicked(e)}
                    disabled={saving}
                    title={`${e.type} · ${e.id}`}
                  >
                    <span className="add-local-task-kb-type">{e.type}</span>
                    <span className="add-local-task-kb-title">{t}</span>
                    <span className="add-local-task-kb-id">{e.id}</span>
                  </button>
                )
              })}
              {filteredKb.length > 60 && (
                <div className="add-local-task-kb-empty">
                  Showing 60 of {filteredKb.length}. Refine the search to see the rest.
                </div>
              )}
            </div>
          </div>
        )}

        {(mode === 'new' || kbPicked) && (
          <>
            <label className="add-local-task-field">
              <span>Title</span>
              <input
                ref={titleRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={
                  mode === 'new'
                    ? 'e.g. Research: how ttyd reconnects survive server restarts'
                    : 'Prefilled from the KB entity — edit if you want to reframe.'
                }
                disabled={saving}
                maxLength={140}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave() }}
              />
            </label>

            <div className="add-local-task-field">
              <span>Kind of work</span>
              <div className="add-local-task-type-grid" role="radiogroup" aria-label="Task type">
                {TYPE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={taskType === o.value}
                    className={`add-local-task-type ${taskType === o.value ? 'active' : ''}`}
                    onClick={() => setTaskType(o.value)}
                    disabled={saving}
                    title={o.hint}
                  >
                    <span className="add-local-task-type-icon">{o.icon}</span>
                    <span className="add-local-task-type-label">{o.label}</span>
                  </button>
                ))}
              </div>
              <p className="add-local-task-type-hint">
                {TYPE_OPTIONS.find((o) => o.value === taskType)?.hint}
              </p>
            </div>

            <div className="add-local-task-field">
              <span>Column</span>
              <div className="add-local-task-status-row" role="radiogroup" aria-label="Initial column">
                {columns.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={status === c}
                    className={`add-local-task-status ${status === c ? 'active' : ''}`}
                    onClick={() => setStatus(c)}
                    disabled={saving}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <p className="add-local-task-type-hint">
                Where the card lands on the board. Pick <code>in-progress</code> if you want
                the init skill to run immediately.
              </p>
            </div>

            <label className="add-local-task-field">
              <span>Description {mode === 'port' && '(prefilled from KB entity)'}</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this task about? What's the outcome? (Cmd/Ctrl+Enter to save)"
                disabled={saving}
                rows={5}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave() }}
              />
            </label>
          </>
        )}

        {error && <div className="add-local-task-error">{error}</div>}

        <footer className="add-local-task-actions">
          <button
            className="add-local-task-btn ghost"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className="add-local-task-btn primary"
            onClick={handleSave}
            disabled={saving || !canSave}
          >
            {saving ? 'Adding…' : mode === 'port' ? 'Port to board' : 'Add task'}
          </button>
        </footer>
      </div>
    </div>
  )
}
