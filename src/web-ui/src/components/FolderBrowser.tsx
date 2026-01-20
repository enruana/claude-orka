import { useState, useEffect, useCallback } from 'react'
import {
  Folder,
  FolderOpen,
  File,
  ChevronLeft,
  Home,
  Check,
  X,
  GitBranch,
} from 'lucide-react'

interface DirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface BrowseResult {
  currentPath: string
  parentPath: string | null
  entries: DirectoryEntry[]
  isGitRepo: boolean
  hasClaudeOrka: boolean
}

interface QuickAccessPath {
  name: string
  path: string
}

interface FolderBrowserProps {
  onSelect: (path: string) => void
  onCancel: () => void
}

export function FolderBrowser({ onSelect, onCancel }: FolderBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string>('')
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [quickAccess, setQuickAccess] = useState<QuickAccessPath[]>([])
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [hasClaudeOrka, setHasClaudeOrka] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  const loadDirectory = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse'
      const res = await fetch(url)
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to load directory')
      }
      const data: BrowseResult = await res.json()
      setCurrentPath(data.currentPath)
      setParentPath(data.parentPath)
      setEntries(data.entries)
      setIsGitRepo(data.isGitRepo)
      setHasClaudeOrka(data.hasClaudeOrka)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadQuickAccess = useCallback(async () => {
    try {
      const res = await fetch('/api/browse/quick-access')
      if (res.ok) {
        const data = await res.json()
        setQuickAccess(data)
      }
    } catch {
      // Ignore errors for quick access
    }
  }, [])

  useEffect(() => {
    loadDirectory()
    loadQuickAccess()
  }, [loadDirectory, loadQuickAccess])

  const handleEntryClick = (entry: DirectoryEntry) => {
    if (entry.isDirectory) {
      loadDirectory(entry.path)
    }
  }

  const handleGoUp = () => {
    if (parentPath) {
      loadDirectory(parentPath)
    }
  }

  const handleSelectCurrent = () => {
    onSelect(currentPath)
  }

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    // Try to get the path using File System Access API (experimental)
    const items = e.dataTransfer.items
    if (items && items.length > 0) {
      const item = items[0]

      // Check if getAsFileSystemHandle is available (Chrome/Edge)
      if ('getAsFileSystemHandle' in item) {
        try {
          const handle = await (item as any).getAsFileSystemHandle()
          if (handle && handle.kind === 'directory') {
            // Unfortunately, we can't get the full path from FileSystemHandle
            // We'll need to show a message to the user
            setError('Drag & drop detected a folder, but browser security prevents reading the full path. Please use the folder browser instead.')
            return
          }
        } catch {
          // Fall through to legacy method
        }
      }

      // Legacy method - can only get the folder name, not the path
      const file = item.getAsFile()
      if (file) {
        // For files dropped, we can try to use webkitRelativePath
        const relativePath = (file as any).webkitRelativePath
        if (relativePath) {
          const folderName = relativePath.split('/')[0]
          setError(`Folder "${folderName}" detected, but full path is not available. Please navigate to it using the browser above.`)
        }
      }
    }
  }

  return (
    <div
      className="folder-browser"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="browser-header">
        <h3>Select Project Folder</h3>
        <button className="close-btn" onClick={onCancel}>
          <X size={18} />
        </button>
      </div>

      {/* Quick Access */}
      <div className="quick-access">
        {quickAccess.map((qa) => (
          <button
            key={qa.path}
            className="quick-access-btn"
            onClick={() => loadDirectory(qa.path)}
          >
            {qa.name === 'Home' ? <Home size={14} /> : <Folder size={14} />}
            {qa.name}
          </button>
        ))}
      </div>

      {/* Current Path */}
      <div className="current-path">
        <button
          className="nav-btn"
          onClick={handleGoUp}
          disabled={!parentPath}
        >
          <ChevronLeft size={18} />
        </button>
        <span className="path-text">{currentPath}</span>
        {isGitRepo && (
          <span className="badge git">
            <GitBranch size={12} />
            Git
          </span>
        )}
        {hasClaudeOrka && (
          <span className="badge orka">Orka</span>
        )}
      </div>

      {/* Drop Zone Overlay */}
      {isDragging && (
        <div className="drop-overlay">
          <Folder size={48} />
          <p>Drop folder here</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="browser-error">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Directory Contents */}
      <div className="directory-contents">
        {loading ? (
          <div className="loading-state">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="empty-state">No folders found</div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.path}
              className={`entry ${entry.isDirectory ? 'directory' : 'file'}`}
              onClick={() => handleEntryClick(entry)}
            >
              {entry.isDirectory ? (
                <FolderOpen size={18} className="entry-icon" />
              ) : (
                <File size={18} className="entry-icon" />
              )}
              <span className="entry-name">{entry.name}</span>
            </div>
          ))
        )}
      </div>

      {/* Actions */}
      <div className="browser-actions">
        <button className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn-primary" onClick={handleSelectCurrent}>
          <Check size={16} />
          Select This Folder
        </button>
      </div>
    </div>
  )
}
