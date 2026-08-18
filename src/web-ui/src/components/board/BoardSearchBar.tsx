import { useEffect, useMemo, useRef } from 'react'
import { Search, X } from 'lucide-react'
import type { BoardTask } from '../../api/client'

/**
 * Search bar for the Board's Kanban tab.
 *
 * Behavior:
 *  - Case-insensitive substring match across `key`, `title`, `labels`,
 *    `assignee`, `description`. Order doesn't matter for filtering
 *    (BoardKanban still sorts each column by updatedAt DESC); this
 *    just narrows the set of visible cards.
 *  - `/` or `Cmd/Ctrl+K` focuses the input from anywhere in the board
 *    page (Linear / GitHub pattern the user's muscle memory expects).
 *    Guarded so it doesn't hijack keystrokes while the user is typing
 *    inside another input or a modal.
 *  - `Esc` while focused clears the query + blurs.
 *  - When active, shows a "N of M tasks" counter so the user knows
 *    they're looking at a filtered view (avoids "why don't I see my
 *    card" confusion).
 */

interface Props {
  query: string
  onQueryChange: (q: string) => void
  matchCount: number
  totalCount: number
}

export function BoardSearchBar({ query, onQueryChange, matchCount, totalCount }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  // Global shortcut: `/` or Cmd/Ctrl+K focuses the search input from
  // anywhere on the page. Skip when the user is already typing in an
  // input/textarea/contenteditable — hijacking those would break normal
  // typing (e.g. writing "/tell foo" in a terminal caption box).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inField =
        target?.tagName === 'INPUT'
        || target?.tagName === 'TEXTAREA'
        || target?.isContentEditable
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
      const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !inField
      if (isCmdK || isSlash) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const active = query.trim().length > 0
  const hint = useMemo(() => {
    if (!active) return `${totalCount} task${totalCount === 1 ? '' : 's'}`
    return `${matchCount} of ${totalCount}`
  }, [active, matchCount, totalCount])

  return (
    <div className="board-search-bar">
      <div className={`board-search-input-wrap ${active ? 'active' : ''}`}>
        <Search size={14} className="board-search-icon" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          className="board-search-input"
          placeholder="Search by key or title…  ( / )"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Two-step: first Esc clears the query; a second Esc
              // (with the field already empty) blurs. Feels more like
              // Slack/Linear than an all-or-nothing clear.
              if (active) onQueryChange('')
              else inputRef.current?.blur()
            }
          }}
        />
        {active && (
          <button
            type="button"
            className="board-search-clear"
            onClick={() => {
              onQueryChange('')
              inputRef.current?.focus()
            }}
            title="Clear search"
            aria-label="Clear search"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <span className={`board-search-count ${active ? 'active' : ''}`}>{hint}</span>
    </div>
  )
}

/**
 * Filter helper — kept here (next to the search bar it powers) so the
 * matching rules and the input UI live in one file. Called from
 * BoardPage inside a useMemo so we don't re-scan the task list on every
 * unrelated render.
 *
 * Match rules (case-insensitive):
 *   - `key`         — "123" matches "PROJ-123"; "LOCAL" matches every local task
 *   - `title`       — the obvious one
 *   - `description` — useful for "what was that ticket about..." searches
 *   - `labels[]`    — any label containing the query
 *   - `assignee`    — for "show me john's tickets"
 *   - `taskType`    — local tasks: "research" / "spike" / etc.
 *   - `branchName`  — you sometimes remember the branch, not the ticket
 *
 * Empty / whitespace query → return the original array unchanged (no
 * copy — the parent compares by reference to decide whether to
 * re-render the kanban).
 */
export function filterBoardTasks(tasks: BoardTask[], rawQuery: string): BoardTask[] {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return tasks
  return tasks.filter((t) => {
    if (t.key?.toLowerCase().includes(q)) return true
    if (t.title?.toLowerCase().includes(q)) return true
    if (t.assignee?.toLowerCase().includes(q)) return true
    if (t.taskType?.toLowerCase().includes(q)) return true
    if (t.branchName?.toLowerCase().includes(q)) return true
    if (t.description?.toLowerCase().includes(q)) return true
    if (t.labels?.some((l) => l.toLowerCase().includes(q))) return true
    return false
  })
}
