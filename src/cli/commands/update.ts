import { Command } from 'commander'
import { spawn } from 'child_process'
import execa from 'execa'
import chalk from 'chalk'
import { Output } from '../utils/output'
import { findRepoRoot, runBuild } from './restart'

/**
 * `orka update` — pull the latest source, reinstall, rebuild, refresh
 * system dependencies, and restart the server.
 *
 * Only meaningful for a linked-source install (`git clone` + `npm link`),
 * which is how Orka is developed and self-hosted. A published npm install
 * has no repo to pull, and updates through npm instead.
 *
 * The step order is deliberate: everything that can fail without
 * consequence runs BEFORE the server is touched. A failed pull, install,
 * or build leaves the running server exactly as it was, so a bad update
 * never takes Orka down — it just doesn't happen.
 */

/** One step's outcome, for the summary printed at the end. */
type StepStatus = 'done' | 'skipped' | 'failed'
interface StepResult {
  name: string
  status: StepStatus
  note?: string
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd: repoRoot })
  return stdout.trim()
}

/**
 * Refuse to pull over uncommitted work.
 *
 * Only MODIFIED tracked files block: those either abort the pull partway
 * or get dragged into a merge, and this command is meant to be run
 * without thinking, so it should never quietly touch local work.
 *
 * Untracked files deliberately do NOT block (`--untracked-files=no`).
 * A stray note or scratch script sitting in the repo can't conflict with
 * a fast-forward, and refusing over one would make `orka update` fail for
 * a reason that has nothing to do with updating. The one case that does
 * matter — an incoming commit that would clobber an untracked file — is
 * something git itself refuses, and that error surfaces from the pull.
 */
async function assertCleanTree(repoRoot: string): Promise<void> {
  const status = await git(repoRoot, ['status', '--porcelain', '--untracked-files=no'])
  if (!status) return
  const files = status.split('\n')
  Output.error(`The Orka repo has local changes to ${files.length} tracked file${files.length === 1 ? '' : 's'}:`)
  for (const line of files.slice(0, 10)) console.log(chalk.gray(`    ${line}`))
  if (files.length > 10) console.log(chalk.gray(`    … and ${files.length - 10} more`))
  Output.info('Commit, stash, or discard them first — update will not touch local work.')
  throw new Error('dirty working tree')
}

export function updateCommand(program: Command) {
  program
    .command('update')
    .description('Pull the latest Orka, reinstall, rebuild, and restart the server')
    .option('--no-prepare', 'Skip the system-dependency check (orka prepare)')
    .option('--no-restart', 'Update in place without restarting the server')
    .option('--force', 'Run the full sequence even when already up to date')
    .option('--dry-run', 'Show what would happen without changing anything')
    .action(async (opts) => {
      const steps: StepResult[] = []

      const repoRoot = findRepoRoot()
      if (!repoRoot) {
        Output.error('`orka update` needs a linked-source install (git clone + npm link).')
        Output.info('This looks like a published npm install — update it with:')
        Output.info('  npm install -g @enruana/claude-orka@latest')
        process.exitCode = 1
        return
      }
      Output.info(`Orka repo: ${chalk.cyan(repoRoot)}`)

      // ---- Preflight: is this actually a git checkout with a remote? ----
      try {
        await git(repoRoot, ['rev-parse', '--git-dir'])
      } catch {
        Output.error(`${repoRoot} is not a git repository — nothing to pull.`)
        process.exitCode = 1
        return
      }
      let branch: string
      try {
        branch = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
        // A detached HEAD has no upstream to pull from.
        if (branch === 'HEAD') throw new Error('detached')
        await git(repoRoot, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])
      } catch {
        Output.error(`Branch has no upstream to pull from (on "${branch! || 'detached HEAD'}").`)
        Output.info('Set one with: git branch --set-upstream-to origin/<branch>')
        process.exitCode = 1
        return
      }

      // ---- What's actually incoming? -----------------------------------
      let behind = 0
      try {
        await git(repoRoot, ['fetch', '--quiet'])
        const counts = await git(repoRoot, ['rev-list', '--left-right', '--count', `HEAD...${branch}@{upstream}`])
        const [, behindStr] = counts.split(/\s+/)
        behind = parseInt(behindStr, 10) || 0
      } catch (err: any) {
        Output.error(`git fetch failed: ${err?.shortMessage || err?.message || err}`)
        process.exitCode = 1
        return
      }

      if (behind === 0 && !opts.force) {
        Output.success(`Already up to date on ${chalk.cyan(branch)} — nothing to pull.`)
        Output.info('Use --force to reinstall and rebuild anyway.')
        return
      }
      if (behind > 0) {
        Output.info(`${behind} new commit${behind === 1 ? '' : 's'} on ${chalk.cyan(branch)}:`)
        const log = await git(repoRoot, ['log', '--oneline', `HEAD..${branch}@{upstream}`])
        for (const line of log.split('\n').slice(0, 10)) console.log(chalk.gray(`    ${line}`))
      }

      if (opts.dryRun) {
        Output.section('Dry run — would then:')
        Output.info('  git pull --ff-only')
        Output.info('  npm install')
        Output.info('  npm run build')
        if (opts.prepare) Output.info('  orka prepare --yes')
        if (opts.restart) Output.info('  orka restart')
        return
      }

      // ---- 1. Pull ------------------------------------------------------
      if (behind > 0) {
        try {
          await assertCleanTree(repoRoot)
          Output.section('Pulling…')
          // --ff-only on purpose: if local commits have diverged from the
          // remote, stop rather than silently authoring a merge commit in
          // the user's repo.
          await execa('git', ['pull', '--ff-only'], { cwd: repoRoot, stdio: 'inherit' })
          steps.push({ name: 'git pull', status: 'done', note: `${behind} commit${behind === 1 ? '' : 's'}` })
        } catch (err: any) {
          if (err?.message !== 'dirty working tree') {
            Output.error(`git pull failed: ${err?.shortMessage || err?.message || err}`)
            Output.info('Local commits may have diverged from the remote. Resolve it manually, then re-run.')
          }
          Output.info('Server was NOT restarted.')
          process.exitCode = 1
          return
        }
      } else {
        steps.push({ name: 'git pull', status: 'skipped', note: 'already current' })
      }

      // ---- 2. Install ---------------------------------------------------
      try {
        Output.section('Installing dependencies…')
        await execa('npm', ['install'], { cwd: repoRoot, stdio: 'inherit' })
        steps.push({ name: 'npm install', status: 'done' })
      } catch (err: any) {
        Output.error(`npm install failed: ${err?.shortMessage || err?.message || err}`)
        Output.info('Server was NOT restarted.')
        process.exitCode = 1
        return
      }

      // ---- 3. Build -----------------------------------------------------
      //
      // Not optional, and not implied by `npm install`: `dist/` is
      // gitignored and this package has no npm `prepare` script, so a
      // fresh pull leaves only source behind. Skipping this would restart
      // the server onto the PREVIOUS build and make the update look like
      // it did nothing.
      try {
        Output.section('Building…')
        await runBuild(repoRoot)
        steps.push({ name: 'npm run build', status: 'done' })
      } catch (err: any) {
        Output.error(`Build failed: ${err?.shortMessage || err?.message || err}`)
        Output.info('Server was NOT restarted — it is still running the previous build.')
        process.exitCode = 1
        return
      }

      // ---- 4. System dependencies ---------------------------------------
      //
      // Non-fatal: these are host packages (tmux, ttyd, espeak-ng…) that
      // may need sudo or a package manager we can't drive unattended. A
      // new release can introduce one — espeak-ng did — so it's worth
      // running, but failing here shouldn't block a restart that would
      // otherwise succeed.
      if (opts.prepare) {
        try {
          Output.section('Checking system dependencies…')
          await execa(process.execPath, [process.argv[1], 'prepare', '--yes'], {
            cwd: repoRoot,
            stdio: 'inherit',
          })
          steps.push({ name: 'orka prepare', status: 'done' })
        } catch (err: any) {
          Output.warn(`orka prepare did not finish cleanly: ${err?.shortMessage || err?.message || err}`)
          Output.info('Continuing — run `orka doctor` to see what is missing.')
          steps.push({ name: 'orka prepare', status: 'failed', note: 'see orka doctor' })
        }
      } else {
        steps.push({ name: 'orka prepare', status: 'skipped', note: '--no-prepare' })
      }

      // ---- 5. Restart ----------------------------------------------------
      //
      // Re-exec rather than calling restart inline: the build above just
      // rewrote the very bundle this process is running from, and a fresh
      // process is what picks up the new code.
      if (opts.restart) {
        Output.section('Restarting server…')
        const child = spawn(process.execPath, [process.argv[1], 'restart'], {
          stdio: 'inherit',
          env: { ...process.env },
          cwd: process.cwd(),
        })
        const code: number = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 0)))
        steps.push({
          name: 'orka restart',
          status: code === 0 ? 'done' : 'failed',
          note: code === 0 ? undefined : `exit ${code}`,
        })
      } else {
        steps.push({ name: 'orka restart', status: 'skipped', note: '--no-restart' })
      }

      // ---- Summary -------------------------------------------------------
      Output.section('Update summary')
      for (const s of steps) {
        const mark =
          s.status === 'done' ? chalk.green('✓') :
          s.status === 'skipped' ? chalk.gray('–') :
          chalk.yellow('!')
        console.log(`  ${mark} ${s.name}${s.note ? chalk.gray(` (${s.note})`) : ''}`)
      }
      const version = await git(repoRoot, ['rev-parse', '--short', 'HEAD']).catch(() => '')
      if (version) Output.info(`Now on commit ${chalk.cyan(version)}`)
      if (steps.some((s) => s.status === 'failed')) process.exitCode = 1
    })
}
