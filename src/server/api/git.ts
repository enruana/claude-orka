import { Router } from 'express'
import execa from 'execa'
import path from 'path'
import fs from 'fs-extra'

export const gitRouter = Router()

function decodeProjectPath(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

interface GitFileChange {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
  oldPath?: string  // For renamed files
}

interface GitCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  relativeDate: string
}

/**
 * Parse git status --porcelain output
 */
function parseGitStatus(output: string): GitFileChange[] {
  const changes: GitFileChange[] = []
  const lines = output.split('\n').filter(line => line.trim())

  for (const line of lines) {
    const indexStatus = line[0]
    const workTreeStatus = line[1]
    let filePath = line.slice(3)

    // Handle renamed files (has -> in path)
    let oldPath: string | undefined
    if (filePath.includes(' -> ')) {
      const parts = filePath.split(' -> ')
      oldPath = parts[0]
      filePath = parts[1]
    }

    // Determine if staged
    const staged = indexStatus !== ' ' && indexStatus !== '?'
    const unstaged = workTreeStatus !== ' '

    // Map status codes
    const getStatus = (code: string): GitFileChange['status'] => {
      switch (code) {
        case 'M': return 'modified'
        case 'A': return 'added'
        case 'D': return 'deleted'
        case 'R': return 'renamed'
        case '?': return 'untracked'
        default: return 'modified'
      }
    }

    // Add staged change
    if (staged) {
      changes.push({
        path: filePath,
        status: getStatus(indexStatus),
        staged: true,
        oldPath,
      })
    }

    // Add unstaged change
    if (unstaged || indexStatus === '?') {
      // Skip if we already added a staged version with same status
      const existingStaged = changes.find(c => c.path === filePath && c.staged)
      if (!existingStaged || existingStaged.status !== getStatus(workTreeStatus)) {
        changes.push({
          path: filePath,
          status: getStatus(workTreeStatus === ' ' ? indexStatus : workTreeStatus),
          staged: false,
          oldPath,
        })
      }
    }
  }

  return changes
}

/**
 * Parse git log output
 */
function parseGitLog(output: string): GitCommit[] {
  const commits: GitCommit[] = []
  const lines = output.split('\n').filter(line => line.trim())

  for (const line of lines) {
    // Format: hash|shortHash|message|author|date|relativeDate
    const parts = line.split('|')
    if (parts.length >= 6) {
      commits.push({
        hash: parts[0],
        shortHash: parts[1],
        message: parts[2],
        author: parts[3],
        date: parts[4],
        relativeDate: parts[5],
      })
    }
  }

  return commits
}

async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    await execa('git', ['rev-parse', '--git-dir'], { cwd: dirPath })
    return true
  } catch {
    return false
  }
}

/**
 * GET /api/git/status?project=<base64>
 * Returns git status with file changes
 */
gitRouter.get('/status', async (req, res) => {
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

    if (!await isGitRepo(projectPath)) {
      res.status(400).json({ error: 'Not a git repository' })
      return
    }

    // Get current branch
    const { stdout: branch } = await execa('git', ['branch', '--show-current'], { cwd: projectPath })

    // Get status
    const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: projectPath })
    const changes = parseGitStatus(status)

    // Get staged and unstaged counts
    const stagedChanges = changes.filter(c => c.staged)
    const unstagedChanges = changes.filter(c => !c.staged)

    res.json({
      branch: branch.trim(),
      changes,
      stagedCount: stagedChanges.length,
      unstagedCount: unstagedChanges.length,
      isClean: changes.length === 0,
    })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/git/diff?project=<base64>&path=<relative>&staged=<bool>
 * Returns diff for a specific file
 */
gitRouter.get('/diff', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = req.query.path as string
    const staged = req.query.staged === 'true'

    if (!projectEncoded || !relativePath) {
      res.status(400).json({ error: 'Project and path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await isGitRepo(projectPath)) {
      res.status(400).json({ error: 'Not a git repository' })
      return
    }

    const args = ['diff']
    if (staged) {
      args.push('--cached')
    }
    args.push('--', relativePath)

    const { stdout: diff } = await execa('git', args, { cwd: projectPath })

    // Get original content (for untracked files, original is empty)
    let original = ''
    let modified = ''

    try {
      if (staged) {
        // For staged files, get HEAD version
        const { stdout } = await execa('git', ['show', `HEAD:${relativePath}`], { cwd: projectPath })
        original = stdout
        // Get staged version
        const { stdout: stagedContent } = await execa('git', ['show', `:${relativePath}`], { cwd: projectPath })
        modified = stagedContent
      } else {
        // For unstaged files, get index version
        const { stdout } = await execa('git', ['show', `:${relativePath}`], { cwd: projectPath })
        original = stdout
        // Get working tree version
        const filePath = path.join(projectPath, relativePath)
        modified = await fs.readFile(filePath, 'utf-8')
      }
    } catch {
      // File might be new, try to read from disk
      const filePath = path.join(projectPath, relativePath)
      if (await fs.pathExists(filePath)) {
        modified = await fs.readFile(filePath, 'utf-8')
      }
    }

    res.json({
      diff,
      original,
      modified,
      path: relativePath,
      staged,
    })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/git/stage?project=<base64>
 * Stage files
 * Body: { paths: string[] }
 */
gitRouter.post('/stage', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const { paths } = req.body

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: 'Paths array required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await isGitRepo(projectPath)) {
      res.status(400).json({ error: 'Not a git repository' })
      return
    }

    await execa('git', ['add', '--', ...paths], { cwd: projectPath })
    res.json({ success: true, staged: paths })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/git/unstage?project=<base64>
 * Unstage files
 * Body: { paths: string[] }
 */
gitRouter.post('/unstage', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const { paths } = req.body

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: 'Paths array required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await isGitRepo(projectPath)) {
      res.status(400).json({ error: 'Not a git repository' })
      return
    }

    await execa('git', ['reset', 'HEAD', '--', ...paths], { cwd: projectPath })
    res.json({ success: true, unstaged: paths })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/git/discard?project=<base64>
 * Discard changes in working tree
 * Body: { paths: string[] }
 */
gitRouter.post('/discard', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const { paths } = req.body

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: 'Paths array required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await isGitRepo(projectPath)) {
      res.status(400).json({ error: 'Not a git repository' })
      return
    }

    await execa('git', ['checkout', '--', ...paths], { cwd: projectPath })
    res.json({ success: true, discarded: paths })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/git/commit?project=<base64>
 * Create a commit
 * Body: { message: string }
 */
gitRouter.post('/commit', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const { message } = req.body

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Commit message required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await isGitRepo(projectPath)) {
      res.status(400).json({ error: 'Not a git repository' })
      return
    }

    const { stdout } = await execa('git', ['commit', '-m', message], { cwd: projectPath })

    // Get the commit hash
    const { stdout: hash } = await execa('git', ['rev-parse', 'HEAD'], { cwd: projectPath })

    res.json({
      success: true,
      hash: hash.trim(),
      message,
      output: stdout,
    })
  } catch (error: any) {
    // Handle "nothing to commit" gracefully
    if (error.stderr?.includes('nothing to commit')) {
      res.status(400).json({ error: 'Nothing to commit' })
      return
    }
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/git/log?project=<base64>&limit=<number>
 * Get commit history
 */
gitRouter.get('/log', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const limit = parseInt(req.query.limit as string) || 50

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await isGitRepo(projectPath)) {
      res.status(400).json({ error: 'Not a git repository' })
      return
    }

    // Format: hash|shortHash|message|author|date|relativeDate
    const format = '%H|%h|%s|%an|%ai|%ar'
    const { stdout } = await execa('git', [
      'log',
      `--format=${format}`,
      `-${limit}`,
    ], { cwd: projectPath })

    const commits = parseGitLog(stdout)
    res.json({ commits })
  } catch (error: any) {
    // Handle repos with no commits
    if (error.stderr?.includes('does not have any commits yet')) {
      res.json({ commits: [] })
      return
    }
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/git/show?project=<base64>&hash=<commit>&path=<relative>
 * Get file content at a specific commit
 */
gitRouter.get('/show', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const hash = req.query.hash as string
    const relativePath = req.query.path as string

    if (!projectEncoded || !hash || !relativePath) {
      res.status(400).json({ error: 'Project, hash, and path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await isGitRepo(projectPath)) {
      res.status(400).json({ error: 'Not a git repository' })
      return
    }

    const { stdout } = await execa('git', ['show', `${hash}:${relativePath}`], { cwd: projectPath })
    res.json({ content: stdout, hash, path: relativePath })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/git/generate-commit-message?project=<base64>
 * Generate a commit message using Claude Code (headless)
 */
gitRouter.post('/generate-commit-message', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await isGitRepo(projectPath)) {
      res.status(400).json({ error: 'Not a git repository' })
      return
    }

    // Check if there are staged changes and get summary
    const { stdout: diffStat } = await execa('git', ['diff', '--cached', '--stat'], { cwd: projectPath })
    if (!diffStat.trim()) {
      res.status(400).json({ error: 'No staged changes to commit' })
      return
    }

    // Get a compact diff (limited context lines)
    const { stdout: diff } = await execa('git', ['diff', '--cached', '-U2'], { cwd: projectPath })

    // Get recent commit messages for style reference
    let recentCommits = ''
    try {
      const { stdout } = await execa('git', ['log', '--oneline', '-3'], { cwd: projectPath })
      recentCommits = stdout
    } catch {
      // Repo might not have commits yet
    }

    // Build prompt for a complete commit message
    const prompt = `Generate a complete git commit message for these changes.

Format:
<title line: verb + what changed, max 72 chars>

<body: 2-4 bullet points explaining the key changes>

Rules:
- Title: Start with verb (Add, Fix, Update, Remove, Refactor, Improve)
- Title: Be specific about what changed (not just "Update files")
- Body: Use bullet points with "-" prefix
- Body: Explain WHAT changed and WHY if relevant
- Output ONLY the commit message, no markdown, no quotes

${recentCommits ? `Recent commits for style:\n${recentCommits}\n\n` : ''}Files changed:\n${diffStat}`

    // Call Claude headless with stdin for the diff
    // Limit diff to 4000 chars to keep it fast
    const truncatedDiff = diff.length > 4000
      ? diff.slice(0, 4000) + '\n... (truncated)'
      : diff

    const { stdout: commitMessage } = await execa('claude', [
      '-p', prompt,
      '--model', 'haiku',  // Use faster model
      '--max-turns', '1',  // Single turn only
    ], {
      cwd: projectPath,
      input: `\nDiff:\n${truncatedDiff}`,
      timeout: 30000, // 30 second timeout
      env: {
        ...process.env,
        CI: 'true',
      },
    })

    // Clean up the response - remove any markdown formatting
    let cleanedMessage = commitMessage.trim()
    // Remove markdown code blocks if present
    cleanedMessage = cleanedMessage.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')
    // Remove quotes if wrapped
    cleanedMessage = cleanedMessage.replace(/^["']|["']$/g, '')

    res.json({ message: cleanedMessage.trim() })
  } catch (error: any) {
    console.error('Error generating commit message:', error)

    // Handle specific errors
    if (error.code === 'ENOENT') {
      res.status(500).json({ error: 'Claude CLI not found. Make sure claude is installed and in PATH.' })
      return
    }
    if (error.timedOut) {
      res.status(500).json({ error: 'Request timed out. Try with fewer staged changes.' })
      return
    }

    res.status(500).json({ error: error.message || 'Failed to generate commit message' })
  }
})

/**
 * GET /api/git/branches?project=<base64>
 * Get list of branches
 */
gitRouter.get('/branches', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await isGitRepo(projectPath)) {
      res.status(400).json({ error: 'Not a git repository' })
      return
    }

    const { stdout } = await execa('git', ['branch', '-a', '--format=%(refname:short)|%(HEAD)'], { cwd: projectPath })
    const lines = stdout.split('\n').filter((line: string) => line.trim())

    const branches = lines.map((line: string) => {
      const [name, isCurrent] = line.split('|')
      return {
        name: name.trim(),
        current: isCurrent === '*',
      }
    })

    res.json({ branches })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})
