import path from 'path'
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
        Output.section('Which URL to open')
        // A Tailscale certificate is issued for the tailnet name and
        // covers only that name. Reaching the same server through
        // `localhost` or its IP presents a certificate for a different
        // host, so the browser says "Not secure" — with a valid, freshly
        // renewed certificate sitting right there. That is an unreasonable
        // thing to deduce from the warning alone, so say it plainly.
        let port = 3456
        try {
          const { getGlobalStateManager } = await import('../../core/GlobalStateManager')
          port = (await getGlobalStateManager()).getServerPort()
        } catch {
          // Never configured, or the config is unreadable — the default
          // is right often enough to still be worth printing.
        }
        Output.success(`  https://${certPair.hostname}:${port}`)
        Output.warn('  https://localhost — will always read as "Not secure"')
        Output.info('    The certificate is issued for the tailnet name and covers only it.')
        Output.info('    Same for the raw IP address.')

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
        //
        // Written STRAIGHT to the destination with --cert-file/--key-file.
        // `tailscale cert <domain>` with no flags writes DOMAIN.crt and
        // DOMAIN.key into the CURRENT WORKING DIRECTORY — not into
        // ~/.tailscale/certs, which is where an earlier version of this
        // command went looking. It found nothing, copied nothing, and
        // reported success while leaving the expired certificate in
        // place; the only trace was stray .crt/.key files wherever the
        // user happened to run it from.
        await ensureCertsDir()
        const certPath = path.join(CERTS_DIR, `${tailscaleHostname}.crt`)
        const keyPath = path.join(CERTS_DIR, `${tailscaleHostname}.key`)

        Output.info(`Requesting a certificate for ${tailscaleHostname}…`)
        const args = ['cert', '--cert-file', certPath, '--key-file', keyPath, tailscaleHostname]

        // sudo is not required on every platform, and when it isn't, using
        // it writes root-owned files the server then cannot read. Try as
        // the current user first and escalate only if that's refused.
        let usedSudo = false
        try {
          await execa('tailscale', args, { stdio: 'inherit' })
        } catch (err: any) {
          Output.warn('Retrying with sudo (the daemon requires elevated access here)')
          usedSudo = true
          await execa('sudo', ['tailscale', ...args], { stdio: 'inherit' })
        }

        if (usedSudo) {
          // Hand the files back to the user running the server, or it
          // will fail to read the key at startup.
          const uid = typeof process.getuid === 'function' ? process.getuid() : null
          const gid = typeof process.getgid === 'function' ? process.getgid() : null
          if (uid !== null && gid !== null) {
            try {
              await execa('sudo', ['chown', `${uid}:${gid}`, certPath, keyPath])
            } catch {
              Output.warn('Could not change ownership — you may need to chown the certs manually')
            }
          }
        }

        // VERIFY. The previous version reported success without ever
        // checking, which is exactly how a silent no-op survived two
        // renewals.
        if (!(await fs.pathExists(certPath)) || !(await fs.pathExists(keyPath))) {
          Output.error('Tailscale reported success but the files are not there')
          Output.info(`  Expected: ${certPath}`)
          process.exit(1)
        }
        const fresh = await getCertInfo(certPath)
        if (!fresh) {
          Output.error('The new certificate could not be parsed')
          process.exit(1)
        }
        const expiresAt = new Date(fresh.validUntil)
        if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
          Output.error(`The new certificate is already expired (valid until ${fresh.validUntil})`)
          process.exit(1)
        }

        const days = Math.round((expiresAt.getTime() - Date.now()) / 86400000)
        Output.success(`✓ Certificate installed · valid until ${fresh.validUntil} (${days} days)`)
        Output.info(`  Cert: ${certPath}`)
        Output.info(`  Key:  ${keyPath}`)
        Output.info('')
        Output.section('Next Steps')
        Output.info('Restart the server so it picks up the new certificate:')
        Output.info('  orka restart')
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
