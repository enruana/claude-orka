import { useState, useEffect, useCallback } from 'react'
import { FileTreeNode, api } from '../../api/client'
import { FileTree } from './FileTree'
import { MarkdownViewer } from './MarkdownViewer'
import {
  ContextMenu,
  useContextMenu,
  createCopyPathItem,
  createCopyRelativePathItem,
  createCopyFileNameItem
} from './ContextMenu'
import Editor from '@monaco-editor/react'
import { FileText, Image as ImageIcon, File, AlertCircle, ArrowLeft, FolderOpen, Check } from 'lucide-react'

interface FileExplorerProps {
  projectPath: string
  encodedPath: string
}

// File type detection
function getFileType(path: string): 'markdown' | 'code' | 'image' | 'other' {
  const ext = path.split('.').pop()?.toLowerCase() || ''

  const markdownExts = ['md', 'mdx']
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']
  const codeExts = [
    'ts', 'tsx', 'js', 'jsx', 'json', 'html', 'css', 'scss', 'sass', 'less',
    'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'php',
    'swift', 'kt', 'scala', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'xml', 'sql', 'graphql',
    'vue', 'svelte', 'astro', 'prisma', 'proto', 'dockerfile', 'makefile',
    'gitignore', 'env', 'txt', 'log'
  ]

  if (markdownExts.includes(ext)) return 'markdown'
  if (imageExts.includes(ext)) return 'image'
  if (codeExts.includes(ext)) return 'code'

  // Default to code for unknown text files
  return 'other'
}

// Get Monaco language from file extension
function getMonacoLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'scss',
    less: 'less',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    xml: 'xml',
    sql: 'sql',
    graphql: 'graphql',
    vue: 'vue',
    svelte: 'svelte',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
  }
  return langMap[ext] || 'plaintext'
}

// Hook to detect mobile/tablet (touch devices or small screens)
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => {
    // Initial check on mount (SSR safe)
    if (typeof window === 'undefined') return false
    return (
      window.matchMedia('(max-width: 1024px)').matches ||
      window.matchMedia('(pointer: coarse)').matches
    )
  })

  useEffect(() => {
    const widthQuery = window.matchMedia('(max-width: 1024px)')
    const touchQuery = window.matchMedia('(pointer: coarse)')

    const checkMobile = () => {
      setIsMobile(widthQuery.matches || touchQuery.matches)
    }

    // Listen for changes in both media queries
    widthQuery.addEventListener('change', checkMobile)
    touchQuery.addEventListener('change', checkMobile)

    // Also listen to resize for orientation changes
    window.addEventListener('resize', checkMobile)

    // Initial check
    checkMobile()

    return () => {
      widthQuery.removeEventListener('change', checkMobile)
      touchQuery.removeEventListener('change', checkMobile)
      window.removeEventListener('resize', checkMobile)
    }
  }, [])

  return isMobile
}

export function FileExplorer({ projectPath, encodedPath }: FileExplorerProps) {
  const [tree, setTree] = useState<FileTreeNode[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [isLoadingTree, setIsLoadingTree] = useState(true)
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)

  // Mobile state - controls which view is shown
  const [mobileView, setMobileView] = useState<'tree' | 'file'>('tree')
  const isMobile = useIsMobile()

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
  useEffect(() => {
    const loadTree = async () => {
      try {
        setIsLoadingTree(true)
        const tree = await api.getFileTree(encodedPath)
        setTree(tree)
        setError(null)
      } catch (err: any) {
        setError(err.message || 'Failed to load file tree')
      } finally {
        setIsLoadingTree(false)
      }
    }
    loadTree()
  }, [encodedPath])

  // Handle directory expansion
  const handleExpandDirectory = useCallback(async (path: string) => {
    try {
      const children = await api.expandFileTree(encodedPath, path)

      // Update tree with new children
      const updateChildren = (nodes: FileTreeNode[]): FileTreeNode[] => {
        return nodes.map(node => {
          if (node.path === path) {
            return { ...node, children }
          }
          if (node.children) {
            return { ...node, children: updateChildren(node.children) }
          }
          return node
        })
      }

      setTree(prev => updateChildren(prev))
    } catch (err: any) {
      console.error('Failed to expand directory:', err)
    }
  }, [encodedPath])

  // Handle file selection
  const handleFileSelect = async (path: string) => {
    const fileType = getFileType(path)

    // For images, don't fetch content
    if (fileType === 'image') {
      setSelectedFile(path)
      setFileContent(null)
      setFileError(null)
      if (isMobile) setMobileView('file')
      return
    }

    try {
      setSelectedFile(path)
      setIsLoadingFile(true)
      setFileError(null)
      setFileContent(null)
      if (isMobile) setMobileView('file')

      const data = await api.getFileContent(encodedPath, path)
      if (data && data.content !== undefined) {
        setFileContent(data.content)
      } else {
        setFileError('Empty response from server')
      }
    } catch (err: any) {
      console.error('Failed to load file:', path, err)
      setFileError(err.message || 'Failed to load file')
      setFileContent(null)
    } finally {
      setIsLoadingFile(false)
    }
  }

  // Handle back navigation on mobile
  const handleBackToTree = () => {
    setMobileView('tree')
    // Optionally clear selection when going back
    // setSelectedFile(null)
    // setFileContent(null)
  }

  // Render file viewer based on type
  const renderFileViewer = (showHeader: boolean = false) => {
    const fileName = selectedFile?.split('/').pop() || ''

    if (!selectedFile) {
      return (
        <div className="file-viewer-placeholder">
          <FileText size={48} strokeWidth={1} />
          <p>Select a file to view</p>
        </div>
      )
    }

    if (isLoadingFile) {
      return (
        <div className="file-viewer-loading">
          <div className="spinner" />
          <span>Loading file...</span>
        </div>
      )
    }

    if (fileError) {
      return (
        <div className="file-viewer-error">
          <AlertCircle size={48} strokeWidth={1} />
          <p>{fileError}</p>
        </div>
      )
    }

    const fileType = getFileType(selectedFile)

    // Mobile header for file view
    const mobileHeader = showHeader ? (
      <div className="file-viewer-mobile-header">
        <button className="back-btn" onClick={handleBackToTree}>
          <ArrowLeft size={18} />
        </button>
        <div className="file-info">
          {fileType === 'markdown' && <FileText size={14} />}
          {fileType === 'image' && <ImageIcon size={14} />}
          {(fileType === 'code' || fileType === 'other') && <File size={14} />}
          <span className="file-name">{fileName}</span>
        </div>
      </div>
    ) : null

    switch (fileType) {
      case 'markdown':
        return (
          <div className="file-viewer-mobile-container">
            {mobileHeader}
            <div className="file-viewer-mobile-content">
              <MarkdownViewer
                content={fileContent || ''}
                fileName={fileName}
              />
            </div>
          </div>
        )

      case 'image':
        return (
          <div className="file-viewer-mobile-container">
            {mobileHeader}
            <div className="file-viewer-mobile-content">
              <div className="image-viewer">
                {!showHeader && (
                  <div className="image-viewer-header">
                    <ImageIcon size={14} />
                    <span>{fileName}</span>
                  </div>
                )}
                <div className="image-viewer-content">
                  <img
                    src={`/api/files/image?project=${encodedPath}&path=${encodeURIComponent(selectedFile)}`}
                    alt={fileName}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none'
                      setFileError('Failed to load image')
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        )

      case 'code':
      case 'other':
      default:
        return (
          <div className="file-viewer-mobile-container">
            {mobileHeader}
            <div className="file-viewer-mobile-content">
              <div className="code-viewer">
                {!showHeader && (
                  <div className="code-viewer-header">
                    <File size={14} />
                    <span>{fileName}</span>
                  </div>
                )}
                <div className="code-viewer-content">
                  <Editor
                    width="100%"
                    height="100%"
                    language={getMonacoLanguage(selectedFile)}
                    value={fileContent || ''}
                    theme="vs-dark"
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      fontSize: isMobile ? 12 : 13,
                      lineNumbers: isMobile ? 'off' : 'on',
                      wordWrap: 'on',
                      scrollBeyondLastLine: false,
                      folding: false,
                      renderLineHighlight: 'none',
                      cursorStyle: 'line',
                      scrollbar: {
                        vertical: 'auto',
                        horizontal: 'auto',
                        verticalScrollbarSize: 8,
                        horizontalScrollbarSize: 8,
                      },
                      automaticLayout: true,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        )
    }
  }

  if (isLoadingTree) {
    return (
      <div className="file-explorer-loading">
        <div className="spinner" />
        <span>Loading files...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="file-explorer-error">
        <AlertCircle size={24} />
        <p>{error}</p>
      </div>
    )
  }

  // Render context menu
  const renderContextMenu = () => {
    if (!contextMenu.show || !contextMenu.data) return null

    const { path, isDirectory } = contextMenu.data
    const fileName = path.split('/').pop() || path
    const items = buildContextMenuItems(path, isDirectory)

    return (
      <ContextMenu
        items={items}
        position={contextMenu.position}
        onClose={hideContextMenu}
        title={fileName}
      />
    )
  }

  // Render toast notification
  const renderToast = () => {
    if (!toast.show) return null

    return (
      <div className="copy-toast success">
        <Check size={16} className="toast-icon" />
        <span>{toast.message}</span>
      </div>
    )
  }

  // Mobile layout - show one view at a time
  if (isMobile) {
    return (
      <div className="file-explorer-mobile">
        {mobileView === 'tree' ? (
          <div className="file-explorer-mobile-tree">
            <div className="mobile-tree-header">
              <FolderOpen size={16} />
              <span>Files</span>
            </div>
            <div className="mobile-tree-content">
              <FileTree
                tree={tree}
                selectedFile={selectedFile}
                onFileSelect={handleFileSelect}
                gitStatus={null}
                onExpandDirectory={handleExpandDirectory}
                onContextMenu={handleTreeContextMenu}
                onLongPress={handleTreeLongPress}
              />
            </div>
          </div>
        ) : (
          <div className="file-explorer-mobile-viewer">
            {renderFileViewer(true)}
          </div>
        )}
        {renderContextMenu()}
        {renderToast()}
      </div>
    )
  }

  // Desktop layout - side by side
  return (
    <div className="file-explorer-container">
      <div className="file-explorer-tree">
        <FileTree
          tree={tree}
          selectedFile={selectedFile}
          onFileSelect={handleFileSelect}
          gitStatus={null}
          onExpandDirectory={handleExpandDirectory}
          onContextMenu={handleTreeContextMenu}
          onLongPress={handleTreeLongPress}
        />
      </div>
      <div className="file-viewer-panel">
        {renderFileViewer(false)}
      </div>
      {renderContextMenu()}
      {renderToast()}
    </div>
  )
}
