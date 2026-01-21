import { useState, useEffect, useCallback } from 'react'
import { ChevronLeft, Save, GitBranch, RefreshCw, X, FolderOpen } from 'lucide-react'
import { FileTree } from './FileTree'
import { EditorPane } from './EditorPane'
import { GitPanel } from './GitPanel'
import { DiffViewer } from './DiffViewer'
import { api, FileTreeNode, GitStatus, GitDiff } from '../../api/client'
import './code-editor.css'

interface CodeEditorViewProps {
  projectPath: string
  encodedPath: string
  onBack: () => void
}

interface OpenTab {
  path: string
  name: string
  content: string
  isDirty: boolean
  originalContent: string
}

type ViewMode = 'editor' | 'diff'

export function CodeEditorView({ projectPath, encodedPath, onBack }: CodeEditorViewProps) {
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([])
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [showGitPanel, setShowGitPanel] = useState(true)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('editor')
  const [diffData, setDiffData] = useState<GitDiff | null>(null)

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

  const activeTabData = openTabs.find(t => t.path === activeTab)
  const projectName = projectPath.split('/').pop() || projectPath

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
        {/* File Tree */}
        <aside className="file-tree-panel">
          <FileTree
            tree={fileTree}
            selectedFile={activeTab}
            onFileSelect={handleFileSelect}
            gitStatus={gitStatus}
            onExpandDirectory={async (dirPath) => {
              // Lazy load directory children
              const children = await api.expandFileTree(encodedPath, dirPath)
              // Update tree with new children
              setFileTree(prev => updateTreeWithChildren(prev, dirPath, children))
            }}
          />
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
          <aside className="git-panel">
            <GitPanel
              status={gitStatus}
              onStage={handleStage}
              onUnstage={handleUnstage}
              onCommit={handleCommit}
              onViewDiff={handleViewDiff}
              onRefresh={loadGitStatus}
            />
          </aside>
        )}
      </div>
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
