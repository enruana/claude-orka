import { useState, useEffect, useCallback } from 'react'
import { Save, GitBranch, RefreshCw, X, ExternalLink, Check } from 'lucide-react'
import { FileTree } from './FileTree'
import { EditorPane } from './EditorPane'
import { GitPanel } from './GitPanel'
import { DiffViewer } from './DiffViewer'
import {
  ContextMenu,
  useContextMenu,
  createCopyPathItem,
  createCopyRelativePathItem,
  createCopyFileNameItem
} from './ContextMenu'
import { api, FileTreeNode, GitStatus, GitDiff } from '../../api/client'
import './code-editor.css'

interface SessionCodeEditorProps {
  projectPath: string
  encodedPath: string
  onOpenInNewTab?: () => void
}

interface OpenTab {
  path: string
  name: string
  content: string
  isDirty: boolean
  originalContent: string
}

type ViewMode = 'editor' | 'diff'

export function SessionCodeEditor({ projectPath, encodedPath, onOpenInNewTab }: SessionCodeEditorProps) {
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([])
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [showGitPanel, setShowGitPanel] = useState(false)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('editor')
  const [diffData, setDiffData] = useState<GitDiff | null>(null)

  // Context menu state
  const { contextMenu, hideContextMenu, handleContextMenu, handleLongPress } = useContextMenu()

  // Toast notification state
  const [toast, setToast] = useState<{ show: boolean; message: string }>({ show: false, message: '' })

  // Show toast notification
  const showToast = useCallback((message: string) => {
    setToast({ show: true, message })
    setTimeout(() => setToast({ show: false, message: '' }), 2000)
  }, [])

  // Build context menu items for a path - must be before any early returns
  const buildContextMenuItems = useCallback((path: string, isDirectory: boolean) => {
    const fullPath = `${projectPath}/${path}`

    return [
      createCopyPathItem(fullPath, () => showToast('Path copied')),
      createCopyRelativePathItem(path, '', () => showToast('Relative path copied')),
      ...(!isDirectory ? [createCopyFileNameItem(path, () => showToast('File name copied'))] : []),
    ]
  }, [projectPath, showToast])

  // Handle context menu (right click)
  const handleTreeContextMenu = useCallback((e: React.MouseEvent, path: string, isDirectory: boolean) => {
    handleContextMenu(e, { path, isDirectory })
  }, [handleContextMenu])

  // Handle long press (mobile)
  const handleTreeLongPress = useCallback((e: React.TouchEvent | React.MouseEvent, path: string, isDirectory: boolean) => {
    handleLongPress(e, { path, isDirectory })
  }, [handleLongPress])

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
      setGitStatus(null)
    }
  }, [encodedPath])

  // Initial load
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      await Promise.all([loadFileTree(), loadGitStatus()])
      setLoading(false)
    }
    load()
  }, [loadFileTree, loadGitStatus])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTab, openTabs])

  // Open a file
  const handleFileSelect = async (filePath: string) => {
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
      await loadGitStatus()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  // Refresh everything
  const handleRefresh = async () => {
    setLoading(true)
    await Promise.all([loadFileTree(), loadGitStatus()])
    setLoading(false)
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
      <div className="session-code-editor-loading">
        <div className="spinner-small" />
        <span>Loading...</span>
      </div>
    )
  }

  return (
    <div className="session-code-editor">
      {/* Toolbar */}
      <div className="session-code-toolbar">
        <div className="toolbar-left">
          <button
            className="toolbar-btn"
            onClick={handleSave}
            disabled={!activeTabData?.isDirty || saving}
            title="Save (Cmd+S)"
          >
            <Save size={14} />
          </button>
          <button
            className={`toolbar-btn ${showGitPanel ? 'active' : ''}`}
            onClick={() => setShowGitPanel(!showGitPanel)}
            title="Toggle Git Panel"
          >
            <GitBranch size={14} />
            {gitStatus && gitStatus.changes.length > 0 && (
              <span className="git-badge">{gitStatus.changes.length}</span>
            )}
          </button>
          <button className="toolbar-btn" onClick={handleRefresh} title="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>
        {onOpenInNewTab && (
          <button className="toolbar-btn" onClick={onOpenInNewTab} title="Open in new tab">
            <ExternalLink size={14} />
          </button>
        )}
      </div>

      {/* Error Banner */}
      {error && (
        <div className="session-code-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* Main Content */}
      <div className="session-code-content">
        {/* File Tree */}
        <div className="session-code-sidebar">
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
          />
        </div>

        {/* Editor Area */}
        <div className="session-code-main">
          {/* Tabs */}
          {openTabs.length > 0 && (
            <div className="session-code-tabs">
              {openTabs.map(tab => (
                <div
                  key={tab.path}
                  className={`session-code-tab ${activeTab === tab.path ? 'active' : ''} ${tab.isDirty ? 'dirty' : ''}`}
                  onClick={() => {
                    setActiveTab(tab.path)
                    setViewMode('editor')
                  }}
                >
                  <span className="tab-name">{tab.name}</span>
                  {tab.isDirty && <span className="dirty-dot" />}
                  <button
                    className="tab-close-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleCloseTab(tab.path)
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Editor/Diff View */}
          <div className="session-code-editor-view">
            {viewMode === 'editor' ? (
              activeTabData ? (
                <EditorPane
                  content={activeTabData.content}
                  filePath={activeTabData.path}
                  onChange={handleContentChange}
                />
              ) : (
                <div className="session-code-placeholder">
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
        </div>

        {/* Git Panel */}
        {showGitPanel && gitStatus && (
          <div className="session-code-git">
            <GitPanel
              status={gitStatus}
              onStage={handleStage}
              onUnstage={handleUnstage}
              onCommit={handleCommit}
              onViewDiff={handleViewDiff}
              onRefresh={loadGitStatus}
              onGenerateMessage={handleGenerateMessage}
            />
          </div>
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
