import { Router } from 'express'
import fs from 'fs-extra'
import path from 'path'

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

// Patterns to ignore when building file tree
const IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  '.claude-orka',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  '.DS_Store',
  'Thumbs.db',
  '.idea',
  '.vscode',
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
    // Skip ignored patterns and hidden files
    if (IGNORE_PATTERNS.includes(entry.name) || entry.name.startsWith('.')) {
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
