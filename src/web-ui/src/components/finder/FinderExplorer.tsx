import { useState, useEffect, useCallback, useRef } from 'react'
import { FileListItem, api } from '../../api/client'
import {
  ContextMenu,
  useContextMenu,
  createCopyPathItem,
  createCopyRelativePathItem,
  createCopyFileNameItem,
  createNewFileItem,
  createNewFolderItem,
  createDeleteItem,
} from '../code-editor/ContextMenu'
import { AlertCircle, Check } from 'lucide-react'
import { FinderToolbar } from './FinderToolbar'
import { FinderListView } from './FinderListView'
import { FinderGridView } from './FinderGridView'
import { FinderStatusBar } from './FinderStatusBar'
import './finder.css'

interface FinderExplorerProps {
  projectPath: string
  encodedPath: string
  embedded?: boolean
}

const VIEW_MODE_KEY = 'orka-finder-view-mode'

export function FinderExplorer({ projectPath, encodedPath, embedded }: FinderExplorerProps) {
  const projectName = projectPath.split('/').pop() || projectPath

  // Navigation state
  const [currentPath, setCurrentPath] = useState('')
  const [history, setHistory] = useState<string[]>([''])
  const [historyIndex, setHistoryIndex] = useState(0)

  // Data
  const [items, setItems] = useState<FileListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // View
  const [viewMode, setViewMode] = useState<'list' | 'grid'>(() => {
    return (localStorage.getItem(VIEW_MODE_KEY) as 'list' | 'grid') || 'list'
  })
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())

  // Transition animation
  const [transitioning, setTransitioning] = useState(false)

  // Context menu
  const { contextMenu, hideContextMenu, handleContextMenu } = useContextMenu()

  // Toast
  const [toast, setToast] = useState<{ show: boolean; message: string }>({ show: false, message: '' })

  // Create file/folder modal
  const [createModal, setCreateModal] = useState<{
    show: boolean
    type: 'file' | 'directory'
    parentPath: string
  }>({ show: false, type: 'file', parentPath: '' })
  const [createName, setCreateName] = useState('')

  const containerRef = useRef<HTMLDivElement>(null)

  const showToast = useCallback((message: string) => {
    setToast({ show: true, message })
    setTimeout(() => setToast({ show: false, message: '' }), 2000)
  }, [])

  // Load directory listing
  const loadDirectory = useCallback(async (dirPath: string) => {
    try {
      setIsLoading(true)
      setError(null)
      const data = await api.listDirectory(encodedPath, dirPath)
      setItems(data.items)
    } catch (err: any) {
      setError(err.message || 'Failed to load directory')
      setItems([])
    } finally {
      setIsLoading(false)
    }
  }, [encodedPath])

  // Navigate to a directory
  const navigateTo = useCallback((dirPath: string) => {
    setTransitioning(true)
    setTimeout(() => {
      setCurrentPath(dirPath)
      setSelectedItems(new Set())
      // Push to history (trim forward history)
      setHistory(prev => {
        const newHistory = prev.slice(0, historyIndex + 1)
        newHistory.push(dirPath)
        return newHistory
      })
      setHistoryIndex(prev => prev + 1)
      setTransitioning(false)
    }, 100)
  }, [historyIndex])

  // Navigate via breadcrumb (direct, no history push duplication)
  const navigateDirect = useCallback((dirPath: string) => {
    if (dirPath === currentPath) return
    navigateTo(dirPath)
  }, [currentPath, navigateTo])

  // Back/Forward
  const goBack = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1
      setHistoryIndex(newIndex)
      setTransitioning(true)
      setTimeout(() => {
        setCurrentPath(history[newIndex])
        setSelectedItems(new Set())
        setTransitioning(false)
      }, 100)
    }
  }, [historyIndex, history])

  const goForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1
      setHistoryIndex(newIndex)
      setTransitioning(true)
      setTimeout(() => {
        setCurrentPath(history[newIndex])
        setSelectedItems(new Set())
        setTransitioning(false)
      }, 100)
    }
  }, [historyIndex, history])

  // Open an item (double click)
  const handleOpen = useCallback((item: FileListItem) => {
    if (item.type === 'directory') {
      navigateTo(item.path)
    } else {
      // Open file in new tab
      const viewUrl = `/projects/${encodedPath}/files/view?path=${encodeURIComponent(item.path)}`
      window.open(viewUrl, '_blank')
    }
  }, [navigateTo, encodedPath])

  // Select item (single click)
  const handleSelect = useCallback((path: string) => {
    setSelectedItems(new Set([path]))
  }, [])

  // Context menu for item
  const handleItemContextMenu = useCallback((e: React.MouseEvent, item: FileListItem) => {
    handleContextMenu(e, { path: item.path, isDirectory: item.type === 'directory' })
  }, [handleContextMenu])

  // Context menu for empty area
  const handleAreaContextMenu = useCallback((e: React.MouseEvent) => {
    handleContextMenu(e, { path: currentPath, isDirectory: true })
  }, [handleContextMenu, currentPath])

  // View mode
  const handleViewModeChange = useCallback((mode: 'list' | 'grid') => {
    setViewMode(mode)
    localStorage.setItem(VIEW_MODE_KEY, mode)
  }, [])

  // Create file/folder
  const handleNewFile = useCallback(() => {
    setCreateModal({ show: true, type: 'file', parentPath: currentPath })
    setCreateName('')
  }, [currentPath])

  const handleNewFolder = useCallback(() => {
    setCreateModal({ show: true, type: 'directory', parentPath: currentPath })
    setCreateName('')
  }, [currentPath])

  const handleCreateFile = async () => {
    if (!createName.trim()) return
    const newPath = createModal.parentPath
      ? `${createModal.parentPath}/${createName.trim()}`
      : createName.trim()
    try {
      await api.createFile(encodedPath, newPath, createModal.type)
      setCreateModal({ show: false, type: 'file', parentPath: '' })
      setCreateName('')
      await loadDirectory(currentPath)
      showToast(`${createModal.type === 'file' ? 'File' : 'Folder'} created`)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleDelete = async (path: string, isDirectory: boolean) => {
    const name = path.split('/').pop() || path
    if (!confirm(`Delete ${isDirectory ? 'folder' : 'file'} "${name}"?`)) return
    try {
      await api.deleteFile(encodedPath, path)
      await loadDirectory(currentPath)
      showToast(`${isDirectory ? 'Folder' : 'File'} deleted`)
      selectedItems.delete(path)
      setSelectedItems(new Set(selectedItems))
    } catch (err: any) {
      setError(err.message)
    }
  }

  // Build context menu items
  const buildContextMenuItems = useCallback((path: string, isDirectory: boolean) => {
    const fullPath = `${projectPath}/${path}`
    const items = [
      createCopyPathItem(fullPath, () => showToast('Path copied')),
      createCopyRelativePathItem(path, '', () => showToast('Relative path copied')),
      ...(!isDirectory ? [createCopyFileNameItem(path, () => showToast('File name copied'))] : []),
    ]
    if (isDirectory) {
      items.push(
        createNewFileItem(() => {
          setCreateModal({ show: true, type: 'file', parentPath: path })
          setCreateName('')
        }),
        createNewFolderItem(() => {
          setCreateModal({ show: true, type: 'directory', parentPath: path })
          setCreateName('')
        })
      )
    }
    items.push(createDeleteItem(() => handleDelete(path, isDirectory)))
    return items
  }, [projectPath, showToast])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (createModal.show) return

      if (e.key === 'Backspace' && historyIndex > 0) {
        e.preventDefault()
        goBack()
      }
      if (e.key === 'Enter' && selectedItems.size === 1) {
        const path = [...selectedItems][0]
        const item = items.find(i => i.path === path)
        if (item) handleOpen(item)
      }
    }

    const el = containerRef.current
    if (el) {
      el.addEventListener('keydown', handleKeyDown)
      return () => el.removeEventListener('keydown', handleKeyDown)
    }
  }, [historyIndex, goBack, selectedItems, items, handleOpen, createModal.show])

  // Load directory when path changes
  useEffect(() => {
    loadDirectory(currentPath)
  }, [currentPath, loadDirectory])

  // Render context menu
  const renderContextMenu = () => {
    if (!contextMenu.show || !contextMenu.data) return null
    const { path, isDirectory } = contextMenu.data
    const fileName = path.split('/').pop() || path || projectName
    return (
      <ContextMenu
        items={buildContextMenuItems(path, isDirectory)}
        position={contextMenu.position}
        onClose={hideContextMenu}
        title={fileName}
      />
    )
  }

  return (
    <div
      className={`finder-explorer ${embedded ? 'finder-embedded' : ''}`}
      ref={containerRef}
      tabIndex={0}
      onContextMenu={handleAreaContextMenu}
    >
      <FinderToolbar
        projectName={projectName}
        currentPath={currentPath}
        canGoBack={historyIndex > 0}
        canGoForward={historyIndex < history.length - 1}
        viewMode={viewMode}
        onNavigate={navigateDirect}
        onGoBack={goBack}
        onGoForward={goForward}
        onViewModeChange={handleViewModeChange}
        onNewFile={handleNewFile}
        onNewFolder={handleNewFolder}
      />

      <div className={`finder-content ${transitioning ? 'finder-transitioning' : ''}`}>
        {isLoading ? (
          <div className="finder-loading">
            <div className="spinner" />
            <span>Loading...</span>
          </div>
        ) : error ? (
          <div className="finder-error">
            <AlertCircle size={24} />
            <p>{error}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="finder-empty">
            <p>This folder is empty</p>
          </div>
        ) : viewMode === 'list' ? (
          <FinderListView
            items={items}
            selectedItems={selectedItems}
            onSelect={handleSelect}
            onOpen={handleOpen}
            onContextMenu={handleItemContextMenu}
          />
        ) : (
          <FinderGridView
            items={items}
            selectedItems={selectedItems}
            onSelect={handleSelect}
            onOpen={handleOpen}
            onContextMenu={handleItemContextMenu}
          />
        )}
      </div>

      <FinderStatusBar
        itemCount={items.length}
        selectedCount={selectedItems.size}
        currentPath={currentPath}
      />

      {renderContextMenu()}

      {/* Toast */}
      {toast.show && (
        <div className="copy-toast success">
          <Check size={16} className="toast-icon" />
          <span>{toast.message}</span>
        </div>
      )}

      {/* Create modal */}
      {createModal.show && (
        <div className="modal-overlay" onClick={() => setCreateModal({ show: false, type: 'file', parentPath: '' })}>
          <div className="create-file-modal" onClick={(e) => e.stopPropagation()}>
            <h3>New {createModal.type === 'file' ? 'File' : 'Folder'}</h3>
            <p className="modal-subtitle">
              In: <strong>{createModal.parentPath || '/'}</strong>
            </p>
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder={createModal.type === 'file' ? 'filename.ts' : 'folder-name'}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFile()
                if (e.key === 'Escape') setCreateModal({ show: false, type: 'file', parentPath: '' })
              }}
            />
            <div className="modal-buttons">
              <button
                className="button-secondary"
                onClick={() => setCreateModal({ show: false, type: 'file', parentPath: '' })}
              >
                Cancel
              </button>
              <button
                className="button-primary"
                onClick={handleCreateFile}
                disabled={!createName.trim()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
