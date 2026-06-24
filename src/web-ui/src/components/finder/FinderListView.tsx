import { useState } from 'react'
import { Folder } from 'lucide-react'
import { FileListItem } from '../../api/client'
import { getFileIcon, getFileKind, formatFileSize, formatRelativeTime } from '../../utils/fileTypes'
import { useLongPress } from '../code-editor/ContextMenu'

type SortKey = 'name' | 'modifiedAt' | 'size' | 'kind'
type SortDir = 'asc' | 'desc'

// Touch detection runs at module scope — desktops with touchscreens won't
// match, which is fine: long-press is additive (right-click still works
// alongside it), so a stray touch device won't lose anything.
const IS_TOUCH = typeof window !== 'undefined' && (
  'ontouchstart' in window ||
  (navigator as any).maxTouchPoints > 0
)

interface FinderListViewProps {
  items: FileListItem[]
  selectedItems: Set<string>
  onSelect: (path: string) => void
  onOpen: (item: FileListItem) => void
  onContextMenu: (e: React.MouseEvent, item: FileListItem) => void
  /** Touch long-press handler — mobile substitute for right-click. */
  onLongPress?: (e: React.TouchEvent | React.MouseEvent, item: FileListItem) => void
  onMoveFile: (fromPath: string, toDirectory: string) => void
  onUploadFiles: (files: File[], destination: string) => void
}

export function FinderListView({
  items,
  selectedItems,
  onSelect,
  onOpen,
  onContextMenu,
  onLongPress,
  onMoveFile,
  onUploadFiles,
}: FinderListViewProps) {
  const [sortBy, setSortBy] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(key)
      setSortDir('asc')
    }
  }

  const sorted = [...items].sort((a, b) => {
    // Directories always first
    if (a.type === 'directory' && b.type !== 'directory') return -1
    if (a.type !== 'directory' && b.type === 'directory') return 1

    let cmp = 0
    switch (sortBy) {
      case 'name':
        cmp = a.name.localeCompare(b.name)
        break
      case 'modifiedAt':
        cmp = new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime()
        break
      case 'size':
        cmp = a.size - b.size
        break
      case 'kind':
        cmp = getFileKind(a.extension).localeCompare(getFileKind(b.extension))
        break
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  const sortIndicator = (key: SortKey) => {
    if (sortBy !== key) return null
    return <span className="sort-indicator">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
  }

  const handleDragStart = (e: React.DragEvent, item: FileListItem) => {
    e.dataTransfer.setData('text/x-orka-path', item.path)
    e.dataTransfer.setData('text/plain', item.path)
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  const handleDragOver = (e: React.DragEvent, item: FileListItem) => {
    if (item.type !== 'directory') return
    const isInternal = e.dataTransfer.types.includes('text/x-orka-path')
    const isExternal = e.dataTransfer.types.includes('Files') && !isInternal
    if (!isInternal && !isExternal) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = isExternal ? 'copy' : 'move'
    if (dragOverPath !== item.path) {
      setDragOverPath(item.path)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    // Only clear if truly leaving (not entering a child element)
    const relatedTarget = e.relatedTarget as HTMLElement | null
    if (relatedTarget && (e.currentTarget as HTMLElement).contains(relatedTarget)) return
    setDragOverPath(null)
  }

  const handleDrop = (e: React.DragEvent, targetItem: FileListItem) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverPath(null)
    if (targetItem.type !== 'directory') return

    // External file upload to this folder
    const fromPath = e.dataTransfer.getData('text/x-orka-path')
    if (!fromPath && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files)
      onUploadFiles(files, targetItem.path)
      return
    }

    // Internal file move
    if (!fromPath || fromPath === targetItem.path) return
    if (targetItem.path.startsWith(fromPath + '/')) return
    onMoveFile(fromPath, targetItem.path)
  }

  return (
    <div className="finder-list-view">
      <div className="finder-list-header">
        <button className="finder-list-col col-name" onClick={() => handleSort('name')}>
          Name {sortIndicator('name')}
        </button>
        <button className="finder-list-col col-date" onClick={() => handleSort('modifiedAt')}>
          Date Modified {sortIndicator('modifiedAt')}
        </button>
        <button className="finder-list-col col-size" onClick={() => handleSort('size')}>
          Size {sortIndicator('size')}
        </button>
        <button className="finder-list-col col-kind" onClick={() => handleSort('kind')}>
          Kind {sortIndicator('kind')}
        </button>
      </div>

      <div className="finder-list-body">
        {sorted.map(item => {
          const isSelected = selectedItems.has(item.path)
          const isDir = item.type === 'directory'
          const isDragOver = dragOverPath === item.path

          return (
            <FinderListRow
              key={item.path}
              item={item}
              isSelected={isSelected}
              isDragOver={isDragOver}
              onSelect={onSelect}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              onLongPress={onLongPress}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="finder-list-col col-name">
                <span className="finder-item-icon">
                  {isDir ? <Folder size={16} /> : getFileIcon(item.name, 16)}
                </span>
                <span className="finder-item-name">{item.name}</span>
                {isDir && item.childCount !== undefined && (
                  <span className="finder-child-count">{item.childCount}</span>
                )}
              </div>
              <div className="finder-list-col col-date">
                {formatRelativeTime(item.modifiedAt)}
              </div>
              <div className="finder-list-col col-size">
                {isDir ? '--' : formatFileSize(item.size)}
              </div>
              <div className="finder-list-col col-kind">
                {getFileKind(item.extension)}
              </div>
            </FinderListRow>
          )
        })}
      </div>
    </div>
  )
}

/**
 * One row, isolated into its own component so `useLongPress` can hook in
 * once per item (hooks can't run inside a `.map` callback in the parent).
 * Acts as a thin wrapper that merges long-press handlers when on touch
 * devices and otherwise forwards the same DOM events the row had before.
 */
interface FinderListRowProps {
  item: FileListItem
  isSelected: boolean
  isDragOver: boolean
  onSelect: (path: string) => void
  onOpen: (item: FileListItem) => void
  onContextMenu: (e: React.MouseEvent, item: FileListItem) => void
  onLongPress?: (e: React.TouchEvent | React.MouseEvent, item: FileListItem) => void
  onDragStart: (e: React.DragEvent, item: FileListItem) => void
  onDragOver: (e: React.DragEvent, item: FileListItem) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent, item: FileListItem) => void
  children: React.ReactNode
}

function FinderListRow({
  item,
  isSelected,
  isDragOver,
  onSelect,
  onOpen,
  onContextMenu,
  onLongPress,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: FinderListRowProps) {
  const longPressHandlers = useLongPress(
    (e) => { if (onLongPress) onLongPress(e, item) },
    { delay: 500, onPress: () => onSelect(item.path) }
  )

  return (
    <div
      className={`finder-list-row ${isSelected ? 'selected' : ''} ${isDragOver ? 'drag-over' : ''}`}
      // On touch devices long-press handles selection (via the hook's
      // onPress) AND opens the context menu. Skip the bare onClick so
      // we don't fire selection twice.
      onClick={IS_TOUCH ? undefined : () => onSelect(item.path)}
      onDoubleClick={() => onOpen(item)}
      onContextMenu={(e) => onContextMenu(e, item)}
      draggable
      onDragStart={(e) => onDragStart(e, item)}
      onDragOver={(e) => onDragOver(e, item)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, item)}
      {...(IS_TOUCH && onLongPress ? longPressHandlers : {})}
    >
      {children}
    </div>
  )
}
