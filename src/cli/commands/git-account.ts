import { Command } from 'commander'
import execa from 'execa'
import chalk from 'chalk'
import readline from 'readline'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { Output } from '../utils/output'
import { handleError } from '../utils/errors'

interface SshKey {
  name: string
  path: string
  email: string
}

const EXCLUDED_FILES = new Set([
  'known_hosts',
  'known_hosts.old',
  'authorized_keys',
  'config',
  'environment',
])

async function discoverSshKeys(): Promise<SshKey[]> {
  const sshDir = path.join(os.homedir(), '.ssh')

  if (!await fs.pathExists(sshDir)) {
    return []
  }

  const files = await fs.readdir(sshDir)

  // Filter to private keys: exclude .pub, known excluded files, and anything with common non-key extensions
  const privateKeyFiles = files.filter((f) => {
    if (f.startsWith('.')) return false
    if (f.endsWith('.pub')) return false
    if (EXCLUDED_FILES.has(f)) return false
    return true
  })

  const keys: SshKey[] = []

  for (const keyFile of privateKeyFiles) {
    const pubPath = path.join(sshDir, `${keyFile}.pub`)
    if (!await fs.pathExists(pubPath)) continue

    const pubContent = (await fs.readFile(pubPath, 'utf-8')).trim()
    // Public key format: <algo> <base64> <comment/email>
    const parts = pubContent.split(/\s+/)
    const email = parts.length >= 3 ? parts.slice(2).join(' ') : 'no comment'

    keys.push({
      name: keyFile,
      path: path.join(sshDir, keyFile),
      email,
    })
  }

  return keys.sort((a, b) => a.name.localeCompare(b.name))
}

export function gitAccountCommand(program: Command) {
  program
    .command('git-account')
    .description('Switch SSH key in ssh-agent for Git authentication')
    .action(async () => {
      try {
        const keys = await discoverSshKeys()

        if (keys.length === 0) {
          Output.error('No SSH keys found in ~/.ssh/')
          return
        }

        console.log(chalk.bold.cyan('\nSSH Keys found:'))
        keys.forEach((key, i) => {
          console.log(`  ${chalk.white(`${i + 1}.`)} ${chalk.bold(key.name)} ${chalk.gray(`(${key.email})`)}`)
        })
        console.log()

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        })

        const answer = await new Promise<string>((resolve) => {
          rl.question(`Select key [1-${keys.length}]: `, resolve)
        })
        rl.close()

        const index = parseInt(answer, 10) - 1
        if (isNaN(index) || index < 0 || index >= keys.length) {
          Output.error('Invalid selection')
          return
        }

        const selected = keys[index]

        // Remove all keys from agent
        try {
          await execa('ssh-add', ['-D'])
        } catch {
          // ssh-add -D fails if agent has no keys, that's fine
        }

        // Add selected key
        await execa('ssh-add', [selected.path])

        Output.success(`Switched to ${chalk.bold(selected.name)}`)
        console.log()

        // Show current agent keys
        const result = await execa('ssh-add', ['-l'])
        console.log(chalk.gray(result.stdout))
      } catch (error) {
        handleError(error as Error)
      }
    })
}
