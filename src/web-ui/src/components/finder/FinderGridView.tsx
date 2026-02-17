import { Folder } from 'lucide-react'
import { FileListItem } from '../../api/client'
import { getFileIcon, getFileKind } from '../../utils/fileTypes'

interface FinderGridViewProps {
  items: FileListItem[]
  selectedItems: Set<string>
  onSelect: (path: string) => void
  onOpen: (item: FileListItem) => void
  onContextMenu: (e: React.MouseEvent, item: FileListItem) => void
}

export function FinderGridView({
  items,
  selectedItems,
  onSelect,
  onOpen,
  onContextMenu,
}: FinderGridViewProps) {
  const handleDragStart = (e: React.DragEvent, item: FileListItem) => {
    e.dataTransfer.setData('text/x-orka-path', item.path)
    e.dataTransfer.setData('text/plain', item.path)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className="finder-grid-view">
      {items.map(item => {
        const isSelected = selectedItems.has(item.path)
        const isDir = item.type === 'directory'

        return (
          <div
            key={item.path}
            className={`finder-grid-item ${isSelected ? 'selected' : ''}`}
            onClick={() => onSelect(item.path)}
            onDoubleClick={() => onOpen(item)}
            onContextMenu={(e) => onContextMenu(e, item)}
            draggable
            onDragStart={(e) => handleDragStart(e, item)}
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
