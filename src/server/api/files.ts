import { Router } from 'express'
import fs from 'fs-extra'
import path from 'path'
import multer from 'multer'
import execa from 'execa'

export const filesRouter = Router()

// MIME types for images
const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
}

interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
}

// Patterns to ignore when building file tree (minimal - only system files)
const IGNORE_PATTERNS = [
  '.DS_Store',
  'Thumbs.db',
]

function decodeProjectPath(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

function isPathSafe(projectPath: string, filePath: string): boolean {
  const resolvedProject = path.resolve(projectPath)
  const resolvedFile = path.resolve(projectPath, filePath)
  return resolvedFile.startsWith(resolvedProject)
}

async function buildFileTree(
  dirPath: string,
  basePath: string,
  depth: number = 0,
  maxDepth: number = 3
): Promise<FileTreeNode[]> {
  if (depth > maxDepth) {
    return []
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const nodes: FileTreeNode[] = []

  for (const entry of entries) {
    // Skip ignored patterns
    if (IGNORE_PATTERNS.includes(entry.name)) {
      continue
    }

    const fullPath = path.join(dirPath, entry.name)
    const relativePath = path.relative(basePath, fullPath)

    if (entry.isDirectory()) {
      const children = await buildFileTree(fullPath, basePath, depth + 1, maxDepth)
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'directory',
        children,
      })
    } else {
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
      })
    }
  }

  // Sort: directories first, then alphabetically
  nodes.sort((a, b) => {
    if (a.type === 'directory' && b.type === 'file') return -1
    if (a.type === 'file' && b.type === 'directory') return 1
    return a.name.localeCompare(b.name)
  })

  return nodes
}

/**
 * GET /api/files/list?project=<base64>&path=<relative>
 * Returns direct children of a directory with metadata (Finder-style listing)
 */
filesRouter.get('/list', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = (req.query.path as string) || ''

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const targetPath = relativePath ? path.join(projectPath, relativePath) : projectPath

    if (!await fs.pathExists(targetPath)) {
      res.status(404).json({ error: 'Path not found' })
      return
    }

    const stat = await fs.stat(targetPath)
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory' })
      return
    }

    const entries = await fs.readdir(targetPath, { withFileTypes: true })
    const items: {
      name: string
      path: string
      type: 'file' | 'directory'
      size: number
      modifiedAt: string
      extension: string
      childCount?: number
    }[] = []

    for (const entry of entries) {
      if (IGNORE_PATTERNS.includes(entry.name)) continue

      const entryFullPath = path.join(targetPath, entry.name)
      const entryRelativePath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name

      try {
        const entryStat = await fs.stat(entryFullPath)
        const isDir = entry.isDirectory()

        const item: typeof items[number] = {
          name: entry.name,
          path: entryRelativePath,
          type: isDir ? 'directory' : 'file',
          size: isDir ? 0 : entryStat.size,
          modifiedAt: entryStat.mtime.toISOString(),
          extension: isDir ? '' : (entry.name.split('.').pop()?.toLowerCase() || ''),
        }

        if (isDir) {
          try {
            const children = await fs.readdir(entryFullPath)
            item.childCount = children.filter(c => !IGNORE_PATTERNS.includes(c)).length
          } catch {
            item.childCount = 0
          }
        }

        items.push(item)
      } catch {
        // Skip entries we can't stat (permissions, etc.)
      }
    }

    // Sort: directories first, then alphabetically
    items.sort((a, b) => {
      if (a.type === 'directory' && b.type === 'file') return -1
      if (a.type === 'file' && b.type === 'directory') return 1
      return a.name.localeCompare(b.name)
    })

    const parentPath = relativePath
      ? relativePath.includes('/') ? relativePath.substring(0, relativePath.lastIndexOf('/')) : ''
      : null

    res.json({
      items,
      currentPath: relativePath,
      parentPath,
    })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/files/tree?project=<base64>
 * Returns the file tree for a project
 */
filesRouter.get('/tree', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await fs.pathExists(projectPath)) {
      res.status(404).json({ error: 'Project path not found' })
      return
    }

    const tree = await buildFileTree(projectPath, projectPath)
    res.json({ tree })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/files/tree-expand?project=<base64>&path=<relative>
 * Returns children for a specific directory (lazy loading)
 */
filesRouter.get('/tree-expand', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = req.query.path as string

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)
    const targetPath = relativePath ? path.join(projectPath, relativePath) : projectPath

    if (!isPathSafe(projectPath, relativePath || '')) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    if (!await fs.pathExists(targetPath)) {
      res.status(404).json({ error: 'Path not found' })
      return
    }

    const stat = await fs.stat(targetPath)
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory' })
      return
    }

    const children = await buildFileTree(targetPath, projectPath, 0, 1)
    res.json({ children })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/files/content?project=<base64>&path=<relative>
 * Returns the content of a file
 */
filesRouter.get('/content', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = req.query.path as string

    if (!projectEncoded || !relativePath) {
      res.status(400).json({ error: 'Project and path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const filePath = path.join(projectPath, relativePath)

    if (!await fs.pathExists(filePath)) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    const stat = await fs.stat(filePath)
    if (stat.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory' })
      return
    }

    // Check file size - limit to 5MB
    if (stat.size > 5 * 1024 * 1024) {
      res.status(413).json({ error: 'File too large (max 5MB)' })
      return
    }

    const content = await fs.readFile(filePath, 'utf-8')
    res.json({ content, path: relativePath, size: stat.size })
  } catch (error: any) {
    // Handle binary files gracefully
    if (error.code === 'ERR_INVALID_ARG_VALUE' || error.message?.includes('encoding')) {
      res.status(400).json({ error: 'Cannot read binary file' })
      return
    }
    res.status(500).json({ error: error.message })
  }
})

/**
 * PUT /api/files/content?project=<base64>&path=<relative>
 * Writes content to a file
 */
filesRouter.put('/content', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = req.query.path as string
    const { content } = req.body

    if (!projectEncoded || !relativePath) {
      res.status(400).json({ error: 'Project and path required' })
      return
    }

    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Content must be a string' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const filePath = path.join(projectPath, relativePath)

    // Ensure parent directory exists
    await fs.ensureDir(path.dirname(filePath))

    await fs.writeFile(filePath, content, 'utf-8')
    res.json({ success: true, path: relativePath })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/files/create?project=<base64>
 * Creates a new file or directory
 */
filesRouter.post('/create', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const { path: relativePath, type } = req.body

    if (!projectEncoded || !relativePath) {
      res.status(400).json({ error: 'Project and path required' })
      return
    }

    if (type !== 'file' && type !== 'directory') {
      res.status(400).json({ error: 'Type must be "file" or "directory"' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const targetPath = path.join(projectPath, relativePath)

    if (await fs.pathExists(targetPath)) {
      res.status(409).json({ error: 'Path already exists' })
      return
    }

    if (type === 'directory') {
      await fs.ensureDir(targetPath)
    } else {
      await fs.ensureDir(path.dirname(targetPath))
      await fs.writeFile(targetPath, '', 'utf-8')
    }

    res.json({ success: true, path: relativePath, type })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /api/files?project=<base64>&path=<relative>
 * Deletes a file or directory
 */
filesRouter.delete('/', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = req.query.path as string

    if (!projectEncoded || !relativePath) {
      res.status(400).json({ error: 'Project and path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const targetPath = path.join(projectPath, relativePath)

    if (!await fs.pathExists(targetPath)) {
      res.status(404).json({ error: 'Path not found' })
      return
    }

    await fs.remove(targetPath)
    res.json({ success: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/files/image?project=<base64>&path=<relative>
 * Serves an image file as binary
 */
filesRouter.get('/image', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = req.query.path as string

    if (!projectEncoded || !relativePath) {
      res.status(400).json({ error: 'Project and path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const filePath = path.join(projectPath, relativePath)

    if (!await fs.pathExists(filePath)) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    const stat = await fs.stat(filePath)
    if (stat.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory' })
      return
    }

    // Check file size - limit to 10MB for images
    if (stat.size > 10 * 1024 * 1024) {
      res.status(413).json({ error: 'File too large (max 10MB)' })
      return
    }

    // Get MIME type from extension
    const ext = path.extname(filePath).slice(1).toLowerCase()
    const mimeType = IMAGE_MIME_TYPES[ext]

    if (!mimeType) {
      res.status(400).json({ error: 'Not a supported image format' })
      return
    }

    // Set content type and serve file
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Cache-Control', 'public, max-age=3600')

    const fileStream = fs.createReadStream(filePath)
    fileStream.pipe(res)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/files/raw?project=<base64>&path=<relative>
 * Serve a file with its native content type (for HTML preview, etc.)
 */
filesRouter.get('/raw', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const filePath = req.query.path as string

    if (!projectEncoded || !filePath) {
      res.status(400).json({ error: 'project and path are required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, filePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const fullPath = path.resolve(projectPath, filePath)

    if (!await fs.pathExists(fullPath)) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    const stat = await fs.stat(fullPath)
    if (stat.isDirectory()) {
      res.status(400).json({ error: 'Cannot serve a directory' })
      return
    }

    const ext = path.extname(fullPath).slice(1).toLowerCase()
    const MIME_TYPES: Record<string, string> = {
      html: 'text/html', htm: 'text/html',
      css: 'text/css', js: 'text/javascript',
      json: 'application/json', xml: 'application/xml',
      svg: 'image/svg+xml', png: 'image/png',
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp',
      pdf: 'application/pdf', txt: 'text/plain',
      md: 'text/markdown',
    }

    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream')
    fs.createReadStream(fullPath).pipe(res)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/files/download?project=<base64>&path=<relative>
 * Downloads a file or directory as a zip archive (directories) or raw file (single files)
 */
filesRouter.get('/download', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = (req.query.path as string) || ''

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const targetPath = relativePath ? path.join(projectPath, relativePath) : projectPath

    if (!await fs.pathExists(targetPath)) {
      res.status(404).json({ error: 'Path not found' })
      return
    }

    const stat = await fs.stat(targetPath)
    const name = path.basename(targetPath) || 'project'

    if (stat.isDirectory()) {
      // Stream a tar.gz archive of the directory using system tar
      const archiveName = `${name}.tar.gz`
      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`)

      const parentDir = path.dirname(targetPath)
      const dirName = path.basename(targetPath)

      const tar = execa('tar', ['czf', '-', dirName], {
        cwd: parentDir,
        stdout: 'pipe',
        stderr: 'pipe',
        buffer: false,
      })

      tar.stdout!.pipe(res)

      tar.stderr!.on('data', (chunk: Buffer) => {
        console.error('tar stderr:', chunk.toString())
      })

      res.on('close', () => {
        tar.kill()
      })

      await tar.catch((err) => {
        if (!res.headersSent) {
          res.status(500).json({ error: err.message })
        }
      })
    } else {
      // Single file download
      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
      res.setHeader('Content-Length', stat.size.toString())
      fs.createReadStream(targetPath).pipe(res)
    }
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message })
    }
  }
})

/**
 * GET /api/files/search?project=<base64>&query=<string>&caseSensitive=<bool>&regex=<bool>
 * Search for text across project files using grep
 */
filesRouter.get('/search', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const query = req.query.query as string
    const caseSensitive = req.query.caseSensitive === 'true'
    const regex = req.query.regex === 'true'

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    if (!query || query.length < 2) {
      res.status(400).json({ error: 'Query must be at least 2 characters' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await fs.pathExists(projectPath)) {
      res.status(404).json({ error: 'Project path not found' })
      return
    }

    const EXCLUDE_DIRS = [
      'node_modules', '.git', 'dist', '.next', '.claude-orka',
      '__pycache__', '.venv', '.tsbuildinfo', 'coverage', '.nyc_output',
      'build', '.cache', '.parcel-cache',
    ]

    const args: string[] = [
      '-rn',           // recursive, line numbers
      '-I',            // skip binary files
      '--color=never', // no ANSI colors
    ]

    if (!caseSensitive) args.push('-i')
    if (regex) {
      args.push('-E') // extended regex
    } else {
      args.push('-F') // fixed string (literal)
    }

    for (const dir of EXCLUDE_DIRS) {
      args.push(`--exclude-dir=${dir}`)
    }

    args.push('--', query, '.')

    const MAX_MATCHES = 500

    const result = await execa('grep', args, {
      cwd: projectPath,
      reject: false,
      timeout: 10000,
      stripFinalNewline: true,
    })

    // grep exit code 1 = no matches, 2 = error
    if (result.exitCode === 2) {
      res.status(500).json({ error: 'Search failed: ' + (result.stderr || 'unknown error') })
      return
    }

    if (!result.stdout || result.exitCode === 1) {
      res.json({ results: [], totalMatches: 0, truncated: false })
      return
    }

    const lines = result.stdout.split('\n').filter(Boolean)
    const truncated = lines.length > MAX_MATCHES
    const limitedLines = lines.slice(0, MAX_MATCHES)

    // Parse grep output: ./path/to/file:lineNum:matched text
    const fileMap = new Map<string, { line: number; text: string }[]>()

    for (const line of limitedLines) {
      // Match: ./relative/path:lineNumber:text
      const match = line.match(/^\.\/(.+?):(\d+):(.*)$/)
      if (!match) continue

      const [, filePath, lineStr, text] = match
      const lineNum = parseInt(lineStr, 10)

      if (!fileMap.has(filePath)) {
        fileMap.set(filePath, [])
      }
      fileMap.get(filePath)!.push({ line: lineNum, text: text.trim() })
    }

    const results = Array.from(fileMap.entries()).map(([filePath, matches]) => ({
      path: filePath,
      matches,
    }))

    res.json({
      results,
      totalMatches: lines.length > MAX_MATCHES ? lines.length : limitedLines.length,
      truncated,
    })
  } catch (error: any) {
    if (error.timedOut) {
      res.status(408).json({ error: 'Search timed out' })
      return
    }
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/files/move?project=<base64>
 * Moves a file or directory from one path to another
 */
filesRouter.post('/move', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const { from, to } = req.body

    if (!projectEncoded || !from || !to) {
      res.status(400).json({ error: 'Project, from, and to paths required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, from) || !isPathSafe(projectPath, to)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const fromAbsolute = path.resolve(projectPath, from)
    const toAbsolute = path.resolve(projectPath, to)

    if (!await fs.pathExists(fromAbsolute)) {
      res.status(404).json({ error: 'Source path not found' })
      return
    }

    // Prevent moving a folder into itself or a descendant
    const fromStat = await fs.stat(fromAbsolute)
    if (fromStat.isDirectory() && (toAbsolute + '/').startsWith(fromAbsolute + '/')) {
      res.status(400).json({ error: 'Cannot move a folder into itself' })
      return
    }

    // Ensure target parent directory exists
    const toParent = path.dirname(toAbsolute)
    if (!await fs.pathExists(toParent)) {
      res.status(400).json({ error: 'Target parent directory does not exist' })
      return
    }

    // Check for name conflict at destination
    if (await fs.pathExists(toAbsolute)) {
      res.status(409).json({ error: 'A file or folder with that name already exists at the destination' })
      return
    }

    await fs.move(fromAbsolute, toAbsolute)
    res.json({ success: true, from, to })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/files/upload?project=<base64>
 * Uploads files to a specified directory within the project.
 * Body (multipart): files[] + destination (relative path, defaults to project root)
 */
const upload = multer({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max per file
})

// Accept both 'files' (plural, from finder) and 'file' (singular, from terminal drag-drop)
const uploadFields = upload.fields([
  { name: 'files', maxCount: 20 },
  { name: 'file', maxCount: 1 },
])

filesRouter.post('/upload', uploadFields, async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await fs.pathExists(projectPath)) {
      res.status(404).json({ error: 'Project path not found' })
      return
    }

    const reqFiles = req.files as Record<string, Express.Multer.File[]> | undefined
    const files = [
      ...(reqFiles?.['files'] || []),
      ...(reqFiles?.['file'] || []),
    ]
    if (files.length === 0) {
      res.status(400).json({ error: 'No files provided' })
      return
    }

    // Destination directory (relative to project root)
    // Finder always sends 'destination' field (even empty for root).
    // Terminal callers don't send it at all → fall back to .claude-orka/uploads/
    const hasDestination = req.body != null && 'destination' in req.body
    const destination = (req.body?.destination as string) || ''

    const useUploadsDir = !hasDestination
    const targetDir = useUploadsDir
      ? path.join(projectPath, '.claude-orka', 'uploads')
      : destination
        ? path.join(projectPath, destination)
        : projectPath

    if (destination && !isPathSafe(projectPath, destination)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    await fs.ensureDir(targetDir)

    const uploaded: { name: string; path: string; absolutePath: string }[] = []

    for (const file of files) {
      // Sanitize filename: remove path separators and null bytes
      const sanitizedName = file.originalname
        .replace(/[/\\]/g, '_')
        .replace(/\0/g, '')
        .replace(/\.\./g, '_')

      // Add timestamp prefix for uploads dir to avoid collisions
      const fileName = useUploadsDir ? `${Date.now()}-${sanitizedName}` : sanitizedName
      const destPath = path.join(targetDir, fileName)

      // Verify the resolved path is within the project directory
      if (!path.resolve(destPath).startsWith(path.resolve(projectPath))) {
        continue // Skip unsafe files
      }

      await fs.writeFile(destPath, file.buffer)

      const relativePath = path.relative(projectPath, destPath)
      uploaded.push({ name: sanitizedName, path: relativePath, absolutePath: destPath })
    }

    res.json({ success: true, uploaded })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})
