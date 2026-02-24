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
  onUploadFiles: (files: File[], destination: string) => void
}

export function FinderGridView({
  items,
  selectedItems,
  onSelect,
  onOpen,
  onContextMenu,
  onMoveFile,
  onUploadFiles,
}: FinderGridViewProps) {
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)

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
