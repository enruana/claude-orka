import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import execa from 'execa'

export const CERTS_DIR = path.join(os.homedir(), '.orka', 'certs')

export interface CertPair {
  certPath: string
  keyPath: string
  hostname: string
}

/**
 * Ensure the certs directory exists.
 */
export async function ensureCertsDir(): Promise<void> {
  await fs.ensureDir(CERTS_DIR)
}

/**
 * Scan ~/.orka/certs/ for a matching .crt + .key pair.
 * Returns the first valid pair found, or null.
 */
export async function findCertPair(): Promise<CertPair | null> {
  if (!(await fs.pathExists(CERTS_DIR))) {
    return null
  }

  const entries = await fs.readdir(CERTS_DIR)
  const crtFiles = entries.filter((f) => f.endsWith('.crt'))

  for (const crtFile of crtFiles) {
    const baseName = crtFile.slice(0, -4) // strip .crt
    const keyFile = `${baseName}.key`
    if (entries.includes(keyFile)) {
      const certPath = path.join(CERTS_DIR, crtFile)
      const keyPath = path.join(CERTS_DIR, keyFile)
      return { certPath, keyPath, hostname: baseName }
    }
  }

  return null
}

/**
 * Get the Tailscale FQDN for this machine, e.g. "myhost.flicker-komodo.ts.net".
 * Returns null if Tailscale isn't installed, not logged in, or MagicDNS is disabled.
 */
export async function getTailscaleHostname(): Promise<string | null> {
  try {
    const { stdout } = await execa('tailscale', ['dns', 'status'])
    // Look for "this device at <fqdn>" pattern
    const match = stdout.match(/this device at\s+([\w.-]+\.ts\.net)/i)
    if (match) return match[1]
    return null
  } catch {
    return null
  }
}
