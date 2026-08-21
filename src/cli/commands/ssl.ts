import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import execa from 'execa'
import { Command } from 'commander'
import { findCertPair, getTailscaleHostname, CERTS_DIR, ensureCertsDir } from '../../utils/certs'
import { Output } from '../utils/output'

async function getCertInfo(certPath: string): Promise<{ issuer: string; subject: string; validFrom: string; validUntil: string } | null> {
  try {
    const { stdout } = await execa('openssl', ['x509', '-in', certPath, '-text', '-noout'])
    const issuerMatch = stdout.match(/Issuer:.*CN\s*=\s*([^\n,]+)/)
    const subjectMatch = stdout.match(/Subject:.*CN\s*=\s*([^\n,]+)/)
    const validFromMatch = stdout.match(/Not Before:\s*(.+?)$/m)
    const validUntilMatch = stdout.match(/Not After\s*:\s*(.+?)$/m)

    return {
      issuer: issuerMatch?.[1] || 'Unknown',
      subject: subjectMatch?.[1] || 'Unknown',
      validFrom: validFromMatch?.[1] || 'Unknown',
      validUntil: validUntilMatch?.[1] || 'Unknown',
    }
  } catch {
    return null
  }
}

export function sslCommand(program: Command) {
  const ssl = program.command('ssl').description('Manage SSL certificates for HTTPS')

  ssl
    .command('status')
    .description('Show current SSL certificate status')
    .action(async () => {
      try {
        Output.section('SSL Certificate Status')

        const certPair = await findCertPair()
        const tailscaleHostname = await getTailscaleHostname()

        if (!certPair) {
          Output.warn('No SSL certificates found')
          Output.info(`Certificates directory: ${CERTS_DIR}`)
          Output.info('')
          Output.info('To generate certificates:')
          Output.info('  orka ssl renew')
          return
        }

        Output.success(`✓ Certificate pair found`)
        Output.info(`  Hostname: ${certPair.hostname}`)
        Output.info(`  Cert: ${certPair.certPath}`)
        Output.info(`  Key: ${certPair.keyPath}`)
        Output.info('')

        const certInfo = await getCertInfo(certPair.certPath)
        if (certInfo) {
          Output.section('Certificate Details')
          Output.info(`  Issuer: ${certInfo.issuer}`)
          Output.info(`  Subject: ${certInfo.subject}`)
          Output.info(`  Valid From: ${certInfo.validFrom}`)
          Output.info(`  Valid Until: ${certInfo.validUntil}`)
        }

        Output.info('')
        Output.section('Tailscale Status')
        if (tailscaleHostname) {
          Output.success(`✓ Tailscale hostname: ${tailscaleHostname}`)
        } else {
          Output.warn('Tailscale not configured or MagicDNS disabled')
          Output.info('Run: tailscale login')
        }
      } catch (err: any) {
        Output.error(`Failed to check SSL status: ${err.message}`)
        process.exit(1)
      }
    })

  ssl
    .command('renew')
    .description('Generate or renew SSL certificate from Tailscale')
    .option('--force', 'Force regeneration even if certificate exists')
    .action(async (opts) => {
      try {
        Output.section('SSL Certificate Renewal')

        // Check Tailscale
        const tailscaleHostname = await getTailscaleHostname()
        if (!tailscaleHostname) {
          Output.error('Tailscale is not configured or MagicDNS is disabled')
          Output.info('Steps:')
          Output.info('  tailscale login')
          Output.info('  tailscale status')
          process.exit(1)
        }

        Output.success(`✓ Tailscale hostname: ${tailscaleHostname}`)

        // Check if cert exists
        const existing = await findCertPair()
        if (existing && !opts.force) {
          Output.warn('Certificate already exists')
          Output.info(`  Hostname: ${existing.hostname}`)
          Output.info('To force regeneration: orka ssl renew --force')
          return
        }

        if (existing && opts.force) {
          Output.info('Backing up existing certificate...')
          const backupDir = path.join(CERTS_DIR, `backup-${Date.now()}`)
          await fs.ensureDir(backupDir)
          await fs.copy(existing.certPath, path.join(backupDir, path.basename(existing.certPath)))
          await fs.copy(existing.keyPath, path.join(backupDir, path.basename(existing.keyPath)))
          Output.info(`  Backed up to: ${backupDir}`)
        }

        // Generate certificate
        await ensureCertsDir()
        Output.info('Generating new certificate with Tailscale...')
        Output.warn('This will open your browser to complete authentication')
        Output.info('Command: sudo tailscale cert ' + tailscaleHostname)
        Output.info('')

        try {
          // Try to run the command - it may require interactive auth
          await execa('sudo', ['tailscale', 'cert', tailscaleHostname], {
            stdio: 'inherit',
          })

          Output.success('✓ Certificate generated successfully')
          Output.info('Copying certificates to orka...')

          // Find and copy the generated certs
          const tailscaleCertsDir = path.join(os.homedir(), '.tailscale', 'certs')
          if (await fs.pathExists(tailscaleCertsDir)) {
            const files = await fs.readdir(tailscaleCertsDir)
            const crtFile = files.find((f) => f.endsWith('.crt') && f.includes(tailscaleHostname))
            const keyFile = files.find((f) => f.endsWith('.key') && f.includes(tailscaleHostname))

            if (crtFile && keyFile) {
              await fs.copy(path.join(tailscaleCertsDir, crtFile), path.join(CERTS_DIR, crtFile))
              await fs.copy(path.join(tailscaleCertsDir, keyFile), path.join(CERTS_DIR, keyFile))
              Output.success(`✓ Certificates copied to ${CERTS_DIR}`)
            }
          }

          Output.info('')
          Output.section('Next Steps')
          Output.info('1. Restart the server: orka start')
          Output.info('2. Verify: orka ssl status')
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            Output.error('sudo command not found')
            Output.info('Manual steps:')
            Output.info('  sudo tailscale cert ' + tailscaleHostname)
            Output.info(`  cp ~/.tailscale/certs/${tailscaleHostname}.* ~/.orka/certs/`)
          } else {
            throw err
          }
        }
      } catch (err: any) {
        Output.error(`Failed to renew certificate: ${err.message}`)
        process.exit(1)
      }
    })

  ssl
    .command('remove')
    .description('Remove existing SSL certificates')
    .option('--backup', 'Backup before removing (default: true)', true)
    .action(async (opts) => {
      try {
        Output.section('Remove SSL Certificates')

        const certPair = await findCertPair()
        if (!certPair) {
          Output.warn('No certificates found to remove')
          return
        }

        Output.info(`Found certificate: ${certPair.hostname}`)

        if (opts.backup) {
          Output.info('Creating backup...')
          const backupDir = path.join(CERTS_DIR, `backup-${Date.now()}`)
          await fs.ensureDir(backupDir)
          await fs.copy(certPair.certPath, path.join(backupDir, path.basename(certPair.certPath)))
          await fs.copy(certPair.keyPath, path.join(backupDir, path.basename(certPair.keyPath)))
          Output.success(`✓ Backed up to: ${backupDir}`)
        }

        Output.info('Removing certificates...')
        await fs.remove(certPair.certPath)
        await fs.remove(certPair.keyPath)
        Output.success('✓ Certificates removed')
        Output.info('The server will revert to HTTP on next start')
      } catch (err: any) {
        Output.error(`Failed to remove certificates: ${err.message}`)
        process.exit(1)
      }
    })
}
