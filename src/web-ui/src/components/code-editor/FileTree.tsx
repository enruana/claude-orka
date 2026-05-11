import { useState, useRef, useCallback, useEffect } from 'react'
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FileCode,
  FileJson,
  FileText,
  FileType,
  Image,
  Settings,
} from 'lucide-react'
import { FileTreeNode, GitStatus } from '../../api/client'

interface FileTreeProps {
  tree: FileTreeNode[]
  selectedFile: string | null
  onFileSelect: (path: string) => void
  gitStatus: GitStatus | null
  onExpandDirectory: (path: string) => Promise<void>
  onContextMenu?: (e: React.MouseEvent, path: string, isDirectory: boolean) => void
  onLongPress?: (e: React.TouchEvent | React.MouseEvent, path: string, isDirectory: boolean) => void
  onMoveFile?: (fromPath: string, toDirectory: string) => void
  /** Used to namespace persisted expansion state in localStorage. */
  storageKey?: string
}

interface TreeNodeProps {
  node: FileTreeNode
  depth: number
  selectedFile: string | null
  onFileSelect: (path: string) => void
  gitChanges: Map<string, string>
  onExpandDirectory: (path: string) => Promise<void>
  onContextMenu?: (e: React.MouseEvent, path: string, isDirectory: boolean) => void
  onLongPress?: (e: React.TouchEvent | React.MouseEvent, path: string, isDirectory: boolean) => void
  onMoveFile?: (fromPath: string, toDirectory: string) => void
  dragOverPath: string | null
  setDragOverPath: (path: string | null) => void
  expandedPaths: Set<string>
  toggleExpanded: (path: string) => void
}

// Per-extension color tokens — keep Lucide icons but tint by language for fast scanning.
const ICON_COLOR: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6',
  js: '#f7df1e', jsx: '#f7df1e', mjs: '#f7df1e', cjs: '#f7df1e',
  json: '#cbcb41', jsonc: '#cbcb41',
  py: '#3572a5',
  rb: '#cc342d',
  go: '#00add8',
  rs: '#dea584',
  java: '#b07219', kt: '#a97bff',
  c: '#555555', cpp: '#f34b7d', h: '#555555', hpp: '#f34b7d',
  cs: '#178600',
  php: '#777bb4',
  swift: '#ffac45',
  md: '#dcdcaa', mdx: '#dcdcaa', txt: '#cccccc',
  html: '#e34c26', htm: '#e34c26',
  css: '#563d7c', scss: '#cc6699', sass: '#cc6699', less: '#1d365d',
  yaml: '#cb171e', yml: '#cb171e', toml: '#9c4221',
  sh: '#89e051', bash: '#89e051', zsh: '#89e051',
  sql: '#dad8d8',
  graphql: '#e535ab', gql: '#e535ab',
  png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4',
  gif: '#a074c4', svg: '#ffb13b', webp: '#a074c4', ico: '#a074c4',
  xml: '#e37933',
}

// Get appropriate icon + color for file type
function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const name = filename.toLowerCase()
  const color = ICON_COLOR[ext]

  // Config / dotfiles — handled before extension switch
  if (name.includes('config') || name.includes('rc') || name.startsWith('.')) {
    return <Settings size={14} />
  }

  switch (ext) {
    case 'ts': case 'tsx':
    case 'js': case 'jsx': case 'mjs': case 'cjs':
    case 'py': case 'rb': case 'go': case 'rs':
    case 'java': case 'c': case 'cpp': case 'h': case 'hpp':
    case 'cs': case 'php': case 'swift': case 'kt':
      return <FileCode size={14} style={color ? { color } : undefined} />

    case 'json': case 'jsonc':
    case 'yaml': case 'yml': case 'toml':
      return <FileJson size={14} style={color ? { color } : undefined} />

    case 'md': case 'mdx': case 'txt': case 'doc': case 'docx':
      return <FileText size={14} style={color ? { color } : undefined} />

    case 'png': case 'jpg': case 'jpeg':
    case 'gif': case 'svg': case 'ico': case 'webp':
      return <Image size={14} style={color ? { color } : undefined} />

    case 'html': case 'htm':
    case 'css': case 'scss': case 'sass': case 'less':
      return <FileType size={14} style={color ? { color } : undefined} />

    default:
      return <File size={14} />
  }
}

// Single-letter git status badge
function getGitStatusBadge(status: string): { letter: string; color: string } | null {
  switch (status) {
    case 'modified': return { letter: 'M', color: 'var(--accent-yellow)' }
    case 'added': return { letter: 'A', color: 'var(--accent-green)' }
    case 'untracked': return { letter: 'U', color: 'var(--accent-green)' }
    case 'deleted': return { letter: 'D', color: 'var(--accent-red)' }
    case 'renamed': return { letter: 'R', color: 'var(--accent-purple)' }
    default: return null
  }
}

// Hook for long press detection
function useLongPress(
  onLongPressRef: React.MutableRefObject<((e: React.TouchEvent) => void) | null>,
  onClickRef: React.MutableRefObject<(() => void) | null>,
  delay: number = 500
) {
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const isLongPressRef = useRef(false)
  const startPosRef = useRef<{ x: number; y: number } | null>(null)

  const start = useCallback((e: React.TouchEvent) => {
    isLongPressRef.current = false
    startPosRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY
    }

    timerRef.current = setTimeout(() => {
      isLongPressRef.current = true
      if ('vibrate' in navigator) navigator.vibrate(50)
      onLongPressRef.current?.(e)
    }, delay)
  }, [onLongPressRef, delay])

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const end = useCallback((e: React.TouchEvent) => {
    clear()
    if (!isLongPressRef.current) {
      onClickRef.current?.()
    }
    if (isLongPressRef.current) {
      e.preventDefault()
    }
  }, [clear, onClickRef])

  const move = useCallback((e: React.TouchEvent) => {
    if (startPosRef.current) {
      const distance = Math.sqrt(
        Math.pow(e.touches[0].clientX - startPosRef.current.x, 2) +
        Math.pow(e.touches[0].clientY - startPosRef.current.y, 2)
      )
      if (distance > 10) clear()
    }
  }, [clear])

  return {
    onTouchStart: start,
    onTouchEnd: end,
    onTouchMove: move,
    onTouchCancel: clear,
  }
}

function TreeNode({
  node,
  depth,
  selectedFile,
  onFileSelect,
  gitChanges,
  onExpandDirectory,
  onContextMenu,
  onLongPress,
  onMoveFile,
  dragOverPath,
  setDragOverPath,
  expandedPaths,
  toggleExpanded,
}: TreeNodeProps) {
  const [loading, setLoading] = useState(false)

  const isDirectory = node.type === 'directory'
  const isSelected = selectedFile === node.path
  const expanded = expandedPaths.has(node.path)
  const gitStatus = gitChanges.get(node.path)
  const isDragOver = dragOverPath === node.path
  const badge = gitStatus ? getGitStatusBadge(gitStatus) : null

  const onClickRef = useRef<(() => void) | null>(null)
  const onLongPressCallbackRef = useRef<((e: React.TouchEvent) => void) | null>(null)

  onClickRef.current = async () => {
    if (isDirectory) {
      const willExpand = !expanded
      if (willExpand && (!node.children || node.children.length === 0)) {
        setLoading(true)
        try {
          await onExpandDirectory(node.path)
        } finally {
          setLoading(false)
        }
      }
      toggleExpanded(node.path)
    } else {
      onFileSelect(node.path)
    }
  }

  onLongPressCallbackRef.current = (e: React.TouchEvent) => {
    if (onLongPress) onLongPress(e, node.path, isDirectory)
  }

  const handleClick = () => onClickRef.current?.()

  const handleContextMenu = (e: React.MouseEvent) => {
    if (onContextMenu) {
      e.preventDefault()
      e.stopPropagation()
      onContextMenu(e, node.path, isDirectory)
    }
  }

  const longPressHandlers = useLongPress(onLongPressCallbackRef, onClickRef, 500)
  const isTouchDevice = typeof window !== 'undefined' && 'ontouchstart' in window

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/x-orka-path', node.path)
    e.dataTransfer.setData('text/plain', node.path)
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (!isDirectory || !onMoveFile) return
    if (!e.dataTransfer.types.includes('text/x-orka-path')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverPath !== node.path) setDragOverPath(node.path)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (!isDirectory || !onMoveFile) return
    const relatedTarget = e.relatedTarget as HTMLElement | null
    if (relatedTarget && (e.currentTarget as HTMLElement).contains(relatedTarget)) return
    if (dragOverPath === node.path) setDragOverPath(null)
  }

  const handleDrop = (e: React.DragEvent) => {
    if (!isDirectory || !onMoveFile) return
    e.preventDefault()
    e.stopPropagation()
    setDragOverPath(null)
    const fromPath = e.dataTransfer.getData('text/x-orka-path')
    if (!fromPath || fromPath === node.path) return
    if (node.path.startsWith(fromPath + '/')) return
    onMoveFile(fromPath, node.path)
    if (!expanded) toggleExpanded(node.path)
  }

  return (
    <div className="tree-node-wrapper">
      <div
        className={`tree-node ${isSelected ? 'selected' : ''} ${isDirectory ? 'directory' : 'file'} ${isDragOver ? 'drag-over' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={isTouchDevice ? undefined : handleClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        {...(isTouchDevice ? longPressHandlers : {})}
      >
        {/* Indent guides — one vertical line per parent depth level */}
        {Array.from({ length: depth }).map((_, i) => (
          <span
            key={i}
            className="tree-indent-guide"
            style={{ left: `${i * 14 + 14}px` }}
          />
        ))}

        {/* Expand/Collapse arrow */}
        <span className="tree-node-arrow">
          {isDirectory ? (
            loading ? (
              <div className="spinner-tiny" />
            ) : expanded ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          ) : (
            <span style={{ width: 12 }} />
          )}
        </span>

        {/* Icon */}
        <span className="tree-node-icon">
          {isDirectory ? (
            expanded ? <FolderOpen size={14} /> : <Folder size={14} />
          ) : (
            getFileIcon(node.name)
          )}
        </span>

        {/* Name */}
        <span className="tree-node-name">{node.name}</span>

        {/* Git status — single-letter badge */}
        {badge && (
          <span
            className="tree-node-git-badge"
            style={{ color: badge.color }}
            title={gitStatus}
          >
            {badge.letter}
          </span>
        )}
      </div>

      {/* Children */}
      {isDirectory && expanded && node.children && (
        <div className="tree-node-children">
          {node.children.map(child => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onFileSelect={onFileSelect}
              gitChanges={gitChanges}
              onExpandDirectory={onExpandDirectory}
              onContextMenu={onContextMenu}
              onLongPress={onLongPress}
              onMoveFile={onMoveFile}
              dragOverPath={dragOverPath}
              setDragOverPath={setDragOverPath}
              expandedPaths={expandedPaths}
              toggleExpanded={toggleExpanded}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FileTree({
  tree,
  selectedFile,
  onFileSelect,
  gitStatus,
  onExpandDirectory,
  onContextMenu,
  onLongPress,
  onMoveFile,
  storageKey,
}: FileTreeProps) {
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)

  // Lifted expansion state — preserved across remounts via localStorage when storageKey provided.
  const fullStorageKey = storageKey ? `orka-code-tree-expanded:${storageKey}` : null
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    if (!fullStorageKey || typeof window === 'undefined') return new Set()
    try {
      const raw = localStorage.getItem(fullStorageKey)
      if (raw) return new Set(JSON.parse(raw))
    } catch { /* ignore */ }
    return new Set()
  })

  // Persist on changes
  useEffect(() => {
    if (!fullStorageKey) return
    try {
      localStorage.setItem(fullStorageKey, JSON.stringify([...expandedPaths]))
    } catch { /* ignore */ }
  }, [expandedPaths, fullStorageKey])

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // Build a map of file path -> git status
  const gitChanges = new Map<string, string>()
  if (gitStatus) {
    for (const change of gitStatus.changes) {
      gitChanges.set(change.path, change.status)
    }
  }

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span>Explorer</span>
      </div>
      <div className="file-tree-content">
        {tree.length === 0 ? (
          <div className="file-tree-empty">
            <p>No files found</p>
          </div>
        ) : (
          tree.map(node => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              selectedFile={selectedFile}
              onFileSelect={onFileSelect}
              gitChanges={gitChanges}
              onExpandDirectory={onExpandDirectory}
              onContextMenu={onContextMenu}
              onLongPress={onLongPress}
              onMoveFile={onMoveFile}
              dragOverPath={dragOverPath}
              setDragOverPath={setDragOverPath}
              expandedPaths={expandedPaths}
              toggleExpanded={toggleExpanded}
            />
          ))
        )}
      </div>
    </div>
  )
}
