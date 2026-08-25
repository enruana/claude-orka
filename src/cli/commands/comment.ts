import { Command } from 'commander'
import chalk from 'chalk'
import path from 'path'
import { Output } from '../utils/output'
import { handleError, CLIError } from '../utils/errors'
import { CommentManager, CommentLookupError } from '../../core/CommentManager'
import { ProjectComment } from '../../models'

/**
 * `orka comment *` — read/write review comments from the terminal.
 *
 * Same store the web UI writes to (`.claude-orka/state.json` →
 * `comments[]`, via StateManager's lock), so a Claude session and an
 * open browser tab stay in sync without either knowing about the other.
 *
 * The reason this exists: until now the only way to get comments in
 * front of an LLM was the UI's "Apply with Claude" button, which
 * composes a prompt and copies it to the CLIPBOARD for a human to paste.
 * An agent in a terminal had no way to read comments at all, and no way
 * to close one out after acting on it. Every subcommand takes `--json`
 * so it can be consumed programmatically.
 */

/**
 * Look one comment up, turning a bad id into a one-line CLI error.
 * Without this, handleError() classifies the lookup failure as an
 * unexpected error and prints a stack trace at the user for what is
 * really just a typo.
 */
async function lookup(mgr: CommentManager, id: string): Promise<ProjectComment> {
  try {
    return await mgr.resolveId(id)
  } catch (err) {
    if (err instanceof CommentLookupError) throw new CLIError(err.message)
    throw err
  }
}

/** Short id shown in listings — full uuids make the output unreadable,
 *  and every command accepts any unique prefix. */
function shortId(id: string): string {
  return id.slice(0, 8)
}

function lineLabel(c: ProjectComment): string {
  return c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-${c.endLine}`
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return iso
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** One comment, grouped-listing form (the file header is printed by the
 *  caller so it isn't repeated per comment). */
function printComment(c: ProjectComment): void {
  const status = c.resolved ? chalk.green('✓') : chalk.yellow('○')
  console.log(`  ${status} ${chalk.bold(shortId(c.id))}  ${chalk.gray(lineLabel(c))}  ${chalk.gray(relTime(c.createdAt))}`)
  if (c.selectedText) {
    const oneLine = c.selectedText.replace(/\s+/g, ' ').trim()
    const clipped = oneLine.length > 72 ? oneLine.slice(0, 72) + '…' : oneLine
    console.log(`      ${chalk.gray('“' + clipped + '”')}`)
  }
  for (const line of c.body.split('\n')) {
    console.log(`      ${line}`)
  }
  console.log()
}

function printGrouped(comments: ProjectComment[]): void {
  const byFile = new Map<string, ProjectComment[]>()
  for (const c of comments) {
    const list = byFile.get(c.filePath) || []
    list.push(c)
    byFile.set(c.filePath, list)
  }
  for (const [file, fileComments] of byFile) {
    const open = fileComments.filter((c) => !c.resolved).length
    console.log(
      chalk.bold.cyan(file) +
      chalk.gray(`  (${fileComments.length} comment${fileComments.length === 1 ? '' : 's'}` +
        (open ? `, ${open} open` : '') + ')')
    )
    for (const c of fileComments) printComment(c)
  }
}

/**
 * Read the whole of stdin. Used for `--body -`, so an agent can pipe a
 * multi-line comment body in without fighting shell quoting.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/**
 * Normalize a user-supplied path to the project-relative form the store
 * uses. Accepts absolute paths and `./x` alike so tab-completed paths
 * work, and refuses anything outside the project — a comment anchored
 * outside the tree would never render in any viewer.
 */
function normalizeFilePath(projectPath: string, input: string): string {
  const abs = path.resolve(projectPath, input)
  const root = path.resolve(projectPath)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new CLIError(`File is outside the project: ${input}`)
  }
  return path.relative(root, abs)
}

export function commentCommand(program: Command): void {
  const comment = program
    .command('comment')
    .description('Read and write document review comments')

  // ---------------- list ----------------

  comment
    .command('list')
    .alias('ls')
    .description('List review comments (defaults to all)')
    .option('--file <path>', 'Only comments on this file')
    .option('--unresolved', 'Only open comments')
    .option('--resolved', 'Only resolved comments')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        if (opts.unresolved && opts.resolved) {
          throw new CLIError('--unresolved and --resolved are mutually exclusive')
        }
        const projectPath = process.cwd()
        const mgr = new CommentManager(projectPath)
        const comments = await mgr.list({
          filePath: opts.file ? normalizeFilePath(projectPath, opts.file) : undefined,
          resolved: opts.unresolved ? false : opts.resolved ? true : undefined,
        })

        if (opts.json) {
          Output.json(comments)
          return
        }

        if (comments.length === 0) {
          Output.warn('No comments found')
          return
        }

        const open = comments.filter((c) => !c.resolved).length
        Output.header(`💬 ${comments.length} comment${comments.length === 1 ? '' : 's'} (${open} open)`)
        console.log()
        printGrouped(comments)
      } catch (error) {
        handleError(error)
      }
    })

  // ---------------- show ----------------

  comment
    .command('show <id>')
    .description('Show one comment in full (id or unique prefix)')
    .option('--json', 'Output as JSON')
    .action(async (id, opts) => {
      try {
        const mgr = new CommentManager(process.cwd())
        const c = await lookup(mgr, id)

        if (opts.json) {
          Output.json(c)
          return
        }

        Output.header(`💬 Comment ${shortId(c.id)}`)
        console.log(`  ${chalk.gray('Id:')} ${c.id}`)
        console.log(`  ${chalk.gray('File:')} ${c.filePath}`)
        console.log(`  ${chalk.gray('Lines:')} ${lineLabel(c)}`)
        console.log(`  ${chalk.gray('Status:')} ${c.resolved ? chalk.green('resolved') : chalk.yellow('open')}`)
        console.log(`  ${chalk.gray('Created:')} ${new Date(c.createdAt).toLocaleString()}`)
        if (c.resolvedAt) {
          console.log(`  ${chalk.gray('Resolved:')} ${new Date(c.resolvedAt).toLocaleString()}`)
        }
        if (c.selectedText) {
          Output.section('Selected text')
          console.log(chalk.gray(c.selectedText))
        }
        Output.section('Comment')
        console.log(c.body)
      } catch (error) {
        handleError(error)
      }
    })

  // ---------------- add ----------------

  comment
    .command('add')
    .description('Add a review comment to a file')
    .requiredOption('--file <path>', 'File the comment is about')
    .requiredOption('--body <text>', 'Comment body (use "-" to read from stdin)')
    .option('--text <snippet>', 'The passage being commented on — this is the real anchor')
    .option('--start-line <n>', 'Explicit start line (otherwise derived from --text)', parseInt)
    .option('--end-line <n>', 'Explicit end line (otherwise derived from --text)', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const projectPath = process.cwd()
        const filePath = normalizeFilePath(projectPath, opts.file)
        const body = opts.body === '-' ? (await readStdin()).trim() : opts.body
        if (!body) throw new CLIError('Comment body is empty')

        const mgr = new CommentManager(projectPath)
        const created = await mgr.add({
          filePath,
          body,
          selectedText: opts.text,
          startLine: opts.startLine,
          endLine: opts.endLine,
        })

        if (opts.json) {
          Output.json(created)
          return
        }

        Output.success(`Comment ${chalk.bold(shortId(created.id))} added on ${chalk.cyan(filePath)} ${chalk.gray(lineLabel(created))}`)
        // A silent fallback to L1 looks like a successful anchor until
        // someone opens the file and finds the highlight in the wrong
        // place, so say it out loud.
        if (opts.text && created.startLine === 1 && created.endLine === 1 && !opts.startLine) {
          Output.warn(
            'Could not locate that snippet in the file — anchored at line 1. ' +
            'Rendered HTML/markdown often differs from the source; pass --start-line to pin it.'
          )
        }
      } catch (error) {
        handleError(error)
      }
    })

  // ---------------- edit ----------------

  comment
    .command('edit <id>')
    .description('Rewrite a comment body')
    .requiredOption('--body <text>', 'New body (use "-" to read from stdin)')
    .option('--json', 'Output as JSON')
    .action(async (id, opts) => {
      try {
        const mgr = new CommentManager(process.cwd())
        const target = await lookup(mgr, id)
        const body = opts.body === '-' ? (await readStdin()).trim() : opts.body
        if (!body) throw new CLIError('Comment body is empty')

        const updated = await mgr.setBody(target.id, body)
        if (opts.json) {
          Output.json(updated)
          return
        }
        Output.success(`Comment ${chalk.bold(shortId(updated.id))} updated`)
      } catch (error) {
        handleError(error)
      }
    })

  // ---------------- resolve / unresolve ----------------

  comment
    .command('resolve <id>')
    .description('Mark a comment resolved')
    .option('--json', 'Output as JSON')
    .action(async (id, opts) => {
      try {
        const mgr = new CommentManager(process.cwd())
        const target = await lookup(mgr, id)
        const updated = await mgr.setResolved(target.id, true)
        if (opts.json) {
          Output.json(updated)
          return
        }
        Output.success(`Comment ${chalk.bold(shortId(updated.id))} resolved ${chalk.gray('· ' + updated.filePath)}`)
      } catch (error) {
        handleError(error)
      }
    })

  comment
    .command('unresolve <id>')
    .description('Reopen a resolved comment')
    .option('--json', 'Output as JSON')
    .action(async (id, opts) => {
      try {
        const mgr = new CommentManager(process.cwd())
        const target = await lookup(mgr, id)
        const updated = await mgr.setResolved(target.id, false)
        if (opts.json) {
          Output.json(updated)
          return
        }
        Output.success(`Comment ${chalk.bold(shortId(updated.id))} reopened`)
      } catch (error) {
        handleError(error)
      }
    })

  // ---------------- delete ----------------

  comment
    .command('delete <id>')
    .alias('rm')
    .description('Delete a comment permanently')
    .action(async (id) => {
      try {
        const mgr = new CommentManager(process.cwd())
        const target = await lookup(mgr, id)
        await mgr.delete(target.id)
        Output.success(`Comment ${chalk.bold(shortId(target.id))} deleted ${chalk.gray('· ' + target.filePath)}`)
      } catch (error) {
        handleError(error)
      }
    })

  // ---------------- clear ----------------

  comment
    .command('clear')
    .description('Bulk-delete comments (requires an explicit scope)')
    .option('--file <path>', 'Only comments on this file')
    .option('--resolved', 'Only resolved comments')
    .option('--all', 'Every comment in the project')
    .option('--yes', 'Skip the confirmation prompt')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        if (!opts.file && !opts.resolved && !opts.all) {
          throw new CLIError(
            'Refusing to clear without a scope. Pass --resolved, --file <path>, or --all.'
          )
        }
        const projectPath = process.cwd()
        const mgr = new CommentManager(projectPath)
        const filter = {
          filePath: opts.file ? normalizeFilePath(projectPath, opts.file) : undefined,
          resolved: opts.resolved ? true : undefined,
        }

        const doomed = await mgr.list(filter)
        if (doomed.length === 0) {
          if (opts.json) {
            Output.json({ deleted: 0, comments: [] })
            return
          }
          Output.warn('Nothing to clear')
          return
        }

        // Deleting resolved comments throws away a record of finished
        // work; deleting OPEN ones throws away feedback nobody has acted
        // on yet. Only the second is worth blocking on.
        const openCount = doomed.filter((c) => !c.resolved).length
        if (openCount > 0 && !opts.yes) {
          Output.warn(
            `This would delete ${doomed.length} comment${doomed.length === 1 ? '' : 's'}, ` +
            `including ${openCount} that ${openCount === 1 ? 'is' : 'are'} still open.`
          )
          console.log()
          printGrouped(doomed)
          Output.info('Re-run with --yes to confirm, or use --resolved to only clear finished ones.')
          process.exit(1)
        }

        const deleted = await mgr.clear(filter)
        if (opts.json) {
          Output.json({ deleted: deleted.length, comments: deleted })
          return
        }
        Output.success(`Deleted ${deleted.length} comment${deleted.length === 1 ? '' : 's'}`)
      } catch (error) {
        handleError(error)
      }
    })

  // ---------------- prompt ----------------

  comment
    .command('prompt')
    .description('Print the LLM prompt for acting on comments (stdout)')
    .option('--file <path>', 'Only comments on this file')
    .option('--regenerate', 'Full-document rewrite prompt (requires --file)')
    .option('--include-resolved', 'Include already-resolved comments')
    .action(async (opts) => {
      try {
        const projectPath = process.cwd()
        const mgr = new CommentManager(projectPath)
        const filePath = opts.file ? normalizeFilePath(projectPath, opts.file) : undefined

        if (opts.regenerate && !filePath) {
          throw new CLIError('--regenerate rewrites one document — pass --file <path>')
        }

        const comments = await mgr.list({
          filePath,
          resolved: opts.includeResolved ? undefined : false,
        })

        if (comments.length === 0) {
          // stderr, so `orka comment prompt | claude` pipes cleanly and
          // an empty run doesn't feed a stray line into the model.
          Output.warn(filePath ? `No open comments on ${filePath}` : 'No open comments')
          process.exit(1)
        }

        console.log(
          opts.regenerate
            ? CommentManager.buildRegeneratePrompt(filePath!, comments)
            : CommentManager.buildApplyPrompt(comments)
        )
      } catch (error) {
        handleError(error)
      }
    })
}
