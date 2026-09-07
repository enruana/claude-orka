import { useEffect, useMemo, useState } from 'react'
import { Archive, RotateCcw, Trash2, X, Search } from 'lucide-react'
import type { BoardTask } from '../../api/client'

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
 */

interface Props {
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

export function BoardArchiveDrawer({ tasks, busyKey, onRestore, onDelete, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [confirmKey, setConfirmKey] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Esc backs out of the delete confirmation first, so it can't
      // close the whole drawer while a destructive prompt is open.
      if (confirmKey) setConfirmKey(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmKey, onClose])

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
                    <div className="board-archive-item-main">
                      <div className="board-archive-item-meta">
                        <span className="board-archive-key">{t.key}</span>
                        <span className="board-archive-status">{t.status}</span>
                        {t.archivedAt && (
                          <span className="board-archive-when">{dayLabel(t.archivedAt)}</span>
                        )}
                      </div>
                      <p className="board-archive-item-title">{t.title}</p>
                    </div>

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
