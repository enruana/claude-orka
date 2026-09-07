import { useState } from 'react'
import { AlertTriangle, GitBranch, Terminal, Archive } from 'lucide-react'
import type { BoardTask, BoardDrift } from '../../api/client'

/**
 * Kanban view for a Board — columns from `BoardConfig.columns`, cards from
 * the tasks list. Drag & drop between columns fires `onMoveTask`; the
 * parent decides whether that means "spawn a task terminal" (todo →
 * in-progress) or "close" (in-progress → done).
 *
 * Cards show:
 *  - Jira key + title
 *  - assignee (if any)
 *  - a terminal icon when a task terminal is alive
 *  - a warning triangle when the task has a drift record
 */
interface Props {
  columns: string[]
  tasks: BoardTask[]
  driftByKey: Map<string, BoardDrift>
  onOpenTask: (task: BoardTask) => void
  onMoveTask: (task: BoardTask, newStatus: string) => void | Promise<void>
  onAckDrift: (taskKey: string) => void
  /** Archive every card in one column. The caller does the work; this
   *  component owns the confirmation, so the prompt sits next to the
   *  button that raised it instead of as a page-level modal. */
  onArchiveColumn?: (status: string, count: number) => void | Promise<void>
  /** Column currently being archived — disables its button and shows
   *  progress. */
  archivingColumn?: string | null
}

export function BoardKanban({
  columns,
  tasks,
  driftByKey,
  onOpenTask,
  onMoveTask,
  onAckDrift,
  onArchiveColumn,
  archivingColumn,
}: Props) {
  /** Column whose "archive all" is awaiting confirmation. Inline rather
   *  than a modal: it's a per-column action and the count it's asking
   *  about is right there in the header. */
  const [confirmColumn, setConfirmColumn] = useState<string | null>(null)
  // Track which card is being dragged and which column is currently the
  // drop target — powers the visual feedback (dimmed card + highlighted
  // column) that was missing before. Without these, HTML5 drag looks
  // broken until the mutation lands.
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)

  // Bucket by column, then sort each bucket by `updatedAt` DESC so
  // the freshest cards sit at the top. Applies to every column
  // (including Done) — the reader scans top-down and expects the most
  // recent activity first. Falls back to createdAt if updatedAt is
  // absent (shouldn't happen but defensive).
  const byColumn = new Map<string, BoardTask[]>()
  for (const col of columns) byColumn.set(col, [])
  for (const t of tasks) {
    const list = byColumn.get(t.status) ?? byColumn.set(t.status, []).get(t.status)!
    list.push(t)
  }
  for (const list of byColumn.values()) {
    list.sort((a, b) => {
      const ta = a.updatedAt || a.createdAt || ''
      const tb = b.updatedAt || b.createdAt || ''
      return tb.localeCompare(ta)
    })
  }

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, task: BoardTask) => {
    e.dataTransfer.setData('text/plain', task.key)
    e.dataTransfer.effectAllowed = 'move'
    // Use a small transparent image as the drag image so the browser's
    // default "ghost" doesn't overshadow the highlighted column.
    setDraggingKey(task.key)
  }

  const handleDragEnd = () => {
    setDraggingKey(null)
    setDragOverColumn(null)
  }

  const handleDrop = (col: string) => (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOverColumn(null)
    setDraggingKey(null)
    const key = e.dataTransfer.getData('text/plain')
    const task = tasks.find((t) => t.key === key)
    if (task && task.status !== col) void onMoveTask(task, col)
  }

  const allowDrop = (col: string) => (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverColumn !== col) setDragOverColumn(col)
  }

  const onColumnLeave = (col: string) => (e: React.DragEvent<HTMLDivElement>) => {
    // Only clear when the pointer actually left the column, not just
    // when moving between child elements inside it. `relatedTarget` is
    // the element the pointer is entering; if it's still a descendant
    // of the column, ignore.
    const related = e.relatedTarget as Node | null
    if (related && (e.currentTarget as Node).contains(related)) return
    if (dragOverColumn === col) setDragOverColumn(null)
  }

  return (
    <div className="board-kanban">
      {columns.map((col) => {
        const list = byColumn.get(col) ?? []
        const isDropTarget = dragOverColumn === col
        const isSameColumn = draggingKey !== null && tasks.find((t) => t.key === draggingKey)?.status === col
        return (
          <div
            key={col}
            className={`board-column ${isDropTarget ? 'drop-target' : ''} ${isDropTarget && isSameColumn ? 'drop-same' : ''}`}
            onDragOver={allowDrop(col)}
            onDragEnter={allowDrop(col)}
            onDragLeave={onColumnLeave(col)}
            onDrop={handleDrop(col)}
          >
            <div className="board-column-header">
              <span className="board-column-name">{col}</span>
              <span className="board-column-count">{list.length}</span>
              {onArchiveColumn && list.length > 0 && (
                <button
                  type="button"
                  className="board-column-archive"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmColumn(confirmColumn === col ? null : col)
                  }}
                  disabled={archivingColumn === col}
                  title={`Archive all ${list.length} task${list.length === 1 ? '' : 's'} in ${col}`}
                  aria-label={`Archive all tasks in ${col}`}
                >
                  <Archive size={12} />
                </button>
              )}
            </div>

            {confirmColumn === col && (
              <div className="board-column-confirm" role="alertdialog" aria-label={`Archive all in ${col}`}>
                <p>
                  Archive all <strong>{list.length}</strong> task{list.length === 1 ? '' : 's'} in{' '}
                  <strong>{col}</strong>? They move to the archive — nothing is deleted, and any
                  running terminals are stopped.
                </p>
                <div className="board-column-confirm-actions">
                  <button
                    type="button"
                    className="board-column-confirm-btn ghost"
                    onClick={() => setConfirmColumn(null)}
                    disabled={archivingColumn === col}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="board-column-confirm-btn primary"
                    disabled={archivingColumn === col}
                    onClick={async () => {
                      await onArchiveColumn?.(col, list.length)
                      setConfirmColumn(null)
                    }}
                  >
                    {archivingColumn === col ? 'Archiving…' : 'Archive all'}
                  </button>
                </div>
              </div>
            )}
            <div className="board-column-body">
              {list.length === 0 && (
                <div className="board-column-empty">
                  {isDropTarget ? 'release to drop here' : 'no tasks'}
                </div>
              )}
              {list.map((t) => {
                const drift = driftByKey.get(t.key)
                // Three-state terminal indicator:
                //  - `live`     — server currently owns a ttyd process for this
                //                 task (tmux + ttyd handles present).
                //  - `history`  — no live process, but a claude session id is
                //                 persisted (`claudeSessionId` survives detach)
                //                 OR a stale tmux name lingers from before the
                //                 durable-id change; either way the task is
                //                 resumable from where it left off.
                //  - none       — task never had a terminal.
                const isTerminalLive = !!t.terminalTmuxSessionId && !!t.ttydPort
                const hasHistory = !isTerminalLive && (!!t.claudeSessionId || !!t.terminalTmuxSessionId)
                const isBeingDragged = draggingKey === t.key
                // Local (non-Jira) tasks get a subtle mustard tint on
                // the card so they're distinguishable at a glance from
                // the mirrored Jira cards. Kept subtle: soft left
                // border + slightly warmer background — no shouting.
                const isLocal = t.origin === 'local'
                return (
                  <div
                    key={t.key}
                    className={`board-card ${isBeingDragged ? 'dragging' : ''} ${isLocal ? 'local' : ''}`}
                    draggable
                    onDragStart={(e) => handleDragStart(e, t)}
                    onDragEnd={handleDragEnd}
                    onClick={() => onOpenTask(t)}
                  >
                    <div className="board-card-top">
                      <span className="board-card-key">{t.key}</span>
                      {isLocal && (
                        <span
                          className="board-card-local-badge"
                          title={t.taskType ? `Local task · ${t.taskType}` : 'Local task (no Jira)'}
                        >
                          {t.taskType || 'local'}
                        </span>
                      )}
                      {drift && (
                        <button
                          className="board-card-drift"
                          title={`Jira moved ${drift.fromStatus} → ${drift.toStatus} — click to dismiss`}
                          onClick={(e) => {
                            e.stopPropagation()
                            onAckDrift(t.key)
                          }}
                        >
                          <AlertTriangle size={12} />
                        </button>
                      )}
                      {isTerminalLive && (
                        <span
                          className="board-card-terminal live"
                          title="Terminal running — click to open"
                        >
                          <Terminal size={11} />
                        </span>
                      )}
                      {hasHistory && (
                        <span
                          className="board-card-terminal history"
                          title="Prior terminal session — open task and hit Reopen to resume with full Claude history"
                        >
                          <Terminal size={11} />
                        </span>
                      )}
                      {t.branchName && (
                        <span className="board-card-branch" title={t.branchName}>
                          <GitBranch size={11} />
                        </span>
                      )}
                    </div>
                    <div className="board-card-title">{t.title}</div>
                    {t.assignee && (
                      <div className="board-card-assignee">@{t.assignee}</div>
                    )}
                    {t.labels && t.labels.length > 0 && (
                      <div className="board-card-labels">
                        {t.labels.slice(0, 3).map((l) => (
                          <span key={l} className="board-card-label">{l}</span>
                        ))}
                        {t.labels.length > 3 && <span className="board-card-label">+{t.labels.length - 3}</span>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
