import { useEffect, useMemo, useState } from 'react'
import {
  Archive, RotateCcw, Trash2, X, Search, ChevronRight,
  FileText, FolderOpen, ExternalLink,
} from 'lucide-react'
import { api, type BoardTask } from '../../api/client'
import { kbLinksFromEntity, labelForPathKey, openTaskPath, type TaskLink } from './taskLinks'

/**
 * The archive bucket: everything taken off the board without being
 * thrown away.
 *
 * The board itself is meant to show only work in flight, so finished or
 * abandoned cards move here instead of accumulating in a Done column
 * nobody reads. Nothing is lost — each row keeps its description, KB
 * entity and Claude session, and Restore puts it back exactly as it was.
 *
 * Grouped by the month it was archived, newest first, because the thing
 * you want from a history is usually "what was I doing around then".
 *
 * Rows expand in place to show what the task actually was — description,
 * where its work lives, its branch and worktree. That's the whole point
 * of an archive you can browse: you should be able to answer "what was
 * this?" without restoring it back onto the board first.
 */

interface Props {
  projectPath: string
  tasks: BoardTask[]
  busyKey: string | null
  onRestore: (task: BoardTask) => void | Promise<void>
  onDelete: (task: BoardTask) => void | Promise<void>
  onClose: () => void
}

/** "September 2026" — the group heading. Falls back to a bucket for rows
 *  with an unparseable timestamp so nothing silently disappears. */
function monthLabel(iso?: string): string {
  if (!iso) return 'Unknown date'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Unknown date'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function dayLabel(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function BoardArchiveDrawer({ projectPath, tasks, busyKey, onRestore, onDelete, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  /** Task key whose details are open. One at a time — the drawer is
   *  narrow, and several expanded rows would bury the list. */
  const [openKey, setOpenKey] = useState<string | null>(null)
  /** KB entity per entity id, fetched the first time a row that links to
   *  one is expanded. Archives can hold dozens of tasks; fetching every
   *  entity up front to fill a panel nobody may open would be wasteful. */
  const [entities, setEntities] = useState<Record<string, { properties?: Record<string, unknown> } | null>>({})

  const expanded = openKey ? tasks.find((t) => t.key === openKey) ?? null : null
  const entityId = expanded?.kbEntityId

  useEffect(() => {
    if (!entityId || entityId in entities) return
    let cancelled = false
    api.getKBEntity(projectPath, entityId)
      .then((e) => { if (!cancelled) setEntities((m) => ({ ...m, [entityId]: e as any })) })
      // Cache the failure too, as null — otherwise a missing entity
      // re-fetches on every render of the expanded row.
      .catch(() => { if (!cancelled) setEntities((m) => ({ ...m, [entityId]: null })) })
    return () => { cancelled = true }
  }, [projectPath, entityId, entities])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Esc unwinds one layer at a time: the destructive prompt first so
      // it can't be dismissed by closing the drawer around it, then an
      // expanded row, then the drawer.
      if (confirmKey) setConfirmKey(null)
      else if (openKey) setOpenKey(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmKey, openKey, onClose])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? tasks.filter((t) =>
          t.key.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q) ||
          (t.description || '').toLowerCase().includes(q))
      : tasks

    const sorted = [...filtered].sort((a, b) =>
      String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')))

    const out: Array<{ label: string; items: BoardTask[] }> = []
    for (const t of sorted) {
      const label = monthLabel(t.archivedAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(t)
      else out.push({ label, items: [t] })
    }
    return out
  }, [tasks, query])

  return (
    <div
      className="board-archive-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Archived tasks"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <aside className="board-archive-panel">
        <header className="board-archive-head">
          <div className="board-archive-title">
            <Archive size={15} />
            <h2>Archive</h2>
            <span className="board-archive-count">{tasks.length}</span>
          </div>
          <button className="board-archive-close" onClick={onClose} aria-label="Close archive">
            <X size={16} />
          </button>
        </header>

        <div className="board-archive-search">
          <Search size={13} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search archived tasks…"
            aria-label="Search archived tasks"
          />
        </div>

        {tasks.length === 0 ? (
          <div className="board-archive-empty">
            <Archive size={22} />
            <p>Nothing archived yet.</p>
            <p className="board-archive-empty-hint">
              Archive a task to take it off the board without losing it — the record,
              its KB entity and its Claude session all stay.
            </p>
          </div>
        ) : groups.length === 0 ? (
          <div className="board-archive-empty">
            <p>No archived task matches “{query}”.</p>
          </div>
        ) : (
          <div className="board-archive-list">
            {groups.map((g) => (
              <section key={g.label} className="board-archive-group">
                <h3>{g.label}</h3>
                {g.items.map((t) => (
                  <article key={t.key} className="board-archive-item">
                    <button
                      type="button"
                      className="board-archive-item-main"
                      onClick={() => setOpenKey(openKey === t.key ? null : t.key)}
                      aria-expanded={openKey === t.key}
                      title={openKey === t.key ? 'Hide details' : 'Show details'}
                    >
                      <ChevronRight
                        size={13}
                        className={`board-archive-chevron ${openKey === t.key ? 'open' : ''}`}
                        aria-hidden
                      />
                      <span className="board-archive-item-text">
                        <span className="board-archive-item-meta">
                          <span className="board-archive-key">{t.key}</span>
                          <span className="board-archive-status">{t.status}</span>
                          {t.archivedAt && (
                            <span className="board-archive-when">{dayLabel(t.archivedAt)}</span>
                          )}
                        </span>
                        <span className="board-archive-item-title">{t.title}</span>
                      </span>
                    </button>

                    {confirmKey === t.key ? (
                      <div className="board-archive-confirm">
                        <span>Delete permanently?</span>
                        <button
                          className="board-archive-btn danger"
                          disabled={busyKey === t.key}
                          onClick={async () => { await onDelete(t); setConfirmKey(null) }}
                        >
                          {busyKey === t.key ? 'Deleting…' : 'Delete'}
                        </button>
                        <button
                          className="board-archive-btn ghost"
                          onClick={() => setConfirmKey(null)}
                          disabled={busyKey === t.key}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="board-archive-item-actions">
                        <button
                          className="board-archive-btn"
                          onClick={() => void onRestore(t)}
                          disabled={busyKey === t.key}
                          title="Put this card back on the board"
                        >
                          <RotateCcw size={13} />
                          <span>{busyKey === t.key ? 'Restoring…' : 'Restore'}</span>
                        </button>
                        {/* Delete stays local-only for the same reason it
                            is in the task modal: sync would re-add a
                            deleted Jira ticket on its next run, so the
                            button would look broken. */}
                        {t.origin === 'local' && (
                          <button
                            className="board-archive-btn icon danger"
                            onClick={() => setConfirmKey(t.key)}
                            disabled={busyKey === t.key}
                            title="Delete permanently"
                            aria-label={`Delete ${t.key}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    )}

                    {openKey === t.key && (
                      <TaskDetails
                        task={t}
                        projectPath={projectPath}
                        entity={t.kbEntityId ? entities[t.kbEntityId] : undefined}
                      />
                    )}
                  </article>
                ))}
              </section>
            ))}
          </div>
        )}
      </aside>
    </div>
  )
}

/**
 * The expanded body of an archived row: what the task was, and where its
 * work lives. Read-only on purpose — this is for answering "what was
 * this?" without putting the card back on the board.
 *
 * `entity` is `undefined` while the KB fetch is in flight and `null` when
 * there's nothing to show (no linked entity, or the fetch failed), which
 * is why the two are distinguished rather than collapsed into a falsy
 * check.
 */
function TaskDetails({
  task,
  projectPath,
  entity,
}: {
  task: BoardTask
  projectPath: string
  entity: { properties?: Record<string, unknown> } | null | undefined
}) {
  const links: TaskLink[] = kbLinksFromEntity(entity)
  const loadingLinks = !!task.kbEntityId && entity === undefined

  return (
    <div className="board-archive-details">
      {task.description ? (
        <p className="board-archive-desc">{task.description}</p>
      ) : (
        <p className="board-archive-desc empty">No description.</p>
      )}

      {loadingLinks && <p className="board-archive-links-loading">Loading links…</p>}

      {links.length > 0 && (
        <div className="board-archive-links">
          {links.map((l) => (
            <button
              key={l.key}
              type="button"
              className="board-archive-link"
              onClick={() => openTaskPath(projectPath, l.path)}
              title={l.path}
            >
              {l.isFile ? <FileText size={13} /> : <FolderOpen size={13} />}
              <span className="board-archive-link-label">{labelForPathKey(l.key)}</span>
              <span className="board-archive-link-path">{l.path}</span>
              <ExternalLink size={10} className="board-archive-link-arrow" />
            </button>
          ))}
        </div>
      )}

      <dl className="board-archive-meta-grid">
        {task.taskType && (<><dt>Kind</dt><dd>{task.taskType}</dd></>)}
        {task.jiraUrl && (
          <><dt>Jira</dt>
          <dd><a href={task.jiraUrl} target="_blank" rel="noreferrer">{task.jiraUrl}</a></dd></>
        )}
        {task.branchName && (<><dt>Branch</dt><dd><code>{task.branchName}</code></dd></>)}
        {task.worktreePath && (<><dt>Worktree</dt><dd><code>{task.worktreePath}</code></dd></>)}
        {task.kbEntityId && (<><dt>KB entity</dt><dd><code>{task.kbEntityId}</code></dd></>)}
        <dt>Created</dt><dd>{new Date(task.createdAt).toLocaleString()}</dd>
        {task.archivedAt && (
          <><dt>Archived</dt><dd>{new Date(task.archivedAt).toLocaleString()}</dd></>
        )}
      </dl>
    </div>
  )
}
