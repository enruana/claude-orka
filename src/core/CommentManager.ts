import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs-extra'
import { StateManager } from './StateManager'
import { ProjectComment } from '../models'

/**
 * Review comments — the single implementation shared by the CLI
 * (`orka comment`), the HTTP API, and the web UI.
 *
 * ## Where comments live
 *
 * `.claude-orka/state.json` → `comments[]`, one flat project-wide array
 * scoped per document by `filePath`. All mutations go through
 * `StateManager`, which holds the file lock, so the CLI and a running
 * server can write concurrently without clobbering each other.
 *
 * ## How a comment is anchored
 *
 * The real anchor is `selectedText` — the verbatim phrase the reviewer
 * highlighted. `startLine`/`endLine` are DERIVED from it by an
 * `indexOf` into the raw file, and that lookup fails whenever the
 * rendered text differs from the source: selecting a sentence in a
 * rendered HTML page or a formatted markdown preview finds no match in
 * the marked-up source, and both viewers fall back to line 1.
 *
 * Practical consequence, and the reason `formatComments` leads with the
 * snippet rather than the line range: for HTML and markdown the line
 * numbers are a hint, not an address. Treat `selectedText` as the
 * locator and the lines as corroboration.
 */

/**
 * A comment id didn't resolve — unknown, or an ambiguous prefix. This is
 * an expected outcome of user input, not a fault, so callers can render
 * it as a plain message instead of an unexpected-error stack dump.
 */
export class CommentLookupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommentLookupError'
  }
}

/** Comment intents the apply-protocol prompt asks Claude to sort by. */
export const COMMENT_CLASSIFICATIONS = ['EDIT', 'RECOMMENDATION', 'QUESTION', 'REGENERATE'] as const

/** Longest snippet echoed into a prompt before truncation. Matches what
 *  the web UI has always emitted so prompts stay byte-comparable. */
const SNIPPET_MAX = 240

export interface AddCommentInput {
  filePath: string
  body: string
  selectedText?: string
  startLine?: number
  endLine?: number
}

export interface CommentFilter {
  /** Match one file exactly (project-relative, as stored). */
  filePath?: string
  /** true → only resolved, false → only unresolved, undefined → both. */
  resolved?: boolean
}

function folderOf(filePath: string): string {
  const idx = filePath.lastIndexOf('/')
  return idx === -1 ? '.' : filePath.slice(0, idx)
}

function lineLabel(c: ProjectComment): string {
  return c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-${c.endLine}`
}

function snippet(text: string): string {
  return text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) + '…' : text
}

/**
 * Resolve `selectedText` to a 1-based line range in the file on disk.
 *
 * Mirrors what the browser-side viewers do, with one addition: a
 * whitespace-collapsed second pass. Rendered HTML collapses runs of
 * whitespace, so a phrase copied out of a rendered page rarely matches
 * the source byte-for-byte even when the words are all there. Trying
 * the collapsed form recovers a usable line number in exactly the case
 * the naive `indexOf` gives up on and returns 1.
 *
 * Returns `{ startLine: 1, endLine: 1 }` when the file can't be read or
 * the phrase genuinely isn't present.
 */
export async function resolveLineRange(
  projectPath: string,
  filePath: string,
  selectedText: string
): Promise<{ startLine: number; endLine: number }> {
  const fallback = { startLine: 1, endLine: 1 }
  if (!selectedText) return fallback

  const abs = path.resolve(projectPath, filePath)
  // Never read outside the project — filePath comes from CLI args.
  if (!abs.startsWith(path.resolve(projectPath))) return fallback

  let source: string
  try {
    source = await fs.readFile(abs, 'utf-8')
  } catch {
    return fallback
  }

  const countLines = (upTo: string) => (upTo.match(/\n/g) || []).length + 1
  const spanOf = (text: string) => (text.match(/\n/g) || []).length

  const direct = source.indexOf(selectedText)
  if (direct >= 0) {
    const startLine = countLines(source.slice(0, direct))
    return { startLine, endLine: startLine + spanOf(selectedText) }
  }

  // Collapsed pass. Build an index mapping each character of the
  // collapsed source back to its offset in the original, so a hit
  // translates into a real line number.
  const map: number[] = []
  let collapsed = ''
  let inRun = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (/\s/.test(ch)) {
      if (inRun) continue
      inRun = true
      map.push(i)
      collapsed += ' '
    } else {
      inRun = false
      map.push(i)
      collapsed += ch
    }
  }
  const needle = selectedText.replace(/\s+/g, ' ').trim()
  if (!needle) return fallback
  const hit = collapsed.indexOf(needle)
  if (hit < 0) return fallback

  const startOffset = map[hit]
  const endOffset = map[Math.min(hit + needle.length - 1, map.length - 1)]
  return {
    startLine: countLines(source.slice(0, startOffset)),
    endLine: countLines(source.slice(0, endOffset)),
  }
}

/**
 * CRUD + prompt composition over one project's review comments.
 */
export class CommentManager {
  private stateManager: StateManager

  constructor(private projectPath: string) {
    this.stateManager = new StateManager(projectPath)
  }

  async list(filter: CommentFilter = {}): Promise<ProjectComment[]> {
    let comments = await this.stateManager.listComments()
    if (filter.filePath !== undefined) {
      comments = comments.filter((c) => c.filePath === filter.filePath)
    }
    if (filter.resolved !== undefined) {
      comments = comments.filter((c) => c.resolved === filter.resolved)
    }
    return comments
  }

  async get(commentId: string): Promise<ProjectComment | null> {
    const comments = await this.stateManager.listComments()
    return comments.find((c) => c.id === commentId) ?? null
  }

  /**
   * Resolve an id the way a human types it: a full uuid, or any unique
   * prefix of one (the CLI prints 8-char short ids). Ambiguous prefixes
   * throw rather than guessing.
   */
  async resolveId(idOrPrefix: string): Promise<ProjectComment> {
    // An empty prefix would `startsWith`-match every comment and report
    // itself as ambiguous, which tells the user nothing useful.
    if (!idOrPrefix) throw new CommentLookupError('A comment id is required')

    const comments = await this.stateManager.listComments()
    const exact = comments.find((c) => c.id === idOrPrefix)
    if (exact) return exact

    const matches = comments.filter((c) => c.id.startsWith(idOrPrefix))
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) {
      throw new CommentLookupError(`No comment matches "${idOrPrefix}"`)
    }
    throw new CommentLookupError(
      `Ambiguous comment id "${idOrPrefix}" — matches ${matches.length}: ` +
      matches.map((m) => m.id.slice(0, 8)).join(', ')
    )
  }

  async add(input: AddCommentInput): Promise<ProjectComment> {
    if (!input.filePath) throw new Error('filePath is required')
    if (!input.body) throw new Error('body is required')

    const selectedText = input.selectedText ?? ''

    // Explicit lines win; otherwise derive them from the snippet.
    let startLine = input.startLine
    let endLine = input.endLine
    if (startLine === undefined || endLine === undefined) {
      const derived = await resolveLineRange(this.projectPath, input.filePath, selectedText)
      startLine = startLine ?? derived.startLine
      endLine = endLine ?? derived.endLine
    }

    const comment: ProjectComment = {
      id: uuidv4(),
      filePath: input.filePath,
      startLine: Number(startLine),
      endLine: Number(endLine),
      selectedText,
      body: input.body,
      resolved: false,
      createdAt: new Date().toISOString(),
    }
    await this.stateManager.addComment(comment)
    return comment
  }

  async setResolved(commentId: string, resolved: boolean): Promise<ProjectComment> {
    return this.stateManager.updateComment(commentId, { resolved })
  }

  async setBody(commentId: string, body: string): Promise<ProjectComment> {
    return this.stateManager.updateComment(commentId, { body })
  }

  async delete(commentId: string): Promise<void> {
    await this.stateManager.deleteComment(commentId)
  }

  /**
   * Bulk delete. Returns the comments that were removed so the caller
   * can report exactly what went — a count alone hides mistakes on a
   * destructive operation.
   */
  async clear(filter: CommentFilter = {}): Promise<ProjectComment[]> {
    const doomed = await this.list(filter)
    for (const c of doomed) {
      await this.stateManager.deleteComment(c.id)
    }
    return doomed
  }

  // ----------------------------------------------------------------
  // Prompt composition
  // ----------------------------------------------------------------

  /**
   * Render one comment: line range, the selected snippet (fenced), then
   * the body as a blockquote. Snippet before line range on purpose —
   * see the anchoring note at the top of this file for why the snippet
   * is the address and the lines are only corroboration.
   */
  private static formatOne(c: ProjectComment): string {
    let out = `**${lineLabel(c)}**`
    if (c.selectedText) {
      out += ` — selected:\n\n\`\`\`\n${snippet(c.selectedText)}\n\`\`\`\n\n`
    } else {
      out += '\n\n'
    }
    return out + `> ${c.body.replace(/\n/g, '\n> ')}\n\n`
  }

  /**
   * Render comments grouped under a `### File:` header each. For the
   * multi-file apply prompt, where the model needs to know which
   * document each comment belongs to.
   */
  static formatComments(comments: ProjectComment[]): string {
    const byFile = new Map<string, ProjectComment[]>()
    for (const c of comments) {
      const list = byFile.get(c.filePath) || []
      list.push(c)
      byFile.set(c.filePath, list)
    }

    let out = ''
    for (const [file, fileComments] of byFile) {
      out += `\n### File: \`${file}\`\n\n`
      for (const c of fileComments) out += CommentManager.formatOne(c)
    }
    return out
  }

  /**
   * Render comments with no file headers — the regenerate prompt names
   * its one target document up front, so repeating it per comment is
   * noise.
   */
  static formatCommentsFlat(comments: ProjectComment[]): string {
    return comments.map((c) => '\n' + CommentManager.formatOne(c)).join('')
  }

  /**
   * The "apply these comments" protocol prompt: classify each comment
   * by intent, handle it accordingly, and leave a paper trail.
   */
  static buildApplyPrompt(comments: ProjectComment[]): string {
    const byFile = new Map<string, ProjectComment[]>()
    for (const c of comments) {
      const list = byFile.get(c.filePath) || []
      list.push(c)
      byFile.set(c.filePath, list)
    }
    const fileCount = byFile.size
    const folderCount = new Set([...byFile.keys()].map(folderOf)).size
    const s = (n: number) => (n === 1 ? '' : 's')

    const preamble = [
      `You've received ${comments.length} review comment${s(comments.length)} across ${fileCount} file${s(fileCount)} in ${folderCount} folder${s(folderCount)}. Process them all in one pass following this protocol:`,
      '',
      '## 1. Classify each comment',
      '',
      '- **EDIT** — a specific change to make in place.',
      '- **RECOMMENDATION** — a suggestion to consider; act on it if you agree.',
      '- **QUESTION** — an open question that needs investigation before acting.',
      '- **REGENERATE** — a request to rewrite a section or the whole document.',
      '',
      '## 2. Handle each',
      '',
      '- **EDIT** → apply the change directly.',
      '- **RECOMMENDATION** → apply if the tradeoff makes sense. If not, briefly note why in the log.',
      '- **QUESTION** → investigate first (read the referenced code + related tickets + do a deep-research pass if the answer is external), then apply the resolution or record the finding if no action is needed.',
      '- **REGENERATE** → produce the rewrite. If the comment names specific sections or points, weave them in explicitly.',
      '',
      '## 3. Keep a paper trail',
      '',
      'Choose the log destination per file type — HTML docs get an embedded',
      'changelog (subtle, at the bottom of the file); other files use the',
      'project-level markdown log.',
      '',
      '### If the target file is `.html`',
      '',
      'The document has a `<section class="changelog">` at the bottom with',
      'a `<ul>` of entries. **Prepend** a new `<li>` (most recent first)',
      'with a bumped version — small fix `v1.0 → v1.1`, larger revision or',
      'regen `v1.x → v2.0`. Also update the `.meta` line at the end that',
      'shows "Versión actual: vX.Y".',
      '',
      'Entry shape:',
      '',
      '```html',
      '<li data-version="v1.1">',
      '  <span class="ver">v1.1</span>',
      '  <span class="when">2026-07-24</span>',
      '  <strong>EDIT · <file>:<lines></strong> — one-line description of what',
      '  changed and why, plus any research links inline.',
      '</li>',
      '```',
      '',
      'Group multiple comments applied in one pass into a single `<li>` with',
      'a nested `<ul>` if that keeps the log readable.',
      '',
      '### For any other file type',
      '',
      'Append a Markdown entry to `.claude-orka/comments/log.md` at the',
      'project root (create the folder if needed) so we still have a paper',
      'trail without polluting the source with comments:',
      '',
      '```',
      '### <ISO timestamp> · <file>:<lines>',
      '',
      '**Classification:** EDIT | RECOMMENDATION | QUESTION | REGENERATE',
      '',
      '**Original comment:**',
      '> <the comment body>',
      '',
      '**Action taken:** <what you did, links to files/PRs, or "deferred: <reason>">',
      '',
      '**Notes/research:** <optional — findings, links, next steps>',
      '```',
      '',
      '## 4. Summary at the end',
      '',
      'Print a compact summary in the terminal: N applied, N researched, N regenerated, N deferred. Include a one-line reason for each deferred item.',
      '',
      '## 5. Close them out',
      '',
      'Mark every comment you actually resolved with `orka comment resolve <id>`',
      '(ids are listed with `orka comment list --unresolved`). Leave the ones you',
      'deferred open so they still show up in the next pass.',
      '',
      '---',
      '',
      '## Comments',
      '',
    ]

    return preamble.join('\n') + CommentManager.formatComments(comments)
  }

  /**
   * Single-file rewrite prompt: rebuild the document from scratch with
   * every unresolved comment woven in, reading prior resolutions first
   * so decisions stay consistent across regens.
   */
  static buildRegeneratePrompt(filePath: string, comments: ProjectComment[]): string {
    const isHtml = /\.html?$/i.test(filePath)
    const parts = [
      `Regenerate the document \`${filePath}\` from scratch, incorporating the review comments below and any prior resolutions.`,
      '',
      '## Steps',
      '',
      '1. Read the current file to understand its structure and intent.',
      isHtml
        ? '2. Read the `<section class="changelog">` at the bottom to see prior versions and what each addressed — keep decisions consistent across regens.'
        : '2. Read the comments log at `.claude-orka/comments/log.md` and grep it for prior entries referencing this file.',
      '3. For each comment below, treat it as scoped feedback. **QUESTION**-type comments must be investigated (read code, related tickets, or do a deep-research pass) before being reflected in the rewrite.',
      '4. Rewrite the document from scratch, preserving its intent and structure but resolving every comment.',
      `5. Save the new content with the \`Write\` tool (full-file replacement, not patch). Path: \`${filePath}\`.`,
      isHtml
        ? '6. Bump the version (major bump for a regen: `v1.x → v2.0`, chain further regens as `v3.0`, `v4.0`, etc.). Prepend a new `<li>` to the changelog with the version, ISO date, and a one-paragraph summary of what changed AND which comments it resolved (reference them inline). Update the `.meta` line to show the new "Versión actual".'
        : '6. Append a **REGENERATE** entry to `.claude-orka/comments/log.md` with the version, timestamp, and what changed.',
      '',
      '## Comments to incorporate',
      '',
    ]

    return (
      parts.join('\n') +
      CommentManager.formatCommentsFlat(comments) +
      '\nAfter saving, print a compact summary: what sections you changed, which comments you weaved in, and any research/deep-dive links.\n' +
      '\nThen close out the comments you resolved with `orka comment resolve <id>`.\n'
    )
  }
}
