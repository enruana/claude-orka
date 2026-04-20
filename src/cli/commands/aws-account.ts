import { Command } from 'commander'
import chalk from 'chalk'
import readline from 'readline'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { Output } from '../utils/output'
import { handleError } from '../utils/errors'

interface AwsProfile {
  name: string
  region?: string
  accountId?: string
  source: 'credentials' | 'config'
}

const ACTIVE_PROFILE_FILE = path.join(os.homedir(), '.aws', '.active_profile')

/**
 * Parse AWS credentials file (~/.aws/credentials)
 */
async function parseCredentials(filePath: string): Promise<Map<string, Record<string, string>>> {
  const profiles = new Map<string, Record<string, string>>()

  if (!await fs.pathExists(filePath)) return profiles

  const content = await fs.readFile(filePath, 'utf-8')
  let currentProfile: string | null = null

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const profileMatch = trimmed.match(/^\[(.+)\]$/)
    if (profileMatch) {
      currentProfile = profileMatch[1]
      profiles.set(currentProfile, {})
      continue
    }

    if (currentProfile) {
      const kvMatch = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/)
      if (kvMatch) {
        profiles.get(currentProfile)![kvMatch[1].trim()] = kvMatch[2].trim()
      }
    }
  }

  return profiles
}

/**
 * Parse AWS config file (~/.aws/config)
 */
async function parseConfig(filePath: string): Promise<Map<string, Record<string, string>>> {
  const profiles = new Map<string, Record<string, string>>()

  if (!await fs.pathExists(filePath)) return profiles

  const content = await fs.readFile(filePath, 'utf-8')
  let currentProfile: string | null = null

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const profileMatch = trimmed.match(/^\[(?:profile\s+)?(.+)\]$/)
    if (profileMatch) {
      currentProfile = profileMatch[1]
      profiles.set(currentProfile, {})
      continue
    }

    if (currentProfile) {
      const kvMatch = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/)
      if (kvMatch) {
        profiles.get(currentProfile)![kvMatch[1].trim()] = kvMatch[2].trim()
      }
    }
  }

  return profiles
}

async function discoverAwsProfiles(): Promise<AwsProfile[]> {
  const awsDir = path.join(os.homedir(), '.aws')

  if (!await fs.pathExists(awsDir)) {
    return []
  }

  const credentialsPath = path.join(awsDir, 'credentials')
  const configPath = path.join(awsDir, 'config')

  const credentials = await parseCredentials(credentialsPath)
  const config = await parseConfig(configPath)

  const profileMap = new Map<string, AwsProfile>()

  // Add profiles from credentials file
  for (const [name] of credentials) {
    profileMap.set(name, { name, source: 'credentials' })
  }

  // Merge/add profiles from config file
  for (const [name, settings] of config) {
    const existing = profileMap.get(name)
    if (existing) {
      existing.region = settings['region']
      existing.accountId = settings['sso_account_id'] || settings['role_arn']?.match(/:(\d{12}):/)?.[1]
    } else {
      profileMap.set(name, {
        name,
        region: settings['region'],
        accountId: settings['sso_account_id'] || settings['role_arn']?.match(/:(\d{12}):/)?.[1],
        source: 'config',
      })
    }
  }

  return Array.from(profileMap.values()).sort((a, b) => {
    if (a.name === 'default') return -1
    if (b.name === 'default') return 1
    return a.name.localeCompare(b.name)
  })
}

async function getCurrentProfile(): Promise<string> {
  // Check env var first, then file
  if (process.env.AWS_PROFILE) return process.env.AWS_PROFILE
  if (process.env.AWS_DEFAULT_PROFILE) return process.env.AWS_DEFAULT_PROFILE

  try {
    if (await fs.pathExists(ACTIVE_PROFILE_FILE)) {
      return (await fs.readFile(ACTIVE_PROFILE_FILE, 'utf-8')).trim()
    }
  } catch {
    // ignore read errors
  }

  return 'default'
}

async function ensureShellIntegration(): Promise<boolean> {
  const shell = process.env.SHELL || '/bin/bash'
  const rcFile = shell.includes('zsh')
    ? path.join(os.homedir(), '.zshrc')
    : path.join(os.homedir(), '.bashrc')

  if (!await fs.pathExists(rcFile)) return false

  const content = await fs.readFile(rcFile, 'utf-8')
  const hookLine = '# orka aws-account integration'

  if (content.includes(hookLine)) return true

  // Install shell function that wraps orka and re-exports AWS_PROFILE after aws-account
  const integration = `
${hookLine}
export AWS_PROFILE=\$(cat ~/.aws/.active_profile 2>/dev/null || echo "default")
orka() {
  command orka "\$@"
  if [[ "\$1" == "aws-account" && \$? -eq 0 ]]; then
    export AWS_PROFILE=\$(cat ~/.aws/.active_profile 2>/dev/null || echo "default")
  fi
}
`

  await fs.appendFile(rcFile, integration)
  return false // was not installed before
}

export function awsAccountCommand(program: Command) {
  program
    .command('aws-account')
    .description('Switch active AWS profile')
    .option('--setup', 'Install shell integration for automatic profile switching')
    .action(async (opts) => {
      try {
        if (opts.setup) {
          const wasInstalled = await ensureShellIntegration()
          if (wasInstalled) {
            Output.success('Shell integration already installed')
          } else {
            Output.success('Shell integration installed')
            console.log(chalk.yellow('  Restart your shell or run: source ~/.bashrc (or ~/.zshrc)'))
          }
          return
        }

        const profiles = await discoverAwsProfiles()

        if (profiles.length === 0) {
          Output.error('No AWS profiles found in ~/.aws/')
          console.log(chalk.gray('  Configure profiles with: aws configure --profile <name>'))
          return
        }

        const current = await getCurrentProfile()

        console.log(chalk.bold.cyan('\nAWS Profiles found:'))
        profiles.forEach((profile, i) => {
          const isCurrent = profile.name === current
          const marker = isCurrent ? chalk.green(' (active)') : ''
          const details = [
            profile.region && `region: ${profile.region}`,
            profile.accountId && `account: ${profile.accountId}`,
            `source: ${profile.source}`,
          ].filter(Boolean).join(', ')

          console.log(`  ${chalk.white(`${i + 1}.`)} ${chalk.bold(profile.name)}${marker} ${chalk.gray(`(${details})`)}`)
        })
        console.log()

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        })

        const answer = await new Promise<string>((resolve) => {
          rl.question(`Select profile [1-${profiles.length}]: `, resolve)
        })
        rl.close()

        const index = parseInt(answer, 10) - 1
        if (isNaN(index) || index < 0 || index >= profiles.length) {
          Output.error('Invalid selection')
          return
        }

        const selected = profiles[index]

        // Write active profile to file (persists globally, like ssh-add)
        await fs.ensureDir(path.dirname(ACTIVE_PROFILE_FILE))
        await fs.writeFile(ACTIVE_PROFILE_FILE, selected.name, 'utf-8')

        // Also set for current process children
        process.env.AWS_PROFILE = selected.name
        delete process.env.AWS_DEFAULT_PROFILE

        Output.success(`Switched to ${chalk.bold(selected.name)}`)
        console.log()

        // Check if shell integration is installed
        const shell = process.env.SHELL || '/bin/bash'
        const rcFile = shell.includes('zsh')
          ? path.join(os.homedir(), '.zshrc')
          : path.join(os.homedir(), '.bashrc')

        let hasIntegration = false
        if (await fs.pathExists(rcFile)) {
          const rcContent = await fs.readFile(rcFile, 'utf-8')
          hasIntegration = rcContent.includes('# orka aws-account integration')
        }

        if (!hasIntegration) {
          console.log(chalk.yellow('  To apply in this shell, run:'))
          console.log(chalk.white(`    export AWS_PROFILE=${selected.name}`))
          console.log()
          console.log(chalk.gray('  For automatic switching, run once: orka aws-account --setup'))
          console.log()
        } else {
          console.log(chalk.gray('  Profile active in new shells automatically.'))
          console.log(chalk.gray(`  For this shell: export AWS_PROFILE=${selected.name}`))
          console.log()
        }

        if (selected.region) {
          console.log(chalk.gray(`  Region: ${selected.region}`))
        }
        if (selected.accountId) {
          console.log(chalk.gray(`  Account: ${selected.accountId}`))
        }
      } catch (error) {
        handleError(error as Error)
      }
    })
}
