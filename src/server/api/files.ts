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

/**
 * Escape a string for safe embedding inside a JavaScript single-quoted
 * string literal. Handles backslashes, quotes, newlines, closing tags
 * (to avoid `</script>` breaking out) and line/paragraph separators.
 */
function escapeForJsString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/<\/(script)/gi, '<\\/$1')
}

/**
 * Build the HTML/JS/CSS overlay that turns an HTML preview into a
 * review surface: text selection anywhere inside the document brings up
 * a floating "Add comment" button anchored to the end of the selection;
 * clicking it opens an inline dialog to type + save the comment.
 *
 * Everything is self-contained (no external requests except the two
 * `fetch`es to Orka's own API) so the injected snippet works in any
 * browser tab without depending on the parent SPA.
 *
 * `filePath` is passed to the widget so the created comment carries the
 * project-relative path (comments are looked up by filePath elsewhere).
 * Line numbers are computed against the file's own source, fetched
 * once via `/api/files/content` and cached for subsequent comments.
 */
function buildCommentsOverlay(opts: { projectB64: string; filePath: string }): string {
  const projectJs = escapeForJsString(opts.projectB64)
  const filePathJs = escapeForJsString(opts.filePath)
  const filePathQs = escapeForJsString(encodeURIComponent(opts.filePath))
  return `
<style id="orka-comments-style">
  .orka-add-comment-btn {
    position: absolute;
    z-index: 2147483646;
    display: none;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(0,0,0,0.15);
    background: #ea580c;
    color: white;
    font-size: 12px;
    font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    line-height: 1;
    user-select: none;
  }
  .orka-add-comment-btn:hover { filter: brightness(1.08); }
  .orka-comment-dialog-overlay {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(0,0,0,0.45); backdrop-filter: blur(2px);
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .orka-comment-dialog {
    background: #ffffff; color: #1a1a1a;
    border-radius: 12px; width: min(520px, 92vw);
    padding: 20px 22px; box-shadow: 0 30px 60px rgba(0,0,0,0.3);
    display: flex; flex-direction: column; gap: 12px;
  }
  .orka-comment-dialog-title {
    font-size: 15px; font-weight: 600; color: #1a1a1a; margin: 0;
  }
  .orka-comment-dialog-snippet {
    font-size: 12px; color: #444;
    background: #f5f5f5; border-radius: 6px; padding: 8px 10px;
    max-height: 100px; overflow: auto; white-space: pre-wrap;
    border-left: 3px solid #ea580c;
  }
  .orka-comment-dialog-textarea {
    width: 100%; min-height: 100px; padding: 10px;
    border: 1px solid #d1d5db; border-radius: 8px;
    font-family: inherit; font-size: 14px; resize: vertical;
    color: #1a1a1a; background: white;
  }
  .orka-comment-dialog-textarea:focus { outline: 2px solid #ea580c; outline-offset: 0; }
  .orka-comment-dialog-actions {
    display: flex; justify-content: flex-end; gap: 8px;
  }
  .orka-comment-dialog-btn {
    padding: 8px 14px; border-radius: 8px; border: none;
    font-family: inherit; font-size: 13px; font-weight: 600;
    cursor: pointer;
  }
  .orka-comment-dialog-btn.primary { background: #ea580c; color: white; }
  .orka-comment-dialog-btn.primary:hover { filter: brightness(1.08); }
  .orka-comment-dialog-btn.secondary {
    background: transparent; color: #444;
  }
  .orka-comment-dialog-btn.secondary:hover { background: #f0f0f0; }
  .orka-comment-toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647;
    background: #10b981; color: white;
    padding: 10px 16px; border-radius: 999px;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px; font-weight: 600;
    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    animation: orka-toast-in 0.15s ease-out;
  }
  .orka-comment-toast.error { background: #dc2626; }
  @keyframes orka-toast-in {
    from { opacity: 0; transform: translate(-50%, 10px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }
</style>
<script id="orka-comments-widget">
(function() {
  var PROJECT_B64 = '${projectJs}';
  var FILE_PATH = '${filePathJs}';
  var FILE_PATH_QS = '${filePathQs}';
  var API_BASE = window.location.origin + '/api';

  var sourceText = null;
  // Fetch the raw file source once so we can compute accurate line
  // numbers for each comment. If it fails (network / permissions), we
  // fall back to line 1 — the comment still carries selectedText so
  // context is preserved for review consumers.
  fetch(API_BASE + '/files/content?project=' + encodeURIComponent(PROJECT_B64) + '&path=' + FILE_PATH_QS)
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(d) { if (d && typeof d.content === 'string') sourceText = d.content; })
    .catch(function() {});

  var btn = document.createElement('button');
  btn.className = 'orka-add-comment-btn';
  btn.type = 'button';
  btn.textContent = '💬 Add comment';
  document.body.appendChild(btn);

  var savedSelection = null;
  var currentSelectedText = '';

  function hideBtn() { btn.style.display = 'none'; }
  function positionBtn(range) {
    var rect = range.getBoundingClientRect();
    var top = window.scrollY + rect.bottom + 6;
    var left = Math.min(window.scrollX + rect.right, window.scrollX + window.innerWidth - 140);
    btn.style.top = top + 'px';
    btn.style.left = left + 'px';
    btn.style.display = 'block';
  }

  function checkSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideBtn(); return; }
    var text = sel.toString().trim();
    if (!text) { hideBtn(); return; }
    var range = sel.getRangeAt(0);
    currentSelectedText = text;
    positionBtn(range);
  }

  document.addEventListener('mouseup', function() { setTimeout(checkSelection, 10); });
  document.addEventListener('touchend', function() { setTimeout(checkSelection, 150); });
  document.addEventListener('selectionchange', function() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) hideBtn();
  });

  function computeLineRange(text) {
    if (!sourceText) return { startLine: 1, endLine: 1 };
    var idx = sourceText.indexOf(text);
    if (idx < 0) return { startLine: 1, endLine: 1 };
    var before = sourceText.substring(0, idx);
    var startLine = (before.match(/\\n/g) || []).length + 1;
    var selLines = (text.match(/\\n/g) || []).length;
    return { startLine: startLine, endLine: startLine + selLines };
  }

  function showToast(msg, isError) {
    var el = document.createElement('div');
    el.className = 'orka-comment-toast' + (isError ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function() {
      el.style.transition = 'opacity 0.2s';
      el.style.opacity = '0';
      setTimeout(function() { el.remove(); }, 200);
    }, 1800);
  }

  function openDialog(selectedText) {
    var overlay = document.createElement('div');
    overlay.className = 'orka-comment-dialog-overlay';
    overlay.innerHTML =
      '<div class="orka-comment-dialog" role="dialog" aria-modal="true">' +
        '<h3 class="orka-comment-dialog-title">Add review comment</h3>' +
        '<div class="orka-comment-dialog-snippet"></div>' +
        '<textarea class="orka-comment-dialog-textarea" placeholder="Write your comment…"></textarea>' +
        '<div class="orka-comment-dialog-actions">' +
          '<button type="button" class="orka-comment-dialog-btn secondary" data-action="cancel">Cancel</button>' +
          '<button type="button" class="orka-comment-dialog-btn primary" data-action="save">Save comment</button>' +
        '</div>' +
      '</div>';

    // Fill snippet via textContent to avoid HTML injection from the file.
    overlay.querySelector('.orka-comment-dialog-snippet').textContent =
      selectedText.length > 500 ? selectedText.slice(0, 500) + '…' : selectedText;

    document.body.appendChild(overlay);
    var textarea = overlay.querySelector('.orka-comment-dialog-textarea');
    setTimeout(function() { textarea.focus(); }, 30);

    function close() { overlay.remove(); }
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) close();
    });
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);

    var saveBtn = overlay.querySelector('[data-action="save"]');
    function save() {
      var body = textarea.value.trim();
      if (!body) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      var range = computeLineRange(selectedText);
      fetch(API_BASE + '/projects/comments?project=' + encodeURIComponent(PROJECT_B64), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: FILE_PATH,
          startLine: range.startLine,
          endLine: range.endLine,
          selectedText: selectedText,
          body: body,
        }),
      }).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function() {
        close();
        var sel = window.getSelection();
        if (sel) sel.removeAllRanges();
        hideBtn();
        showToast('Comment saved');
      }).catch(function(err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save comment';
        showToast('Failed: ' + (err && err.message ? err.message : 'unknown'), true);
      });
    }
    saveBtn.addEventListener('click', save);
    textarea.addEventListener('keydown', function(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
      if (e.key === 'Escape') close();
    });
  }

  btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
  btn.addEventListener('click', function() {
    if (!currentSelectedText) return;
    openDialog(currentSelectedText);
  });
})();
</script>
`
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
 * GET /api/files/preview/:encodedProject/*
 *
 * Path-based file server used for the inline HTML preview in
 * FileViewerPage. Unlike `/api/files/raw` (which uses query params),
 * this endpoint puts the project + file path in the URL path, so
 * relative asset URLs inside the HTML (e.g. `<link href="style.css">`,
 * `<img src="img/foo.png">`) resolve correctly against the current
 * document URL — no `<base href>` injection needed.
 *
 * `:encodedProject` is URL-safe base64 (RFC 4648 §5: `-` for `+`, `_`
 * for `/`, no `=` padding) so it drops cleanly into a path segment.
 * The wildcard captures the relative file path (may contain slashes).
 */
// Express 5 (path-to-regexp v8) requires named wildcards — `*path`
// captures everything after the encoded project segment as a slash-
// separated list, exposed via `req.params.path` (string[] in v8).
filesRouter.get('/preview/:encodedProject/*path', async (req, res) => {
  try {
    const encodedProject = req.params.encodedProject
    const rawPath = (req.params as unknown as Record<string, string | string[]>).path
    const filePath = Array.isArray(rawPath) ? rawPath.join('/') : (rawPath || '')

    let projectPath: string
    try {
      // Node's `base64url` decoder handles the URL-safe alphabet natively.
      projectPath = Buffer.from(encodedProject, 'base64url').toString('utf-8')
    } catch {
      res.status(400).json({ error: 'invalid encodedProject' })
      return
    }

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

    if (ext === 'html' || ext === 'htm') {
      // `?comments=1` opts into the comment-overlay build: the response
      // still contains the file's own HTML/JS/CSS untouched, but we
      // inject a tiny self-contained script at the end of <body> that
      // adds a floating "Add comment" button on text selection and
      // POSTs the comment via the existing /api/projects/comments
      // endpoint. CSP is relaxed for that case (files may need their
      // own scripts to render correctly).
      const commentsMode = req.query.comments === '1' || req.query.comments === 'true'

      if (commentsMode) {
        // Permissive CSP: allow the file's own scripts + our injected
        // widget. Same-origin only, no remote hosts. This matches what
        // opening the file directly in the browser would allow.
        res.setHeader(
          'Content-Security-Policy',
          [
            "default-src 'self' data: blob:",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "connect-src 'self'",
            "frame-ancestors 'self'",
          ].join('; ')
        )
      } else {
        // Lockdown CSP for the sandbox iframe embed path (default).
        res.setHeader(
          'Content-Security-Policy',
          [
            "default-src 'self' data: blob:",
            "script-src 'none'",
            "connect-src 'none'",
            "form-action 'none'",
            "frame-ancestors 'self'",
            "base-uri 'self'",
          ].join('; ')
        )
      }
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')

      let body = await fs.readFile(fullPath, 'utf-8')
      if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1)

      // Match doctype at the very start, ignoring any HTML comments and
      // whitespace that precede it — otherwise generators that emit a
      // "<!-- generated at ... -->" line before the doctype get a second
      // doctype prepended, throwing the browser into quirks mode.
      const hasDoctype = /^(?:\s|<!--[\s\S]*?-->)*<!doctype/i.test(body)
      if (!hasDoctype) {
        body = '<!DOCTYPE html>\n' + body
      }

      if (commentsMode) {
        // Query-string base64 for the comments endpoint (standard
        // base64, `Buffer.from(x,'base64')` on the server). Different
        // alphabet than `encodedProject` in this path (URL-safe) so we
        // recompute rather than reuse.
        const projectB64 = Buffer.from(projectPath, 'utf-8').toString('base64')
        const overlay = buildCommentsOverlay({ projectB64, filePath })
        // Inject just before </body> if present, else append at the end.
        const bodyCloseIdx = body.search(/<\/body\s*>/i)
        if (bodyCloseIdx >= 0) {
          body = body.slice(0, bodyCloseIdx) + overlay + body.slice(bodyCloseIdx)
        } else {
          body = body + overlay
        }
      }

      res.send(body)
      return
    }

    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream')
    fs.createReadStream(fullPath).pipe(res)
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

    // HTML preview needs two guarantees for the file to render the way
    // the author saw it in the editor:
    //   1. UTF-8 charset in the header (accented characters, emoji, etc.
    //      — otherwise Chrome/Safari can decode as Latin-1 and mangle them).
    //   2. A doctype so the browser enters standards mode. Many docs
    //      generated by tools / hand-authored snippets start with a
    //      `<title>` or `<style>` fragment; without a doctype the page
    //      renders in quirks mode and CSS box-sizing / line-height / table
    //      layouts silently misbehave.
    //
    // For non-HTML files we keep the original streaming path (avoids
    // buffering PDFs / images).
    if (ext === 'html' || ext === 'htm') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')

      let body = await fs.readFile(fullPath, 'utf-8')
      // Strip any leading BOM (browsers handle it, but our doctype sniff
      // shouldn't be tripped by an invisible byte).
      if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1)

      const startsWithDoctype = /^(?:\s|<!--[\s\S]*?-->)*<!doctype/i.test(body)
      if (!startsWithDoctype) {
        // Prepend a doctype; browsers will still auto-generate <html> /
        // <body> around whatever fragment follows. Standards mode + a
        // correctly-declared charset are what the file was missing.
        body = '<!DOCTYPE html>\n' + body
      }
      res.send(body)
      return
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
