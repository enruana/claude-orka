import { Command } from 'commander'
import execa from 'execa'
import fs from 'fs-extra'
import path from 'path'
import chalk from 'chalk'
import { Output } from '../utils/output'
import { handleError } from '../utils/errors'

interface CheckResult {
  name: string
  status: 'pass' | 'warn' | 'fail'
  message: string
  details?: string
  fix?: string
}

export function doctorCommand(program: Command) {
  program
    .command('doctor')
    .description('Check system dependencies and configuration')
    .action(async () => {
      try {
        console.log(chalk.bold.cyan('\n🔍 Claude-Orka Doctor\n'))
        console.log('Checking system dependencies and configuration...\n')

        const results: CheckResult[] = []

        // Check Node.js version
        results.push(await checkNodeVersion())

        // Check tmux
        results.push(await checkTmux())

        // Check Claude CLI
        results.push(await checkClaude())

        // Check ttyd
        results.push(await checkTtyd())

        // Check project initialization
        results.push(await checkProjectInit())

        // Check write permissions
        results.push(await checkWritePermissions())

        // Check .claude directory
        results.push(await checkClaudeDir())

        // Check Whisper dependencies (for speech-to-text)
        results.push(await checkFfmpeg())
        results.push(await checkMake())
        results.push(await checkCmake())
        results.push(await checkWhisperBinary())
        results.push(await checkWhisperModel())

        // Check Puppeteer (for terminal screenshots)
        results.push(await checkPuppeteer())

        // Display results
        displayResults(results)

        // Exit with error if any critical checks failed
        const criticalFailures = results.filter((r) => r.status === 'fail')
        if (criticalFailures.length > 0) {
          process.exit(1)
        }
      } catch (error) {
        handleError(error)
      }
    })
}

async function checkNodeVersion(): Promise<CheckResult> {
  try {
    const version = process.version
    const major = parseInt(version.slice(1).split('.')[0])

    if (major >= 18) {
      return {
        name: 'Node.js',
        status: 'pass',
        message: `${version} (>= 18.0.0)`,
      }
    } else {
      return {
        name: 'Node.js',
        status: 'fail',
        message: `${version} (requires >= 18.0.0)`,
        fix: 'Install Node.js 18 or higher from https://nodejs.org',
      }
    }
  } catch (error) {
    return {
      name: 'Node.js',
      status: 'fail',
      message: 'Not found',
      fix: 'Install Node.js from https://nodejs.org',
    }
  }
}

async function checkTmux(): Promise<CheckResult> {
  try {
    const { stdout } = await execa('tmux', ['-V'])
    const version = stdout.trim()

    return {
      name: 'tmux',
      status: 'pass',
      message: version,
    }
  } catch (error) {
    return {
      name: 'tmux',
      status: 'fail',
      message: 'Not found',
      details: 'tmux is required for session management',
      fix: 'Install tmux:\n  macOS: brew install tmux\n  Ubuntu: sudo apt-get install tmux',
    }
  }
}

async function checkClaude(): Promise<CheckResult> {
  try {
    const { stdout } = await execa('claude', ['--version'])
    const version = stdout.trim()

    return {
      name: 'Claude CLI',
      status: 'pass',
      message: version,
    }
  } catch (error) {
    return {
      name: 'Claude CLI',
      status: 'fail',
      message: 'Not found',
      details: 'Claude CLI is required for AI sessions',
      fix: 'Install Claude CLI from https://claude.ai/download',
    }
  }
}

async function checkTtyd(): Promise<CheckResult> {
  try {
    const { stdout } = await execa('ttyd', ['--version'])
    const version = stdout.trim()

    return {
      name: 'ttyd',
      status: 'pass',
      message: version,
      details: 'Web terminal for remote session access',
    }
  } catch (error) {
    return {
      name: 'ttyd',
      status: 'warn',
      message: 'Not found',
      details: 'ttyd enables web-based terminal access (optional)',
      fix: 'Install ttyd:\n  macOS: brew install ttyd\n  Ubuntu: sudo apt-get install ttyd',
    }
  }
}

async function checkProjectInit(): Promise<CheckResult> {
  const projectPath = process.cwd()
  const orkaDir = path.join(projectPath, '.claude-orka')
  const stateFile = path.join(orkaDir, 'state.json')

  try {
    const dirExists = await fs.pathExists(orkaDir)
    const stateExists = await fs.pathExists(stateFile)

    if (dirExists && stateExists) {
      return {
        name: 'Project initialization',
        status: 'pass',
        message: 'Initialized',
        details: '.claude-orka/ directory and state.json found',
      }
    } else if (dirExists) {
      return {
        name: 'Project initialization',
        status: 'warn',
        message: 'Partially initialized',
        details: '.claude-orka/ exists but state.json is missing',
        fix: 'Run: orka init',
      }
    } else {
      return {
        name: 'Project initialization',
        status: 'warn',
        message: 'Not initialized',
        details: 'Project is not initialized',
        fix: 'Run: orka init',
      }
    }
  } catch (error) {
    return {
      name: 'Project initialization',
      status: 'fail',
      message: 'Error checking',
      details: (error as Error).message,
    }
  }
}

async function checkWritePermissions(): Promise<CheckResult> {
  const projectPath = process.cwd()

  try {
    const testFile = path.join(projectPath, '.claude-orka-write-test')
    await fs.writeFile(testFile, 'test')
    await fs.remove(testFile)

    return {
      name: 'Write permissions',
      status: 'pass',
      message: 'OK',
      details: 'Can write to project directory',
    }
  } catch (error) {
    return {
      name: 'Write permissions',
      status: 'fail',
      message: 'Cannot write',
      details: `No write permission in ${projectPath}`,
      fix: 'Check directory permissions',
    }
  }
}

async function checkClaudeDir(): Promise<CheckResult> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || ''
  const claudeDir = path.join(homeDir, '.claude')
  const historyFile = path.join(claudeDir, 'history.jsonl')

  try {
    const dirExists = await fs.pathExists(claudeDir)
    const historyExists = await fs.pathExists(historyFile)

    if (dirExists && historyExists) {
      return {
        name: 'Claude directory',
        status: 'pass',
        message: 'Found',
        details: `~/.claude/history.jsonl exists`,
      }
    } else if (dirExists) {
      return {
        name: 'Claude directory',
        status: 'warn',
        message: 'History file missing',
        details: '~/.claude/ exists but history.jsonl not found',
        fix: 'Run Claude CLI at least once to create history',
      }
    } else {
      return {
        name: 'Claude directory',
        status: 'warn',
        message: 'Not found',
        details: '~/.claude/ directory not found',
        fix: 'Run Claude CLI at least once to create the directory',
      }
    }
  } catch (error) {
    return {
      name: 'Claude directory',
      status: 'fail',
      message: 'Error checking',
      details: (error as Error).message,
    }
  }
}

async function checkFfmpeg(): Promise<CheckResult> {
  try {
    const { stdout } = await execa('ffmpeg', ['-version'])
    const version = stdout.split('\n')[0]

    return {
      name: 'ffmpeg (Voice)',
      status: 'pass',
      message: version.replace('ffmpeg version ', '').split(' ')[0],
      details: 'Required for audio processing in voice input',
    }
  } catch (error) {
    return {
      name: 'ffmpeg (Voice)',
      status: 'warn',
      message: 'Not found',
      details: 'ffmpeg is required for voice input feature',
      fix: 'Run: orka prepare\n  Or manually: brew install ffmpeg (macOS)',
    }
  }
}

async function checkMake(): Promise<CheckResult> {
  try {
    const { stdout } = await execa('make', ['--version'])
    const version = stdout.split('\n')[0]

    return {
      name: 'make (Whisper)',
      status: 'pass',
      message: version,
      details: 'Required for building Whisper speech-to-text',
    }
  } catch (error) {
    return {
      name: 'make (Whisper)',
      status: 'warn',
      message: 'Not found',
      details: 'make is required for speech-to-text feature',
      fix: 'Run: orka prepare\n  Or manually: xcode-select --install (macOS)',
    }
  }
}

async function checkCmake(): Promise<CheckResult> {
  try {
    const { stdout } = await execa('cmake', ['--version'])
    const version = stdout.split('\n')[0]

    return {
      name: 'cmake (Whisper)',
      status: 'pass',
      message: version,
      details: 'Required for compiling Whisper',
    }
  } catch (error) {
    return {
      name: 'cmake (Whisper)',
      status: 'warn',
      message: 'Not found',
      details: 'cmake is required for speech-to-text feature',
      fix: 'Run: orka prepare\n  Or manually: brew install cmake (macOS)',
    }
  }
}

async function checkWhisperBinary(): Promise<CheckResult> {
  const whisperCppPath = path.join(
    process.cwd(),
    'node_modules',
    'nodejs-whisper',
    'cpp',
    'whisper.cpp'
  )
  const whisperBin = path.join(whisperCppPath, 'build', 'bin', 'whisper-cli')

  try {
    const binExists = await fs.pathExists(whisperBin)

    if (binExists) {
      return {
        name: 'Whisper binary',
        status: 'pass',
        message: 'Built',
        details: 'whisper-cli is ready',
      }
    } else {
      // Check if whisper.cpp directory exists at all
      const dirExists = await fs.pathExists(whisperCppPath)
      if (!dirExists) {
        return {
          name: 'Whisper binary',
          status: 'warn',
          message: 'Not installed',
          details: 'nodejs-whisper not found in node_modules',
          fix: 'Run: npm install (to install dependencies)',
        }
      }
      return {
        name: 'Whisper binary',
        status: 'warn',
        message: 'Not built',
        details: 'Whisper needs to be compiled',
        fix: 'Run: orka prepare',
      }
    }
  } catch (error) {
    return {
      name: 'Whisper binary',
      status: 'warn',
      message: 'Unknown',
      details: (error as Error).message,
    }
  }
}

async function checkWhisperModel(): Promise<CheckResult> {
  // Check for model in nodejs-whisper location (used by our server)
  const whisperCppPath = path.join(
    process.cwd(),
    'node_modules',
    'nodejs-whisper',
    'cpp',
    'whisper.cpp',
    'models'
  )
  // Check for base model (better quality) or tiny as fallback
  const baseModel = path.join(whisperCppPath, 'ggml-base.bin')
  const tinyModel = path.join(whisperCppPath, 'ggml-tiny.bin')

  try {
    const baseExists = await fs.pathExists(baseModel)
    const tinyExists = await fs.pathExists(tinyModel)

    if (baseExists) {
      const stats = await fs.stat(baseModel)
      const sizeMB = Math.round(stats.size / 1024 / 1024)
      return {
        name: 'Whisper model',
        status: 'pass',
        message: `base multilingual (${sizeMB}MB)`,
        details: 'Speech-to-text ready (good quality, ES/EN)',
      }
    } else if (tinyExists) {
      const stats = await fs.stat(tinyModel)
      const sizeMB = Math.round(stats.size / 1024 / 1024)
      return {
        name: 'Whisper model',
        status: 'warn',
        message: `tiny multilingual (${sizeMB}MB)`,
        details: 'Consider upgrading to base model for better accuracy',
        fix: 'Run: orka prepare',
      }
    } else {
      return {
        name: 'Whisper model',
        status: 'warn',
        message: 'Not downloaded',
        details: 'Whisper model required for voice input (~142MB)',
        fix: 'Run: orka prepare',
      }
    }
  } catch (error) {
    return {
      name: 'Whisper model',
      status: 'warn',
      message: 'Unknown',
      details: (error as Error).message,
    }
  }
}

async function checkPuppeteer(): Promise<CheckResult> {
  try {
    // Check if puppeteer module is resolvable
    const puppeteerPkg = path.join(
      process.cwd(),
      'node_modules',
      'puppeteer',
      'package.json'
    )
    if (!await fs.pathExists(puppeteerPkg)) {
      return {
        name: 'Puppeteer (Screenshots)',
        status: 'warn',
        message: 'Not installed',
        details: 'Puppeteer enables terminal screenshots in Telegram /log',
        fix: 'Run: orka prepare\n  Or manually: npm install puppeteer',
      }
    }

    // Check if Chromium is downloaded
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    const chromiumCache = path.join(homeDir, '.cache', 'puppeteer')
    const chromiumExists = await fs.pathExists(chromiumCache)

    if (chromiumExists) {
      const pkg = await fs.readJson(puppeteerPkg)
      return {
        name: 'Puppeteer (Screenshots)',
        status: 'pass',
        message: `v${pkg.version} + Chromium`,
        details: 'Terminal screenshots enabled for Telegram /log',
      }
    } else {
      return {
        name: 'Puppeteer (Screenshots)',
        status: 'warn',
        message: 'Chromium not downloaded',
        details: 'Puppeteer is installed but Chromium browser is missing',
        fix: 'Run: orka prepare\n  Or manually: npx puppeteer browsers install chrome',
      }
    }
  } catch (error) {
    return {
      name: 'Puppeteer (Screenshots)',
      status: 'warn',
      message: 'Unknown',
      details: (error as Error).message,
    }
  }
}

function displayResults(results: CheckResult[]) {
  console.log(chalk.bold('Results:\n'))

  for (const result of results) {
    let icon: string
    let color: (text: string) => string

    switch (result.status) {
      case 'pass':
        icon = '✓'
        color = chalk.green
        break
      case 'warn':
        icon = '⚠'
        color = chalk.yellow
        break
      case 'fail':
        icon = '✗'
        color = chalk.red
        break
    }

    console.log(
      `${color(icon)} ${chalk.bold(result.name)}: ${color(result.message)}`
    )

    if (result.details) {
      console.log(`  ${chalk.gray(result.details)}`)
    }

    if (result.fix) {
      console.log(`  ${chalk.cyan('Fix:')} ${result.fix}`)
    }

    console.log()
  }

  // Summary
  const passed = results.filter((r) => r.status === 'pass').length
  const warned = results.filter((r) => r.status === 'warn').length
  const failed = results.filter((r) => r.status === 'fail').length

  console.log(chalk.bold('Summary:'))
  console.log(`  ${chalk.green('✓')} Passed: ${passed}`)
  console.log(`  ${chalk.yellow('⚠')} Warnings: ${warned}`)
  console.log(`  ${chalk.red('✗')} Failed: ${failed}`)
  console.log()

  if (failed === 0 && warned === 0) {
    Output.success('All checks passed! Claude-Orka is ready to use.')
  } else if (failed === 0) {
    Output.warn('Some warnings found. Claude-Orka should work but check the warnings above.')
  } else {
    Output.error('Some critical checks failed. Fix the errors above before using Claude-Orka.')
  }
}
