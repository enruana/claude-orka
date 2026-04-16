import { useState, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronDown, ChevronUp, Save, GitBranch, RefreshCw, X, FolderOpen, Undo2, Check, Search } from 'lucide-react'
import { FileTree } from './FileTree'
import { EditorPane } from './EditorPane'
import { GitPanel } from './GitPanel'
import { DiffViewer } from './DiffViewer'
import { SearchPanel } from './SearchPanel'
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
  createOpenInFilesItem,
  createOpenInViewerItem,
} from './ContextMenu'
import { useNavigate } from 'react-router-dom'
import { api, FileTreeNode, GitStatus, GitDiff, ProjectComment } from '../../api/client'
import { AddCommentDialog } from '../AddCommentDialog'
import { usePageTitle } from '../../hooks/usePageTitle'
import './code-editor.css'

interface CodeEditorViewProps {
  projectPath: string
  encodedPath: string
  onBack: () => void
  /** File to auto-open on mount (relative path) */
  initialFile?: string
}

interface OpenTab {
  path: string
  name: string
  content: string
  isDirty: boolean
  originalContent: string
}

type ViewMode = 'editor' | 'diff'

// Detect mobile device
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const checkMobile = () => {
      const mobileQuery = window.matchMedia('(max-width: 768px)')
      const touchQuery = window.matchMedia('(pointer: coarse)')
      setIsMobile(mobileQuery.matches || touchQuery.matches)
    }

    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  return isMobile
}

export function CodeEditorView({ projectPath, encodedPath, onBack, initialFile }: CodeEditorViewProps) {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([])
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)

  const projectName = projectPath.split('/').pop() || projectPath
  const activeFileName = activeTab ? activeTab.split('/').pop() : null
  const activeTabDirty = activeTab ? openTabs.find(t => t.path === activeTab)?.isDirty : false
  usePageTitle(projectName, activeFileName ? `${activeFileName}${activeTabDirty ? '*' : ''}` : 'Code')
  const [showGitPanel, setShowGitPanel] = useState(true)
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false)
  const [gitPanelCollapsed, setGitPanelCollapsed] = useState(false)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('editor')
  const [diffData, setDiffData] = useState<GitDiff | null>(null)
  const [sidebarMode, setSidebarMode] = useState<'files' | 'search'>('files')
  const [goToLine, setGoToLine] = useState<{ line: number; column?: number } | null>(null)

  // Comments state
  const [comments, setComments] = useState<ProjectComment[]>([])
  const [commentDialog, setCommentDialog] = useState<{
    show: boolean
    startLine: number
    endLine: number
    selectedText: string
  } | null>(null)

  // Context menu state
  const { contextMenu, hideContextMenu, handleContextMenu, handleLongPress } = useContextMenu()

  // Toast notification state
  const [toast, setToast] = useState<{ show: boolean; message: string }>({ show: false, message: '' })

  // Create file/folder modal state
  const [createModal, setCreateModal] = useState<{
    show: boolean
    type: 'file' | 'directory'
    parentPath: string
  }>({ show: false, type: 'file', parentPath: '' })
  const [createName, setCreateName] = useState('')

  // Rename modal state
  const [renameModal, setRenameModal] = useState<{
    show: boolean
    path: string
    isDirectory: boolean
  }>({ show: false, path: '', isDirectory: false })
  const [renameName, setRenameName] = useState('')

  // Show toast notification
  const showToast = useCallback((message: string) => {
    setToast({ show: true, message })
    setTimeout(() => setToast({ show: false, message: '' }), 2000)
  }, [])

  // Load file tree
  const loadFileTree = useCallback(async () => {
    try {
      const tree = await api.getFileTree(encodedPath)
      setFileTree(tree)
    } catch (err: any) {
      setError(err.message)
    }
  }, [encodedPath])

  // Load git status
  const loadGitStatus = useCallback(async () => {
    try {
      const status = await api.getGitStatus(encodedPath)
      setGitStatus(status)
    } catch (err: any) {
      // Not a git repo is fine
      setGitStatus(null)
    }
  }, [encodedPath])

  // Handle drag-drop move
  const handleMoveFile = useCallback(async (fromPath: string, toDirectory: string) => {
    const fileName = fromPath.split('/').pop() || fromPath
    const fromParent = fromPath.includes('/') ? fromPath.substring(0, fromPath.lastIndexOf('/')) : ''
    if (fromParent === toDirectory) return
    const destPath = toDirectory ? `${toDirectory}/${fileName}` : fileName
    try {
      await api.moveFile(encodedPath, fromPath, destPath)
      await loadFileTree()
      showToast(`Moved "${fileName}"`)
    } catch (err: any) {
      showToast(err.message || 'Move failed')
    }
  }, [encodedPath, loadFileTree, showToast])

  // Handle creating a new file or folder
  const handleCreateFile = async () => {
    if (!createName.trim()) return

    const newPath = createModal.parentPath
      ? `${createModal.parentPath}/${createName.trim()}`
      : createName.trim()

    try {
      await api.createFile(encodedPath, newPath, createModal.type)
      setCreateModal({ show: false, type: 'file', parentPath: '' })
      setCreateName('')
      await loadFileTree()
      showToast(`${createModal.type === 'file' ? 'File' : 'Folder'} created`)

      // If it's a file, open it
      if (createModal.type === 'file') {
        handleFileSelect(newPath)
      }
    } catch (err: any) {
      setError(err.message)
    }
  }

  // Open rename modal
  const openRenameModal = (path: string, isDirectory: boolean) => {
    const name = path.split('/').pop() || path
    setRenameModal({ show: true, path, isDirectory })
    setRenameName(name)
  }

  // Execute rename via moveFile
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
      await loadFileTree()
      showToast(`Renamed to "${newName}"`)
      // Update open tab if it was the renamed file
      if (!renameModal.isDirectory) {
        setOpenTabs(prev => prev.map(t =>
          t.path === oldPath ? { ...t, path: newPath, name: newName } : t
        ))
        if (activeTab === oldPath) setActiveTab(newPath)
      }
    } catch (err: any) {
      setError(err.message || 'Rename failed')
    }
  }

  // Handle deleting a file or folder
  const handleDelete = async (path: string, isDirectory: boolean) => {
    const name = path.split('/').pop() || path
    if (!confirm(`Delete ${isDirectory ? 'folder' : 'file'} "${name}"?`)) return

    try {
      await api.deleteFile(encodedPath, path)
      await loadFileTree()
      showToast(`${isDirectory ? 'Folder' : 'File'} deleted`)

      // Close tab if open
      if (!isDirectory) {
        setOpenTabs(prev => prev.filter(t => t.path !== path))
        if (activeTab === path) {
          const remaining = openTabs.filter(t => t.path !== path)
          setActiveTab(remaining.length > 0 ? remaining[remaining.length - 1].path : null)
        }
      }
    } catch (err: any) {
      setError(err.message)
    }
  }

  // Build context menu items for a path
  const buildContextMenuItems = useCallback((path: string, isDirectory: boolean) => {
    const fullPath = `${projectPath}/${path}`

    // File-only actions
    const viewerItem = !isDirectory
      ? createOpenInViewerItem(() => {
          navigate(`/projects/${encodedPath}/files/view?path=${encodeURIComponent(path)}`)
        })
      : null
    const previewItem = !isDirectory ? createPreviewHtmlItem(projectPath, path) : null

    // "Reveal in Files" — for files, navigate to their parent dir in Finder.
    // For directories, navigate directly to that dir.
    const revealItem = createOpenInFilesItem(() => {
      const targetPath = isDirectory
        ? path
        : (path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '')
      const qs = targetPath ? `?path=${encodeURIComponent(targetPath)}` : ''
      navigate(`/projects/${encodedPath}/files${qs}`)
    })

    const items = [
      ...(viewerItem ? [viewerItem] : []),
      ...(previewItem ? [previewItem] : []),
      revealItem,
      createCopyPathItem(fullPath, () => showToast('Path copied')),
      createCopyRelativePathItem(path, '', () => showToast('Relative path copied')),
      ...(!isDirectory ? [createCopyFileNameItem(path, () => showToast('File name copied'))] : []),
    ]

    // Add create options for directories
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

    // Rename + delete
    items.push(createRenameItem(() => openRenameModal(path, isDirectory)))
    items.push(createDeleteItem(() => handleDelete(path, isDirectory)))

    return items
  }, [projectPath, showToast, encodedPath, navigate])

  // Handle context menu (right click)
  const handleTreeContextMenu = useCallback((e: React.MouseEvent, path: string, isDirectory: boolean) => {
    handleContextMenu(e, { path, isDirectory })
  }, [handleContextMenu])

  // Handle long press (mobile)
  const handleTreeLongPress = useCallback((e: React.TouchEvent | React.MouseEvent, path: string, isDirectory: boolean) => {
    handleLongPress(e, { path, isDirectory })
  }, [handleLongPress])

  // Fetch comments
  const fetchComments = useCallback(async () => {
    try {
      const data = await api.listComments(projectPath)
      setComments(data)
    } catch {
      // Ignore - comments are optional
    }
  }, [projectPath])

  // Initial load
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      await Promise.all([loadFileTree(), loadGitStatus(), fetchComments()])
      setLoading(false)
    }
    load()
  }, [loadFileTree, loadGitStatus, fetchComments])

  // Auto-open initialFile from URL query param (set when navigating here
  // from the Files tab context menu "Open in Code Editor").
  useEffect(() => {
    if (initialFile) {
      handleFileSelect(initialFile)
    }
  }, [initialFile]) // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for navigate-to-comment events from CommentWidget
  useEffect(() => {
    const handler = (e: Event) => {
      const { filePath: commentFile, startLine } = (e as CustomEvent).detail
      // Open the file if not already open
      handleFileSelect(commentFile)
      // Go to line after a brief delay to allow the file to load
      setTimeout(() => setGoToLine({ line: startLine }), 200)
    }
    window.addEventListener('orka-navigate-to-comment', handler)
    return () => window.removeEventListener('orka-navigate-to-comment', handler)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
        e.preventDefault()
        setSidebarMode(prev => prev === 'search' ? 'files' : 'search')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTab, openTabs])

  // Open a file
  const handleFileSelect = async (filePath: string) => {
    // Check if already open
    const existing = openTabs.find(t => t.path === filePath)
    if (existing) {
      setActiveTab(filePath)
      setViewMode('editor')
      return
    }

    try {
      const { content } = await api.getFileContent(encodedPath, filePath)
      const name = filePath.split('/').pop() || filePath

      setOpenTabs(prev => [...prev, {
        path: filePath,
        name,
        content,
        isDirty: false,
        originalContent: content,
      }])
      setActiveTab(filePath)
      setViewMode('editor')
    } catch (err: any) {
      setError(err.message)
    }
  }

  // Close a tab
  const handleCloseTab = (filePath: string) => {
    const tab = openTabs.find(t => t.path === filePath)
    if (tab?.isDirty) {
      if (!confirm('You have unsaved changes. Close anyway?')) {
        return
      }
    }

    setOpenTabs(prev => prev.filter(t => t.path !== filePath))
    if (activeTab === filePath) {
      const remaining = openTabs.filter(t => t.path !== filePath)
      setActiveTab(remaining.length > 0 ? remaining[remaining.length - 1].path : null)
    }
  }

  // Update content
  const handleContentChange = (content: string) => {
    if (!activeTab) return

    setOpenTabs(prev => prev.map(tab => {
      if (tab.path === activeTab) {
        return {
          ...tab,
          content,
          isDirty: content !== tab.originalContent,
        }
      }
      return tab
    }))
  }

  // Save file
  const handleSave = async () => {
    if (!activeTab) return

    const tab = openTabs.find(t => t.path === activeTab)
    if (!tab || !tab.isDirty) return

    setSaving(true)
    try {
      await api.saveFileContent(encodedPath, tab.path, tab.content)
      setOpenTabs(prev => prev.map(t => {
        if (t.path === activeTab) {
          return { ...t, isDirty: false, originalContent: t.content }
        }
        return t
      }))
      // Refresh git status after save
      await loadGitStatus()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  // Discard changes
  const handleDiscard = () => {
    if (!activeTab) return

    const tab = openTabs.find(t => t.path === activeTab)
    if (!tab || !tab.isDirty) return

    if (!confirm('Discard all changes to this file?')) return

    setOpenTabs(prev => prev.map(t => {
      if (t.path === activeTab) {
        return { ...t, content: t.originalContent, isDirty: false }
      }
      return t
    }))
  }

  // Refresh everything
  const handleRefresh = async () => {
    setLoading(true)
    await Promise.all([loadFileTree(), loadGitStatus()])
    setLoading(false)
  }

  // Handle search result click - open file and go to line
  const handleSearchResultClick = async (filePath: string, line: number) => {
    await handleFileSelect(filePath)
    // Use a new object each time so useEffect fires even for same line
    setGoToLine({ line })
    setViewMode('editor')
  }

  // View diff for a file
  const handleViewDiff = async (filePath: string, staged: boolean) => {
    try {
      const diff = await api.getGitDiff(encodedPath, filePath, staged)
      setDiffData(diff)
      setViewMode('diff')
    } catch (err: any) {
      setError(err.message)
    }
  }

  // Stage/unstage files
  const handleStage = async (paths: string[]) => {
    try {
      await api.gitStage(encodedPath, paths)
      await loadGitStatus()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleUnstage = async (paths: string[]) => {
    try {
      await api.gitUnstage(encodedPath, paths)
      await loadGitStatus()
    } catch (err: any) {
      setError(err.message)
    }
  }

  // Commit
  const handleCommit = async (message: string) => {
    try {
      await api.gitCommit(encodedPath, message)
      await loadGitStatus()
    } catch (err: any) {
      setError(err.message)
    }
  }

  // Generate commit message with AI
  const handleGenerateMessage = async () => {
    return await api.generateCommitMessage(encodedPath)
  }

  const activeTabData = openTabs.find(t => t.path === activeTab)

  if (loading) {
    return (
      <div className="code-editor-loading">
        <div className="spinner" />
        <p>Loading project...</p>
      </div>
    )
  }

  return (
    <div className="code-editor-container">
      {/* Header */}
      <header className="code-editor-header">
        <div className="header-left">
          <button className="icon-button" onClick={onBack} title="Back to project">
            <ChevronLeft size={20} />
          </button>
          <div className="project-info">
            <FolderOpen size={16} />
            <span className="project-name">{projectName}</span>
          </div>
        </div>

        <div className="header-right">
          <button
            className="icon-button"
            onClick={handleDiscard}
            disabled={!activeTabData?.isDirty}
            title="Discard changes"
          >
            <Undo2 size={18} />
          </button>
          <button
            className="icon-button"
            onClick={handleSave}
            disabled={!activeTabData?.isDirty || saving}
            title="Save (Cmd+S)"
          >
            <Save size={18} />
          </button>
          <button
            className={`icon-button ${showGitPanel ? 'active' : ''}`}
            onClick={() => setShowGitPanel(!showGitPanel)}
            title="Toggle Git Panel"
          >
            <GitBranch size={18} />
          </button>
          <button className="icon-button" onClick={handleRefresh} title="Refresh">
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      {/* Error Banner */}
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Main Content */}
      <div className="code-editor-content">
        {/* Sidebar */}
        <aside className={`file-tree-panel ${isMobile && fileTreeCollapsed ? 'collapsed' : ''}`}>
          {isMobile && (
            <div
              className="collapsible-header"
              onClick={() => setFileTreeCollapsed(!fileTreeCollapsed)}
            >
              <FolderOpen size={14} />
              <span>Files</span>
              {fileTreeCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </div>
          )}
          {(!isMobile || !fileTreeCollapsed) && (
            <>
              <div className="sidebar-tabs">
                <button
                  className={`sidebar-tab ${sidebarMode === 'files' ? 'active' : ''}`}
                  onClick={() => setSidebarMode('files')}
                >
                  <FolderOpen size={14} />
                  <span>Files</span>
                </button>
                <button
                  className={`sidebar-tab ${sidebarMode === 'search' ? 'active' : ''}`}
                  onClick={() => setSidebarMode('search')}
                >
                  <Search size={14} />
                  <span>Search</span>
                </button>
              </div>
              {sidebarMode === 'files' ? (
                <FileTree
                  tree={fileTree}
                  selectedFile={activeTab}
                  onFileSelect={handleFileSelect}
                  gitStatus={gitStatus}
                  onExpandDirectory={async (dirPath) => {
                    const children = await api.expandFileTree(encodedPath, dirPath)
                    setFileTree(prev => updateTreeWithChildren(prev, dirPath, children))
                  }}
                  onContextMenu={handleTreeContextMenu}
                  onLongPress={handleTreeLongPress}
                  onMoveFile={handleMoveFile}
                />
              ) : (
                <SearchPanel
                  encodedPath={encodedPath}
                  onResultClick={handleSearchResultClick}
                />
              )}
            </>
          )}
        </aside>

        {/* Editor Area */}
        <main className="editor-main">
          {/* Tabs */}
          {openTabs.length > 0 && (
            <div className="editor-tabs">
              {openTabs.map(tab => (
                <div
                  key={tab.path}
                  className={`editor-tab ${activeTab === tab.path ? 'active' : ''} ${tab.isDirty ? 'dirty' : ''}`}
                  onClick={() => {
                    setActiveTab(tab.path)
                    setViewMode('editor')
                  }}
                >
                  <span className="tab-name">{tab.name}</span>
                  {tab.isDirty && <span className="dirty-indicator" />}
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleCloseTab(tab.path)
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Editor/Diff View */}
          <div className="editor-view">
            {viewMode === 'editor' ? (
              activeTabData ? (
                <EditorPane
                  content={activeTabData.content}
                  filePath={activeTabData.path}
                  onChange={handleContentChange}
                  goToLine={goToLine}
                  comments={comments.filter(c => c.filePath === activeTab)}
                  onAddComment={(data) => setCommentDialog({ show: true, ...data })}
                />
              ) : (
                <div className="editor-placeholder">
                  <FolderOpen size={48} />
                  <p>Select a file to edit</p>
                </div>
              )
            ) : (
              diffData && (
                <DiffViewer
                  original={diffData.original}
                  modified={diffData.modified}
                  filePath={diffData.path}
                  onClose={() => setViewMode('editor')}
                />
              )
            )}
          </div>
        </main>

        {/* Git Panel */}
        {showGitPanel && gitStatus && (
          <aside className={`git-panel ${isMobile && gitPanelCollapsed ? 'collapsed' : ''}`}>
            {isMobile && (
              <div
                className="collapsible-header"
                onClick={() => setGitPanelCollapsed(!gitPanelCollapsed)}
              >
                <GitBranch size={14} />
                <span>Git</span>
                <span className="collapsible-badge">
                  {(gitStatus.staged?.length || 0) + (gitStatus.unstaged?.length || 0)}
                </span>
                {gitPanelCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </div>
            )}
            {(!isMobile || !gitPanelCollapsed) && (
              <GitPanel
                status={gitStatus}
                onStage={handleStage}
                onUnstage={handleUnstage}
                onCommit={handleCommit}
                onViewDiff={handleViewDiff}
                onRefresh={loadGitStatus}
                onGenerateMessage={handleGenerateMessage}
              />
            )}
          </aside>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu.show && contextMenu.data && (
        <ContextMenu
          items={buildContextMenuItems(contextMenu.data.path, contextMenu.data.isDirectory)}
          position={contextMenu.position}
          onClose={hideContextMenu}
          title={contextMenu.data.path.split('/').pop() || contextMenu.data.path}
        />
      )}

      {/* Toast Notification */}
      {toast.show && (
        <div className="copy-toast success">
          <Check size={16} className="toast-icon" />
          <span>{toast.message}</span>
        </div>
      )}

      {/* Create File/Folder Modal */}
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

      {/* Rename Modal */}
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

      {/* Add Comment Dialog */}
      {commentDialog && activeTab && (
        <AddCommentDialog
          filePath={activeTab}
          startLine={commentDialog.startLine}
          endLine={commentDialog.endLine}
          selectedText={commentDialog.selectedText}
          onSave={async (body) => {
            try {
              await api.createComment(projectPath, {
                filePath: activeTab,
                startLine: commentDialog.startLine,
                endLine: commentDialog.endLine,
                selectedText: commentDialog.selectedText,
                body,
              })
              setCommentDialog(null)
              await fetchComments()
            } catch (err: any) {
              console.error('Failed to create comment:', err)
            }
          }}
          onCancel={() => setCommentDialog(null)}
        />
      )}
    </div>
  )
}

// Helper to update tree with lazy-loaded children
function updateTreeWithChildren(
  tree: FileTreeNode[],
  targetPath: string,
  children: FileTreeNode[]
): FileTreeNode[] {
  return tree.map(node => {
    if (node.path === targetPath && node.type === 'directory') {
      return { ...node, children }
    }
    if (node.type === 'directory' && node.children) {
      return {
        ...node,
        children: updateTreeWithChildren(node.children, targetPath, children),
      }
    }
    return node
  })
}
