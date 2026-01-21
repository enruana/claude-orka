import { useState } from 'react'
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
}

interface TreeNodeProps {
  node: FileTreeNode
  depth: number
  selectedFile: string | null
  onFileSelect: (path: string) => void
  gitChanges: Map<string, string>
  onExpandDirectory: (path: string) => Promise<void>
}

// Get appropriate icon for file type
function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const name = filename.toLowerCase()

  // Config files
  if (name.includes('config') || name.includes('rc') || name.startsWith('.')) {
    return <Settings size={16} />
  }

  // By extension
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'py':
    case 'rb':
    case 'go':
    case 'rs':
    case 'java':
    case 'c':
    case 'cpp':
    case 'h':
    case 'cs':
    case 'php':
    case 'swift':
    case 'kt':
      return <FileCode size={16} />

    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
      return <FileJson size={16} />

    case 'md':
    case 'mdx':
    case 'txt':
    case 'doc':
    case 'docx':
      return <FileText size={16} />

    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'ico':
    case 'webp':
      return <Image size={16} />

    case 'html':
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return <FileType size={16} />

    default:
      return <File size={16} />
  }
}

// Get git status indicator color
function getGitStatusColor(status: string): string {
  switch (status) {
    case 'modified':
      return 'var(--accent-yellow)'
    case 'added':
    case 'untracked':
      return 'var(--accent-green)'
    case 'deleted':
      return 'var(--accent-red)'
    case 'renamed':
      return 'var(--accent-purple)'
    default:
      return 'transparent'
  }
}

function TreeNode({
  node,
  depth,
  selectedFile,
  onFileSelect,
  gitChanges,
  onExpandDirectory,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2) // Auto-expand first two levels
  const [loading, setLoading] = useState(false)

  const isDirectory = node.type === 'directory'
  const isSelected = selectedFile === node.path
  const gitStatus = gitChanges.get(node.path)

  const handleClick = async () => {
    if (isDirectory) {
      if (!expanded && node.children?.length === 0) {
        setLoading(true)
        await onExpandDirectory(node.path)
        setLoading(false)
      }
      setExpanded(!expanded)
    } else {
      onFileSelect(node.path)
    }
  }

  return (
    <div className="tree-node-wrapper">
      <div
        className={`tree-node ${isSelected ? 'selected' : ''} ${isDirectory ? 'directory' : 'file'}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
      >
        {/* Expand/Collapse Arrow */}
        <span className="tree-node-arrow">
          {isDirectory ? (
            loading ? (
              <div className="spinner-tiny" />
            ) : expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            <span style={{ width: 14 }} />
          )}
        </span>

        {/* Icon */}
        <span className="tree-node-icon">
          {isDirectory ? (
            expanded ? <FolderOpen size={16} /> : <Folder size={16} />
          ) : (
            getFileIcon(node.name)
          )}
        </span>

        {/* Name */}
        <span className="tree-node-name">{node.name}</span>

        {/* Git Status Indicator */}
        {gitStatus && (
          <span
            className="tree-node-git-status"
            style={{ backgroundColor: getGitStatusColor(gitStatus) }}
            title={gitStatus}
          />
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
}: FileTreeProps) {
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
            />
          ))
        )}
      </div>
    </div>
  )
}
