import { Command } from 'commander'
import execa from 'execa'
import chalk from 'chalk'
import ora from 'ora'
import readline from 'readline'
import path from 'path'
import fs from 'fs-extra'
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
        console.log('  • ttyd (web terminal for remote access)')
        console.log('  • Claude CLI (if needed)')
        console.log('  • ffmpeg (audio processing for voice input)')
        console.log('  • cmake (build tool for Whisper)')
        console.log('  • Whisper model (speech-to-text)')
        console.log('  • Puppeteer + Chromium (terminal screenshots)\n')

        if (!options.yes) {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          })

          const answer = await new Promise<string>((resolve) => {
            rl.question('Continue? (y/n): ', resolve)
          })
          rl.close()

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

        // Install ttyd
        await installTtyd(system)

        // Check Claude CLI
        await checkClaudeCLI()

        // Install ffmpeg (for voice input)
        await installFfmpeg(system)

        // Install cmake (for building Whisper)
        await installCmake(system)

        // Build Whisper and download model
        await setupWhisper()

        // Setup Puppeteer + Chromium (for terminal screenshots)
        await setupPuppeteer()

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

async function installTtyd(system: SystemInfo) {
  console.log(chalk.bold('\n🌐 Installing ttyd...\n'))

  // Check if already installed
  try {
    await execa('which', ['ttyd'])
    const { stdout } = await execa('ttyd', ['--version'])
    Output.success(`ttyd is already installed: ${stdout}`)
    return
  } catch {
    // Not installed, continue
  }

  const spinner = ora('Installing ttyd...').start()

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
        console.log('\nThen run: ' + chalk.cyan('brew install ttyd'))
        return
      }

      await execa('brew', ['install', 'ttyd'])
      spinner.succeed('ttyd installed via Homebrew')
    } else if (system.platform === 'linux') {
      if (system.hasApt) {
        // Debian/Ubuntu
        await execa('sudo', ['apt-get', 'update'])
        await execa('sudo', ['apt-get', 'install', '-y', 'ttyd'])
        spinner.succeed('ttyd installed via apt')
      } else if (system.hasYum) {
        // RedHat/CentOS - ttyd may need to be built from source
        spinner.fail('ttyd not available in yum')
        console.log(chalk.yellow('\nPlease install ttyd manually:'))
        console.log(chalk.cyan('  https://github.com/tsl0922/ttyd#installation'))
      } else {
        spinner.fail('Unknown package manager')
        console.log(chalk.yellow('\nPlease install ttyd manually:'))
        console.log(chalk.cyan('  https://github.com/tsl0922/ttyd#installation'))
      }
    } else {
      spinner.fail(`Unsupported platform: ${system.platform}`)
      console.log(chalk.yellow('\nPlease install ttyd manually:'))
      console.log(chalk.cyan('  https://github.com/tsl0922/ttyd#installation'))
    }
  } catch (error: any) {
    spinner.fail('Failed to install ttyd')
    console.log(chalk.red(`\nError: ${error.message}`))
    console.log(chalk.yellow('\nPlease install ttyd manually:'))
    console.log(chalk.cyan('  macOS: brew install ttyd'))
    console.log(chalk.cyan('  Ubuntu: sudo apt-get install ttyd'))
    console.log(chalk.cyan('  Other: https://github.com/tsl0922/ttyd#installation'))
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

async function installFfmpeg(system: SystemInfo) {
  console.log(chalk.bold('\n🎵 Checking ffmpeg (for voice input)...\n'))

  // Check if already installed
  try {
    await execa('which', ['ffmpeg'])
    const { stdout } = await execa('ffmpeg', ['-version'])
    const version = stdout.split('\n')[0]
    Output.success(`ffmpeg is already installed: ${version}`)
    return
  } catch {
    // Not installed, continue
  }

  const spinner = ora('Installing ffmpeg...').start()

  try {
    if (system.platform === 'darwin') {
      if (!system.hasHomebrew) {
        spinner.fail('Homebrew is not installed')
        console.log(chalk.yellow('\nPlease install ffmpeg manually: brew install ffmpeg'))
        return
      }
      await execa('brew', ['install', 'ffmpeg'])
      spinner.succeed('ffmpeg installed via Homebrew')
    } else if (system.platform === 'linux') {
      if (system.hasApt) {
        await execa('sudo', ['apt-get', 'update'])
        await execa('sudo', ['apt-get', 'install', '-y', 'ffmpeg'])
        spinner.succeed('ffmpeg installed via apt')
      } else if (system.hasYum) {
        await execa('sudo', ['yum', 'install', '-y', 'ffmpeg'])
        spinner.succeed('ffmpeg installed via yum')
      } else {
        spinner.fail('Unknown package manager')
        console.log(chalk.yellow('\nPlease install ffmpeg manually'))
      }
    } else {
      spinner.fail(`Unsupported platform: ${system.platform}`)
    }
  } catch (error: any) {
    spinner.fail('Failed to install ffmpeg')
    console.log(chalk.red(`\nError: ${error.message}`))
    console.log(chalk.yellow('\nPlease install ffmpeg manually:'))
    console.log(chalk.cyan('  macOS: brew install ffmpeg'))
    console.log(chalk.cyan('  Ubuntu: sudo apt-get install ffmpeg'))
  }
}

async function installCmake(system: SystemInfo) {
  console.log(chalk.bold('\n🔨 Checking cmake (for building Whisper)...\n'))

  // Check if already installed
  try {
    await execa('which', ['cmake'])
    const { stdout } = await execa('cmake', ['--version'])
    const version = stdout.split('\n')[0]
    Output.success(`cmake is already installed: ${version}`)
    return
  } catch {
    // Not installed, continue
  }

  const spinner = ora('Installing cmake...').start()

  try {
    if (system.platform === 'darwin') {
      if (!system.hasHomebrew) {
        spinner.fail('Homebrew is not installed')
        console.log(chalk.yellow('\nPlease install cmake manually: brew install cmake'))
        return
      }
      await execa('brew', ['install', 'cmake'])
      spinner.succeed('cmake installed via Homebrew')
    } else if (system.platform === 'linux') {
      if (system.hasApt) {
        await execa('sudo', ['apt-get', 'update'])
        await execa('sudo', ['apt-get', 'install', '-y', 'cmake'])
        spinner.succeed('cmake installed via apt')
      } else if (system.hasYum) {
        await execa('sudo', ['yum', 'install', '-y', 'cmake'])
        spinner.succeed('cmake installed via yum')
      } else {
        spinner.fail('Unknown package manager')
        console.log(chalk.yellow('\nPlease install cmake manually'))
      }
    } else {
      spinner.fail(`Unsupported platform: ${system.platform}`)
    }
  } catch (error: any) {
    spinner.fail('Failed to install cmake')
    console.log(chalk.red(`\nError: ${error.message}`))
    console.log(chalk.yellow('\nPlease install cmake manually:'))
    console.log(chalk.cyan('  macOS: brew install cmake'))
    console.log(chalk.cyan('  Ubuntu: sudo apt-get install cmake'))
  }
}

async function setupWhisper() {
  console.log(chalk.bold('\n🎤 Setting up Whisper (speech-to-text)...\n'))

  const whisperCppPath = path.join(
    process.cwd(),
    'node_modules',
    'nodejs-whisper',
    'cpp',
    'whisper.cpp'
  )

  // Check if whisper.cpp directory exists
  if (!await fs.pathExists(whisperCppPath)) {
    Output.warn('nodejs-whisper not found in node_modules')
    console.log(chalk.yellow('Voice input will not be available.'))
    console.log(chalk.gray('This is optional - Claude-Orka will work without voice input.'))
    return
  }

  // Check if whisper-cli is already built
  const whisperBin = path.join(whisperCppPath, 'build', 'bin', 'whisper-cli')
  if (!await fs.pathExists(whisperBin)) {
    const spinner = ora('Building Whisper...').start()
    try {
      // Check for cmake
      try {
        await execa('which', ['cmake'])
      } catch {
        spinner.fail('cmake is required to build Whisper')
        console.log(chalk.yellow('\nPlease install cmake first and run orka prepare again'))
        return
      }

      // Build whisper.cpp using cmake
      await execa('cmake', ['-B', 'build'], { cwd: whisperCppPath })
      await execa('cmake', ['--build', 'build', '--config', 'Release'], { cwd: whisperCppPath })
      spinner.succeed('Whisper built successfully')
    } catch (error: any) {
      spinner.fail('Failed to build Whisper')
      console.log(chalk.red(`\nError: ${error.message}`))
      console.log(chalk.yellow('\nTry building manually:'))
      console.log(chalk.cyan(`  cd ${whisperCppPath}`))
      console.log(chalk.cyan('  cmake -B build'))
      console.log(chalk.cyan('  cmake --build build --config Release'))
      return
    }
  } else {
    Output.success('Whisper is already built')
  }

  // Check for base model
  const modelPath = path.join(whisperCppPath, 'models', 'ggml-base.bin')
  if (!await fs.pathExists(modelPath)) {
    const spinner = ora('Downloading Whisper base model (~142MB)...').start()
    try {
      await execa('bash', ['./models/download-ggml-model.sh', 'base'], {
        cwd: whisperCppPath,
        timeout: 300000, // 5 minute timeout for download
      })
      spinner.succeed('Whisper base model downloaded')
    } catch (error: any) {
      spinner.fail('Failed to download Whisper model')
      console.log(chalk.red(`\nError: ${error.message}`))
      console.log(chalk.yellow('\nTry downloading manually:'))
      console.log(chalk.cyan(`  cd ${whisperCppPath}`))
      console.log(chalk.cyan('  bash ./models/download-ggml-model.sh base'))
    }
  } else {
    Output.success('Whisper base model is already downloaded')
  }
}

async function setupPuppeteer() {
  console.log(chalk.bold('\n📸 Setting up Puppeteer (terminal screenshots)...\n'))

  // Check if puppeteer is installed as a dependency
  const puppeteerPkg = path.join(
    process.cwd(),
    'node_modules',
    'puppeteer',
    'package.json'
  )

  if (!await fs.pathExists(puppeteerPkg)) {
    Output.warn('puppeteer not found in node_modules')
    console.log(chalk.yellow('Terminal screenshots will not be available.'))
    console.log(chalk.gray('This is optional - /log will fall back to text output.'))
    console.log(chalk.cyan('  To install: npm install puppeteer'))
    return
  }

  // Check if Chromium is already downloaded
  const homeDir = process.env.HOME || process.env.USERPROFILE || ''
  const chromiumCache = path.join(homeDir, '.cache', 'puppeteer')

  if (await fs.pathExists(chromiumCache)) {
    Output.success('Puppeteer + Chromium is already set up')
    return
  }

  const spinner = ora('Downloading Chromium for Puppeteer...').start()
  try {
    await execa('npx', ['puppeteer', 'browsers', 'install', 'chrome'], {
      timeout: 300000,
    })
    spinner.succeed('Chromium downloaded for Puppeteer')
  } catch {
    // Pinned version may fail — try stable as fallback
    try {
      spinner.text = 'Retrying with chrome@stable...'
      await execa('npx', ['puppeteer', 'browsers', 'install', 'chrome@stable'], {
        timeout: 300000,
      })
      spinner.succeed('Chromium (stable) downloaded for Puppeteer')
    } catch (error: any) {
      spinner.fail('Failed to download Chromium')
      console.log(chalk.red(`\nError: ${error.message}`))
      console.log(chalk.yellow('\nTry downloading manually:'))
      console.log(chalk.cyan('  npx puppeteer browsers install chrome@stable'))
    }
  }
}
