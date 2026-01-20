import { Router } from 'express'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'

export const browseRouter = Router()

interface DirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
}

/**
 * GET /api/browse?path=<optional-path>
 * List contents of a directory
 * If no path provided, returns home directory
 */
browseRouter.get('/', async (req, res) => {
  try {
    const requestedPath = req.query.path as string | undefined
    const targetPath = requestedPath ? path.resolve(requestedPath) : os.homedir()

    // Security: Don't allow browsing outside of home directory or common paths
    const allowedRoots = [
      os.homedir(),
      '/Users',
      '/home',
      '/tmp',
      '/var',
      'C:\\Users',
      'D:\\',
    ]

    const isAllowed = allowedRoots.some(root =>
      targetPath.startsWith(root) || targetPath === root
    )

    if (!isAllowed) {
      res.status(403).json({ error: 'Access denied to this path' })
      return
    }

    // Check if path exists
    if (!await fs.pathExists(targetPath)) {
      res.status(404).json({ error: 'Path not found' })
      return
    }

    // Check if it's a directory
    const stat = await fs.stat(targetPath)
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory' })
      return
    }

    // Read directory contents
    const entries = await fs.readdir(targetPath, { withFileTypes: true })

    const contents: DirectoryEntry[] = entries
      .filter(entry => {
        // Filter out hidden files/folders (starting with .)
        if (entry.name.startsWith('.')) return false
        // Filter out system folders
        if (['node_modules', '__pycache__', '.git'].includes(entry.name)) return false
        return true
      })
      .map(entry => ({
        name: entry.name,
        path: path.join(targetPath, entry.name),
        isDirectory: entry.isDirectory(),
      }))
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })

    // Get parent directory (if not at root)
    const parentPath = path.dirname(targetPath)
    const hasParent = parentPath !== targetPath && allowedRoots.some(root =>
      parentPath.startsWith(root) || parentPath === root
    )

    res.json({
      currentPath: targetPath,
      parentPath: hasParent ? parentPath : null,
      entries: contents,
      isGitRepo: await fs.pathExists(path.join(targetPath, '.git')),
      hasClaudeOrka: await fs.pathExists(path.join(targetPath, '.claude-orka')),
    })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/browse/quick-access
 * Returns common/quick access paths
 */
browseRouter.get('/quick-access', async (_req, res) => {
  const home = os.homedir()

  const quickPaths = [
    { name: 'Home', path: home },
    { name: 'Desktop', path: path.join(home, 'Desktop') },
    { name: 'Documents', path: path.join(home, 'Documents') },
    { name: 'Downloads', path: path.join(home, 'Downloads') },
  ]

  // Filter to only existing paths
  const existingPaths = await Promise.all(
    quickPaths.map(async (p) => ({
      ...p,
      exists: await fs.pathExists(p.path),
    }))
  )

  res.json(existingPaths.filter(p => p.exists))
})
