import { useState } from 'react'
import { Folder } from 'lucide-react'
import { FileListItem } from '../../api/client'
import { getFileIcon, getFileKind } from '../../utils/fileTypes'

interface FinderGridViewProps {
  items: FileListItem[]
  selectedItems: Set<string>
  onSelect: (path: string) => void
  onOpen: (item: FileListItem) => void
  onContextMenu: (e: React.MouseEvent, item: FileListItem) => void
  onMoveFile: (fromPath: string, toDirectory: string) => void
}

export function FinderGridView({
  items,
  selectedItems,
  onSelect,
  onOpen,
  onContextMenu,
  onMoveFile,
}: FinderGridViewProps) {
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)

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
    if (targetItem.path.startsWith(fromPath + '/')) return
    onMoveFile(fromPath, targetItem.path)
  }

  return (
    <div className="finder-grid-view">
      {items.map(item => {
        const isSelected = selectedItems.has(item.path)
        const isDir = item.type === 'directory'
        const isDragOver = dragOverPath === item.path

        return (
          <div
            key={item.path}
            className={`finder-grid-item ${isSelected ? 'selected' : ''} ${isDragOver ? 'drag-over' : ''}`}
            onClick={() => onSelect(item.path)}
            onDoubleClick={() => onOpen(item)}
            onContextMenu={(e) => onContextMenu(e, item)}
            draggable
            onDragStart={(e) => handleDragStart(e, item)}
            onDragOver={(e) => handleDragOver(e, item)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, item)}
            title={`${item.name}\n${getFileKind(item.extension)}`}
          >
            <div className="finder-grid-icon">
              {isDir ? <Folder size={48} /> : getFileIcon(item.name, 48)}
            </div>
            <div className="finder-grid-name">{item.name}</div>
          </div>
        )
      })}
    </div>
  )
}
