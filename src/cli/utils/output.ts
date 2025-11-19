import chalk from 'chalk'
import Table from 'cli-table3'
import { Session, Fork, ProjectSummary } from '../../models/index'

/**
 * Output utilities for CLI
 */
export class Output {
  /**
   * Success message
   */
  static success(message: string) {
    console.log(chalk.green('✓'), message)
  }

  /**
   * Error message
   */
  static error(message: string) {
    console.error(chalk.red('✗'), message)
  }

  /**
   * Warning message
   */
  static warn(message: string) {
    console.warn(chalk.yellow('⚠'), message)
  }

  /**
   * Info message
   */
  static info(message: string) {
    console.log(chalk.blue('ℹ'), message)
  }

  /**
   * Header
   */
  static header(message: string) {
    console.log('\n' + chalk.bold.cyan(message))
    console.log(chalk.gray('─'.repeat(message.length)))
  }

  /**
   * Section
   */
  static section(title: string) {
    console.log('\n' + chalk.bold(title))
  }

  /**
   * Display session details
   */
  static session(session: Session) {
    const statusColor = session.status === 'active' ? chalk.green : chalk.yellow
    const statusEmoji = session.status === 'active' ? '✓' : '💾'

    console.log(`\n${statusEmoji} ${chalk.bold(session.name)}`)
    console.log(`  ${chalk.gray('ID:')} ${session.id}`)
    console.log(`  ${chalk.gray('Claude Session:')} ${session.main.claudeSessionId}`)
    console.log(`  ${chalk.gray('Status:')} ${statusColor(session.status)}`)
    console.log(`  ${chalk.gray('Created:')} ${new Date(session.createdAt).toLocaleString()}`)
    console.log(`  ${chalk.gray('Last Activity:')} ${new Date(session.lastActivity).toLocaleString()}`)

    if (session.status === 'active') {
      console.log(`  ${chalk.gray('Tmux Session:')} ${session.tmuxSessionId}`)
    }

    if (session.forks.length > 0) {
      console.log(`  ${chalk.gray('Forks:')} ${session.forks.length}`)
      console.log(
        `    ${chalk.green('Active:')} ${session.forks.filter((f) => f.status === 'active').length}`
      )
      console.log(
        `    ${chalk.yellow('Saved:')} ${session.forks.filter((f) => f.status === 'saved').length}`
      )
      console.log(
        `    ${chalk.blue('Merged:')} ${session.forks.filter((f) => f.status === 'merged').length}`
      )
    }
  }

  /**
   * Display fork details
   */
  static fork(fork: Fork) {
    const statusColor =
      fork.status === 'active'
        ? chalk.green
        : fork.status === 'merged'
          ? chalk.blue
          : chalk.yellow
    const statusEmoji = fork.status === 'active' ? '✓' : fork.status === 'merged' ? '🔀' : '💾'

    console.log(`\n  ${statusEmoji} ${chalk.bold(fork.name)}`)
    console.log(`    ${chalk.gray('ID:')} ${fork.id}`)
    console.log(`    ${chalk.gray('Claude Session:')} ${fork.claudeSessionId}`)
    console.log(`    ${chalk.gray('Status:')} ${statusColor(fork.status)}`)
    console.log(`    ${chalk.gray('Created:')} ${new Date(fork.createdAt).toLocaleString()}`)

    if (fork.status === 'active' && fork.tmuxPaneId) {
      console.log(`    ${chalk.gray('Tmux Pane:')} ${fork.tmuxPaneId}`)
    }

    if (fork.contextPath) {
      console.log(`    ${chalk.gray('Export:')} ${fork.contextPath}`)
    }

    if (fork.mergedToMain && fork.mergedAt) {
      console.log(
        `    ${chalk.gray('Merged:')} ${new Date(fork.mergedAt).toLocaleString()}`
      )
    }
  }

  /**
   * Display sessions table
   */
  static sessionsTable(sessions: Session[]) {
    if (sessions.length === 0) {
      this.warn('No sessions found')
      return
    }

    const table = new Table({
      head: [
        chalk.bold('Name'),
        chalk.bold('Status'),
        chalk.bold('Forks'),
        chalk.bold('Created'),
        chalk.bold('ID'),
      ],
      colWidths: [25, 12, 20, 20, 40],
    })

    for (const session of sessions) {
      const statusColor = session.status === 'active' ? chalk.green : chalk.yellow
      const activeForks = session.forks.filter((f) => f.status === 'active').length
      const savedForks = session.forks.filter((f) => f.status === 'saved').length
      const mergedForks = session.forks.filter((f) => f.status === 'merged').length

      table.push([
        session.name,
        statusColor(session.status),
        `${chalk.green(activeForks)}/${chalk.yellow(savedForks)}/${chalk.blue(mergedForks)}`,
        new Date(session.createdAt).toLocaleDateString(),
        chalk.gray(session.id.substring(0, 8) + '...'),
      ])
    }

    console.log(table.toString())
  }

  /**
   * Display forks table
   */
  static forksTable(forks: Fork[]) {
    if (forks.length === 0) {
      this.warn('No forks found')
      return
    }

    const table = new Table({
      head: [
        chalk.bold('Name'),
        chalk.bold('Status'),
        chalk.bold('Export'),
        chalk.bold('Created'),
        chalk.bold('ID'),
      ],
      colWidths: [25, 12, 15, 20, 40],
    })

    for (const fork of forks) {
      const statusColor =
        fork.status === 'active'
          ? chalk.green
          : fork.status === 'merged'
            ? chalk.blue
            : chalk.yellow

      const hasExport = fork.contextPath ? chalk.green('✓') : chalk.gray('✗')

      table.push([
        fork.name,
        statusColor(fork.status),
        hasExport,
        new Date(fork.createdAt).toLocaleDateString(),
        chalk.gray(fork.id.substring(0, 8) + '...'),
      ])
    }

    console.log(table.toString())
  }

  /**
   * Display project summary
   */
  static projectSummary(summary: ProjectSummary) {
    this.header('📊 Project Summary')

    console.log(`\n${chalk.gray('Project Path:')} ${summary.projectPath}`)
    console.log(`${chalk.gray('Total Sessions:')} ${summary.totalSessions}`)
    console.log(`  ${chalk.green('Active:')} ${summary.activeSessions}`)
    console.log(`  ${chalk.yellow('Saved:')} ${summary.savedSessions}`)
    console.log(
      `${chalk.gray('Last Updated:')} ${new Date(summary.lastUpdated).toLocaleString()}`
    )

    if (summary.sessions.length === 0) {
      console.log('\n' + chalk.gray('No sessions available'))
      return
    }

    this.section('\n📝 Sessions:')

    for (const session of summary.sessions) {
      const statusEmoji = session.status === 'active' ? '✓' : '💾'
      const statusColor = session.status === 'active' ? chalk.green : chalk.yellow

      console.log(`\n${statusEmoji} ${chalk.bold(session.name)}`)
      console.log(`  ${chalk.gray('ID:')} ${session.id}`)
      console.log(`  ${chalk.gray('Claude Session:')} ${session.claudeSessionId}`)
      console.log(`  ${chalk.gray('Status:')} ${statusColor(session.status)}`)
      console.log(
        `  ${chalk.gray('Created:')} ${new Date(session.createdAt).toLocaleString()}`
      )
      console.log(
        `  ${chalk.gray('Last Activity:')} ${new Date(session.lastActivity).toLocaleString()}`
      )
      console.log(`  ${chalk.gray('Total Forks:')} ${session.totalForks}`)
      console.log(
        `    ${chalk.green('Active:')} ${session.activeForks} | ${chalk.yellow('Saved:')} ${session.savedForks} | ${chalk.blue('Merged:')} ${session.mergedForks}`
      )

      if (session.forks.length > 0) {
        console.log(`\n  ${chalk.bold('Forks:')}`)
        for (const fork of session.forks) {
          const forkEmoji =
            fork.status === 'active' ? '✓' : fork.status === 'merged' ? '🔀' : '💾'
          const forkColor =
            fork.status === 'active'
              ? chalk.green
              : fork.status === 'merged'
                ? chalk.blue
                : chalk.yellow

          console.log(`\n    ${forkEmoji} ${chalk.bold(fork.name)}`)
          console.log(`      ${chalk.gray('ID:')} ${fork.id}`)
          console.log(`      ${chalk.gray('Claude Session:')} ${fork.claudeSessionId}`)
          console.log(`      ${chalk.gray('Status:')} ${forkColor(fork.status)}`)
          console.log(
            `      ${chalk.gray('Created:')} ${new Date(fork.createdAt).toLocaleString()}`
          )

          if (fork.hasContext) {
            console.log(`      ${chalk.gray('Export:')} ${chalk.green('✓')} ${fork.contextPath}`)
          }

          if (fork.mergedToMain && fork.mergedAt) {
            console.log(
              `      ${chalk.gray('Merged:')} ${new Date(fork.mergedAt).toLocaleString()}`
            )
          }
        }
      }
    }
  }

  /**
   * Display JSON output
   */
  static json(data: any) {
    console.log(JSON.stringify(data, null, 2))
  }

  /**
   * Display empty line
   */
  static newline() {
    console.log()
  }
}
