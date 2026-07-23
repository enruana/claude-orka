import { useState } from 'react'
import { AlertTriangle, GitBranch, Terminal } from 'lucide-react'
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
}

export function BoardKanban({ columns, tasks, driftByKey, onOpenTask, onMoveTask, onAckDrift }: Props) {
  // Track which card is being dragged and which column is currently the
  // drop target — powers the visual feedback (dimmed card + highlighted
  // column) that was missing before. Without these, HTML5 drag looks
  // broken until the mutation lands.
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)

  const byColumn = new Map<string, BoardTask[]>()
  for (const col of columns) byColumn.set(col, [])
  for (const t of tasks) {
    const list = byColumn.get(t.status) ?? byColumn.set(t.status, []).get(t.status)!
    list.push(t)
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
            </div>
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
                return (
                  <div
                    key={t.key}
                    className={`board-card ${isBeingDragged ? 'dragging' : ''}`}
                    draggable
                    onDragStart={(e) => handleDragStart(e, t)}
                    onDragEnd={handleDragEnd}
                    onClick={() => onOpenTask(t)}
                  >
                    <div className="board-card-top">
                      <span className="board-card-key">{t.key}</span>
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
