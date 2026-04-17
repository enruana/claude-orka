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
  createRenameItem,
  createPreviewHtmlItem,
  createOpenInCodeItem,
  createDownloadItem,
} from '../code-editor/ContextMenu'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Check, Upload } from 'lucide-react'
import { FinderToolbar } from './FinderToolbar'
import { FinderListView } from './FinderListView'
import { FinderGridView } from './FinderGridView'
import { FinderStatusBar } from './FinderStatusBar'
import './finder.css'

interface FinderExplorerProps {
  projectPath: string
  encodedPath: string
  embedded?: boolean
  /** Directory path to navigate to on mount (relative to project root) */
  initialPath?: string
}

const VIEW_MODE_KEY = 'orka-finder-view-mode'

export function FinderExplorer({ projectPath, encodedPath, embedded, initialPath }: FinderExplorerProps) {
  const projectName = projectPath.split('/').pop() || projectPath
  const navigate = useNavigate()

  // Navigation state — start at initialPath if provided
  const [currentPath, setCurrentPath] = useState(initialPath || '')
  const [history, setHistory] = useState<string[]>([initialPath || ''])
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

  // Rename modal
  const [renameModal, setRenameModal] = useState<{
    show: boolean
    path: string
    isDirectory: boolean
  }>({ show: false, path: '', isDirectory: false })
  const [renameName, setRenameName] = useState('')

  const containerRef = useRef<HTMLDivElement>(null)

  // External file drop state
  const [isDraggingExternal, setIsDraggingExternal] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const dragCounter = useRef(0)

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

  // Move file/folder via drag & drop
  const handleMoveFile = useCallback(async (fromPath: string, toDirectory: string) => {
    const fileName = fromPath.split('/').pop() || fromPath
    const fromParent = fromPath.includes('/') ? fromPath.substring(0, fromPath.lastIndexOf('/')) : ''
    // No-op if dropping into same parent
    if (fromParent === toDirectory) return
    const destPath = toDirectory ? `${toDirectory}/${fileName}` : fileName
    try {
      await api.moveFile(encodedPath, fromPath, destPath)
      await loadDirectory(currentPath)
      showToast(`Moved "${fileName}"`)
    } catch (err: any) {
      showToast(err.message || 'Move failed')
    }
  }, [encodedPath, currentPath, loadDirectory, showToast])

  // Upload external files to a directory
  const handleUploadFiles = useCallback(async (files: File[], destination: string) => {
    if (files.length === 0) return
    setIsUploading(true)
    try {
      const result = await api.uploadFiles(encodedPath, files, destination)
      await loadDirectory(currentPath)
      const count = result.uploaded.length
      showToast(`Uploaded ${count} file${count !== 1 ? 's' : ''}`)
    } catch (err: any) {
      showToast(err.message || 'Upload failed')
    } finally {
      setIsUploading(false)
    }
  }, [encodedPath, currentPath, loadDirectory, showToast])

  // Detect if drag contains external files (from OS)
  const hasExternalFiles = useCallback((e: React.DragEvent) => {
    return e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('text/x-orka-path')
  }, [])

  // Track drag enter/leave for the whole explorer (for overlay)
  const handleExplorerDragEnter = useCallback((e: React.DragEvent) => {
    if (hasExternalFiles(e)) {
      e.preventDefault()
      dragCounter.current++
      if (dragCounter.current === 1) {
        setIsDraggingExternal(true)
      }
    }
  }, [hasExternalFiles])

  const handleExplorerDragLeave = useCallback((e: React.DragEvent) => {
    if (hasExternalFiles(e)) {
      dragCounter.current--
      if (dragCounter.current === 0) {
        setIsDraggingExternal(false)
      }
    }
  }, [hasExternalFiles])

  // Drop on content background = drop into current directory
  const handleContentDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('text/x-orka-path') || hasExternalFiles(e)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = hasExternalFiles(e) ? 'copy' : 'move'
    }
  }, [hasExternalFiles])

  const handleContentDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current = 0
    setIsDraggingExternal(false)

    // External file drop
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const fromPath = e.dataTransfer.getData('text/x-orka-path')
      if (!fromPath) {
        // External files from OS
        const files = Array.from(e.dataTransfer.files)
        handleUploadFiles(files, currentPath)
        return
      }
    }

    // Internal file move
    const fromPath = e.dataTransfer.getData('text/x-orka-path')
    if (fromPath) {
      handleMoveFile(fromPath, currentPath)
    }
  }, [handleMoveFile, handleUploadFiles, currentPath])

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

  const openRenameModal = (path: string, isDirectory: boolean) => {
    const name = path.split('/').pop() || path
    setRenameModal({ show: true, path, isDirectory })
    setRenameName(name)
  }

  const handleRename = async () => {
    const newName = renameName.trim()
    if (!newName) return
    const oldPath = renameModal.path
    const oldName = oldPath.split('/').pop() || oldPath
    if (newName === oldName) {
      setRenameModal({ show: false, path: '', isDirectory: false })
      setRenameName('')
      return
    }
    if (newName.includes('/')) {
      showToast('Name cannot contain "/"')
      return
    }
    const parent = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/')) : ''
    const newPath = parent ? `${parent}/${newName}` : newName
    try {
      await api.moveFile(encodedPath, oldPath, newPath)
      setRenameModal({ show: false, path: '', isDirectory: false })
      setRenameName('')
      await loadDirectory(currentPath)
      showToast(`Renamed to "${newName}"`)
    } catch (err: any) {
      setError(err.message || 'Rename failed')
    }
  }

  // Build context menu items
  const buildContextMenuItems = useCallback((path: string, isDirectory: boolean) => {
    const fullPath = `${projectPath}/${path}`
    const previewItem = !isDirectory ? createPreviewHtmlItem(projectPath, path) : null
    // "Open in Code Editor" only makes sense for files (not directories)
    const openInCode = !isDirectory
      ? createOpenInCodeItem(() => {
          navigate(`/projects/${encodedPath}/code?file=${encodeURIComponent(path)}`)
        })
      : null
    const items = [
      ...(openInCode ? [openInCode] : []),
      ...(previewItem ? [previewItem] : []),
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
    items.push(createDownloadItem(encodedPath, path, isDirectory))
    items.push(createRenameItem(() => openRenameModal(path, isDirectory)))
    items.push(createDeleteItem(() => handleDelete(path, isDirectory)))
    return items
  }, [projectPath, encodedPath, showToast])

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
      onDragEnter={handleExplorerDragEnter}
      onDragLeave={handleExplorerDragLeave}
      onDragOver={handleContentDragOver}
      onDrop={handleContentDrop}
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

      <div
        className={`finder-content ${transitioning ? 'finder-transitioning' : ''}`}
      >
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
            onMoveFile={handleMoveFile}
            onUploadFiles={handleUploadFiles}
          />
        ) : (
          <FinderGridView
            items={items}
            selectedItems={selectedItems}
            onSelect={handleSelect}
            onOpen={handleOpen}
            onContextMenu={handleItemContextMenu}
            onMoveFile={handleMoveFile}
            onUploadFiles={handleUploadFiles}
          />
        )}
      </div>

      {/* Drop overlay for external files */}
      {isDraggingExternal && (
        <div className="finder-drop-overlay">
          <div className="finder-drop-overlay-content">
            <Upload size={40} />
            <p>Drop files to upload</p>
            <span>Files will be saved to <strong>{currentPath || '/'}</strong></span>
          </div>
        </div>
      )}

      {/* Upload progress indicator */}
      {isUploading && (
        <div className="finder-upload-indicator">
          <div className="spinner" />
          <span>Uploading...</span>
        </div>
      )}

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

      {/* Rename modal */}
      {renameModal.show && (
        <div
          className="modal-overlay"
          onClick={() => { setRenameModal({ show: false, path: '', isDirectory: false }); setRenameName('') }}
        >
          <div className="create-file-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Rename {renameModal.isDirectory ? 'folder' : 'file'}</h3>
            <p className="modal-subtitle">
              Path: <strong>{renameModal.path}</strong>
            </p>
            <input
              type="text"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              autoFocus
              onFocus={(e) => {
                const name = e.target.value
                const dot = name.lastIndexOf('.')
                const end = dot > 0 ? dot : name.length
                e.target.setSelectionRange(0, end)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename()
                if (e.key === 'Escape') {
                  setRenameModal({ show: false, path: '', isDirectory: false })
                  setRenameName('')
                }
              }}
            />
            <div className="modal-buttons">
              <button
                className="button-secondary"
                onClick={() => { setRenameModal({ show: false, path: '', isDirectory: false }); setRenameName('') }}
              >
                Cancel
              </button>
              <button
                className="button-primary"
                onClick={handleRename}
                disabled={!renameName.trim()}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
