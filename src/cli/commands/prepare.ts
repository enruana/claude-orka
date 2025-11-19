import { Command } from 'commander'
import execa from 'execa'
import chalk from 'chalk'
import ora from 'ora'
import { Output } from '../utils/output'
import { handleError } from '../utils/errors'

interface SystemInfo {
  platform: string
  packageManager?: string
  hasHomebrew?: boolean
  hasApt?: boolean
  hasYum?: boolean
}

export function prepareCommand(program: Command) {
  program
    .command('prepare')
    .description('Install and configure system dependencies')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (options) => {
      try {
        console.log(chalk.bold.cyan('\n🔧 Claude-Orka Preparation\n'))
        console.log('This will help you install required dependencies:\n')
        console.log('  • tmux (terminal multiplexer)')
        console.log('  • Claude CLI (if needed)\n')

        if (!options.yes) {
          const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout,
          })

          const answer = await new Promise<string>((resolve) => {
            readline.question('Continue? (y/n): ', resolve)
          })
          readline.close()

          if (answer.toLowerCase() !== 'y') {
            Output.warn('Installation cancelled')
            return
          }
        }

        // Detect system
        const system = await detectSystem()
        console.log(chalk.gray(`\nDetected: ${system.platform}`))

        // Install tmux
        await installTmux(system)

        // Check Claude CLI
        await checkClaudeCLI()

        // Final verification
        console.log(chalk.bold.green('\n✓ Preparation complete!\n'))
        console.log('Run ' + chalk.cyan('orka doctor') + ' to verify everything is working.')
      } catch (error) {
        handleError(error)
      }
    })
}

async function detectSystem(): Promise<SystemInfo> {
  const platform = process.platform
  const info: SystemInfo = { platform }

  if (platform === 'darwin') {
    // macOS - check for Homebrew
    try {
      await execa('which', ['brew'])
      info.hasHomebrew = true
      info.packageManager = 'brew'
    } catch {
      info.hasHomebrew = false
    }
  } else if (platform === 'linux') {
    // Linux - check for apt or yum
    try {
      await execa('which', ['apt-get'])
      info.hasApt = true
      info.packageManager = 'apt'
    } catch {
      try {
        await execa('which', ['yum'])
        info.hasYum = true
        info.packageManager = 'yum'
      } catch {
        // No known package manager
      }
    }
  }

  return info
}

async function installTmux(system: SystemInfo) {
  console.log(chalk.bold('\n📦 Installing tmux...\n'))

  // Check if already installed
  try {
    await execa('which', ['tmux'])
    const { stdout } = await execa('tmux', ['-V'])
    Output.success(`tmux is already installed: ${stdout}`)
    return
  } catch {
    // Not installed, continue
  }

  const spinner = ora('Installing tmux...').start()

  try {
    if (system.platform === 'darwin') {
      if (!system.hasHomebrew) {
        spinner.fail('Homebrew is not installed')
        console.log(chalk.yellow('\nPlease install Homebrew first:'))
        console.log(
          chalk.cyan(
            '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
          )
        )
        console.log('\nThen run: ' + chalk.cyan('brew install tmux'))
        return
      }

      await execa('brew', ['install', 'tmux'])
      spinner.succeed('tmux installed via Homebrew')
    } else if (system.platform === 'linux') {
      if (system.hasApt) {
        // Debian/Ubuntu
        await execa('sudo', ['apt-get', 'update'])
        await execa('sudo', ['apt-get', 'install', '-y', 'tmux'])
        spinner.succeed('tmux installed via apt')
      } else if (system.hasYum) {
        // RedHat/CentOS
        await execa('sudo', ['yum', 'install', '-y', 'tmux'])
        spinner.succeed('tmux installed via yum')
      } else {
        spinner.fail('Unknown package manager')
        console.log(chalk.yellow('\nPlease install tmux manually:'))
        console.log(chalk.cyan('  https://github.com/tmux/tmux/wiki/Installing'))
      }
    } else {
      spinner.fail(`Unsupported platform: ${system.platform}`)
      console.log(chalk.yellow('\nPlease install tmux manually:'))
      console.log(chalk.cyan('  https://github.com/tmux/tmux/wiki/Installing'))
    }
  } catch (error: any) {
    spinner.fail('Failed to install tmux')
    console.log(chalk.red(`\nError: ${error.message}`))
    console.log(chalk.yellow('\nPlease install tmux manually:'))
    console.log(chalk.cyan('  macOS: brew install tmux'))
    console.log(chalk.cyan('  Ubuntu: sudo apt-get install tmux'))
    console.log(chalk.cyan('  CentOS: sudo yum install tmux'))
  }
}

async function checkClaudeCLI() {
  console.log(chalk.bold('\n🤖 Checking Claude CLI...\n'))

  try {
    const { stdout } = await execa('claude', ['--version'])
    Output.success(`Claude CLI is installed: ${stdout}`)
  } catch {
    Output.warn('Claude CLI is not installed')
    console.log(chalk.yellow('\nClaude CLI is required for Claude-Orka to work.'))
    console.log(chalk.cyan('\nInstallation options:'))
    console.log('  1. Visit: https://claude.ai/download')
    console.log('  2. Or use npm: npm install -g @anthropic-ai/claude-cli')
    console.log(
      chalk.gray('\nNote: You may need to restart your terminal after installation.')
    )
  }
}
