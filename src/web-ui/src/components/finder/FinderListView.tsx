import { useState } from 'react'
import { Folder } from 'lucide-react'
import { FileListItem } from '../../api/client'
import { getFileIcon, getFileKind, formatFileSize, formatRelativeTime } from '../../utils/fileTypes'

type SortKey = 'name' | 'modifiedAt' | 'size' | 'kind'
type SortDir = 'asc' | 'desc'

interface FinderListViewProps {
  items: FileListItem[]
  selectedItems: Set<string>
  onSelect: (path: string) => void
  onOpen: (item: FileListItem) => void
  onContextMenu: (e: React.MouseEvent, item: FileListItem) => void
  onMoveFile: (fromPath: string, toDirectory: string) => void
}

export function FinderListView({
  items,
  selectedItems,
  onSelect,
  onOpen,
  onContextMenu,
  onMoveFile,
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
    if (!e.dataTransfer.types.includes('text/x-orka-path')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
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
    const fromPath = e.dataTransfer.getData('text/x-orka-path')
    if (!fromPath || fromPath === targetItem.path) return
    // Prevent dropping a folder into itself
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
            <div
              key={item.path}
              className={`finder-list-row ${isSelected ? 'selected' : ''} ${isDragOver ? 'drag-over' : ''}`}
              onClick={() => onSelect(item.path)}
              onDoubleClick={() => onOpen(item)}
              onContextMenu={(e) => onContextMenu(e, item)}
              draggable
              onDragStart={(e) => handleDragStart(e, item)}
              onDragOver={(e) => handleDragOver(e, item)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, item)}
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
            </div>
          )
        })}
      </div>
    </div>
  )
}
