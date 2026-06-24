import { useState } from 'react'
import { Folder } from 'lucide-react'
import { FileListItem } from '../../api/client'
import { getFileIcon, getFileKind } from '../../utils/fileTypes'
import { useLongPress } from '../code-editor/ContextMenu'

const IS_TOUCH = typeof window !== 'undefined' && (
  'ontouchstart' in window ||
  (navigator as any).maxTouchPoints > 0
)

interface FinderGridViewProps {
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

export function FinderGridView({
  items,
  selectedItems,
  onSelect,
  onOpen,
  onContextMenu,
  onLongPress,
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
          <FinderGridItem
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
            <div className="finder-grid-icon">
              {isDir ? <Folder size={48} /> : getFileIcon(item.name, 48)}
            </div>
            <div className="finder-grid-name">{item.name}</div>
          </FinderGridItem>
        )
      })}
    </div>
  )
}

/** One grid item, extracted so `useLongPress` can hook per-item (hooks
 *  can't run in a `.map` callback). Mirrors FinderListRow. */
interface FinderGridItemProps {
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

function FinderGridItem({
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
}: FinderGridItemProps) {
  const longPressHandlers = useLongPress(
    (e) => { if (onLongPress) onLongPress(e, item) },
    { delay: 500, onPress: () => onSelect(item.path) }
  )

  return (
    <div
      className={`finder-grid-item ${isSelected ? 'selected' : ''} ${isDragOver ? 'drag-over' : ''}`}
      onClick={IS_TOUCH ? undefined : () => onSelect(item.path)}
      onDoubleClick={() => onOpen(item)}
      onContextMenu={(e) => onContextMenu(e, item)}
      draggable
      onDragStart={(e) => onDragStart(e, item)}
      onDragOver={(e) => onDragOver(e, item)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, item)}
      title={`${item.name}\n${getFileKind(item.extension)}`}
      {...(IS_TOUCH && onLongPress ? longPressHandlers : {})}
    >
      {children}
    </div>
  )
}
