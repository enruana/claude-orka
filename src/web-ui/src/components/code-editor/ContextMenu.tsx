import { useEffect, useRef, useState, useCallback } from 'react'
import { Copy, FileText, Folder, X, FilePlus, FolderPlus, Trash2 } from 'lucide-react'

export interface ContextMenuItem {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  disabled?: boolean
}

interface ContextMenuProps {
  items: ContextMenuItem[]
  position: { x: number; y: number }
  onClose: () => void
  title?: string
}

export function ContextMenu({ items, position, onClose, title }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Adjust position to keep menu on screen
  useEffect(() => {
    if (menuRef.current) {
      const menu = menuRef.current
      const rect = menu.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      let x = position.x
      let y = position.y

      // Adjust horizontal position
      if (x + rect.width > viewportWidth - 10) {
        x = viewportWidth - rect.width - 10
      }
      if (x < 10) x = 10

      // Adjust vertical position
      if (y + rect.height > viewportHeight - 10) {
        y = viewportHeight - rect.height - 10
      }
      if (y < 10) y = 10

      menu.style.left = `${x}px`
      menu.style.top = `${y}px`
    }
  }, [position])

  // Close on click outside or escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    // Small delay to prevent immediate close on mobile
    setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('touchstart', handleClickOutside)
      document.addEventListener('keydown', handleEscape)
    }, 100)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  const handleItemClick = (item: ContextMenuItem) => {
    if (!item.disabled) {
      item.onClick()
      onClose()
    }
  }

  return (
    <div className="context-menu-overlay">
      <div
        ref={menuRef}
        className="context-menu"
        style={{ left: position.x, top: position.y }}
      >
        {title && (
          <div className="context-menu-header">
            <span className="context-menu-title">{title}</span>
            <button className="context-menu-close" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        )}
        <div className="context-menu-items">
          {items.map((item, index) => (
            <button
              key={index}
              className={`context-menu-item ${item.disabled ? 'disabled' : ''}`}
              onClick={() => handleItemClick(item)}
              disabled={item.disabled}
            >
              {item.icon && <span className="context-menu-icon">{item.icon}</span>}
              <span className="context-menu-label">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// Hook for long press detection (mobile)
export function useLongPress(
  onLongPress: (e: React.TouchEvent | React.MouseEvent) => void,
  options: { delay?: number; onPress?: () => void } = {}
) {
  const { delay = 500, onPress } = options
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const isLongPress = useRef(false)
  const positionRef = useRef<{ x: number; y: number } | null>(null)

  const start = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    isLongPress.current = false

    // Get position
    if ('touches' in e) {
      positionRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY
      }
    } else {
      positionRef.current = {
        x: e.clientX,
        y: e.clientY
      }
    }

    timerRef.current = setTimeout(() => {
      isLongPress.current = true
      onLongPress(e)
    }, delay)
  }, [onLongPress, delay])

  const clear = useCallback((e: React.TouchEvent | React.MouseEvent, shouldTriggerClick = true) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    if (shouldTriggerClick && !isLongPress.current && onPress) {
      onPress()
    }
  }, [onPress])

  const move = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    // Cancel if moved too far
    if (positionRef.current) {
      let currentX: number, currentY: number
      if ('touches' in e) {
        currentX = e.touches[0].clientX
        currentY = e.touches[0].clientY
      } else {
        currentX = e.clientX
        currentY = e.clientY
      }

      const distance = Math.sqrt(
        Math.pow(currentX - positionRef.current.x, 2) +
        Math.pow(currentY - positionRef.current.y, 2)
      )

      if (distance > 10) {
        clear(e, false)
      }
    }
  }, [clear])

  return {
    onTouchStart: start,
    onTouchEnd: clear,
    onTouchMove: move,
    onMouseDown: start,
    onMouseUp: clear,
    onMouseMove: move,
    onMouseLeave: (e: React.MouseEvent) => clear(e, false),
  }
}

// Hook for context menu state management
export function useContextMenu() {
  const [contextMenu, setContextMenu] = useState<{
    show: boolean
    position: { x: number; y: number }
    data?: any
  }>({
    show: false,
    position: { x: 0, y: 0 },
    data: null
  })

  const showContextMenu = useCallback((x: number, y: number, data?: any) => {
    setContextMenu({
      show: true,
      position: { x, y },
      data
    })
  }, [])

  const hideContextMenu = useCallback(() => {
    setContextMenu(prev => ({ ...prev, show: false }))
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, data?: any) => {
    e.preventDefault()
    e.stopPropagation()
    showContextMenu(e.clientX, e.clientY, data)
  }, [showContextMenu])

  const handleLongPress = useCallback((e: React.TouchEvent | React.MouseEvent, data?: any) => {
    e.preventDefault()
    e.stopPropagation()

    let x: number, y: number
    if ('touches' in e) {
      x = e.touches[0]?.clientX || e.changedTouches[0]?.clientX || 0
      y = e.touches[0]?.clientY || e.changedTouches[0]?.clientY || 0
    } else {
      x = e.clientX
      y = e.clientY
    }

    // Haptic feedback on mobile if available
    if ('vibrate' in navigator) {
      navigator.vibrate(50)
    }

    showContextMenu(x, y, data)
  }, [showContextMenu])

  return {
    contextMenu,
    showContextMenu,
    hideContextMenu,
    handleContextMenu,
    handleLongPress
  }
}

// Utility to copy text to clipboard
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }

    // Fallback for older browsers
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.style.position = 'fixed'
    textArea.style.left = '-999999px'
    textArea.style.top = '-999999px'
    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()

    const success = document.execCommand('copy')
    document.body.removeChild(textArea)
    return success
  } catch (err) {
    console.error('Failed to copy to clipboard:', err)
    return false
  }
}

// Pre-built menu items
export function createCopyPathItem(path: string, onCopied?: () => void): ContextMenuItem {
  return {
    label: 'Copy Path',
    icon: <Copy size={14} />,
    onClick: async () => {
      const success = await copyToClipboard(path)
      if (success && onCopied) {
        onCopied()
      }
    }
  }
}

export function createCopyRelativePathItem(path: string, basePath: string, onCopied?: () => void): ContextMenuItem {
  const relativePath = path.startsWith(basePath)
    ? path.slice(basePath.length).replace(/^\//, '')
    : path

  return {
    label: 'Copy Relative Path',
    icon: <FileText size={14} />,
    onClick: async () => {
      const success = await copyToClipboard(relativePath)
      if (success && onCopied) {
        onCopied()
      }
    }
  }
}

export function createCopyFileNameItem(path: string, onCopied?: () => void): ContextMenuItem {
  const fileName = path.split('/').pop() || path

  return {
    label: 'Copy File Name',
    icon: <Folder size={14} />,
    onClick: async () => {
      const success = await copyToClipboard(fileName)
      if (success && onCopied) {
        onCopied()
      }
    }
  }
}

export function createNewFileItem(onNewFile: () => void): ContextMenuItem {
  return {
    label: 'New File',
    icon: <FilePlus size={14} />,
    onClick: onNewFile
  }
}

export function createNewFolderItem(onNewFolder: () => void): ContextMenuItem {
  return {
    label: 'New Folder',
    icon: <FolderPlus size={14} />,
    onClick: onNewFolder
  }
}

export function createDeleteItem(onDelete: () => void, label: string = 'Delete'): ContextMenuItem {
  return {
    label,
    icon: <Trash2 size={14} />,
    onClick: onDelete
  }
}
