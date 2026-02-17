import {
  File,
  FileCode,
  FileJson,
  FileText,
  FileType,
  Image,
  Settings,
  Folder,
} from 'lucide-react'
import { createElement } from 'react'

/** Detect broad file category from path */
export function getFileType(path: string): 'markdown' | 'code' | 'image' | 'other' {
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
  return 'other'
}

/** Map file extension to Monaco editor language */
export function getMonacoLanguage(path: string): string {
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

/** Get a lucide icon element for a file, with configurable size */
export function getFileIcon(filename: string, size: number = 16) {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const name = filename.toLowerCase()

  if (name.includes('config') || name.includes('rc') || name.startsWith('.')) {
    return createElement(Settings, { size })
  }

  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx':
    case 'py': case 'rb': case 'go': case 'rs':
    case 'java': case 'c': case 'cpp': case 'h':
    case 'cs': case 'php': case 'swift': case 'kt':
      return createElement(FileCode, { size })
    case 'json': case 'yaml': case 'yml': case 'toml':
      return createElement(FileJson, { size })
    case 'md': case 'mdx': case 'txt': case 'doc': case 'docx':
      return createElement(FileText, { size })
    case 'png': case 'jpg': case 'jpeg': case 'gif':
    case 'svg': case 'ico': case 'webp':
      return createElement(Image, { size })
    case 'html': case 'css': case 'scss': case 'sass': case 'less':
      return createElement(FileType, { size })
    default:
      return createElement(File, { size })
  }
}

/** Get a folder icon element */
export function getFolderIcon(size: number = 16) {
  return createElement(Folder, { size })
}

/** Human-readable file kind from extension */
export function getFileKind(ext: string): string {
  if (!ext) return 'Folder'

  const kindMap: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript JSX',
    js: 'JavaScript', jsx: 'JavaScript JSX',
    json: 'JSON', html: 'HTML', css: 'CSS',
    scss: 'SCSS', sass: 'Sass', less: 'Less',
    py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust',
    java: 'Java', c: 'C', cpp: 'C++', h: 'C Header',
    hpp: 'C++ Header', cs: 'C#', php: 'PHP',
    swift: 'Swift', kt: 'Kotlin', scala: 'Scala',
    sh: 'Shell Script', bash: 'Bash Script', zsh: 'Zsh Script',
    yaml: 'YAML', yml: 'YAML', toml: 'TOML',
    xml: 'XML', sql: 'SQL', graphql: 'GraphQL',
    md: 'Markdown', mdx: 'MDX', txt: 'Plain Text',
    png: 'PNG Image', jpg: 'JPEG Image', jpeg: 'JPEG Image',
    gif: 'GIF Image', svg: 'SVG Image', webp: 'WebP Image',
    ico: 'Icon', bmp: 'Bitmap Image',
    pdf: 'PDF Document', zip: 'ZIP Archive',
    vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
    dockerfile: 'Dockerfile', makefile: 'Makefile',
    log: 'Log File', env: 'Environment',
  }

  return kindMap[ext.toLowerCase()] || `${ext.toUpperCase()} File`
}

/** Format bytes into human-readable size */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Format ISO date string as relative time ("2 hours ago") */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return 'Just now'
  if (diffMin < 60) return `${diffMin} min ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay < 7) return `${diffDay}d ago`
  if (diffDay < 30) return `${Math.floor(diffDay / 7)}w ago`

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: diffDay > 365 ? 'numeric' : undefined })
}
