/**
 * Helpers shared by `orka start`, `orka stop`, `orka restart`, `orka logs`
 * for tracking a backgrounded server process.
 *
 * State lives in two small files inside ~/.orka/:
 *   - server.pid   →  the daemon PID (single integer, no trailing newline)
 *   - server.json  →  { port, protocol, startedAt } — info `stop`/`logs`
 *                     don't need but the future `orka status` will
 *
 * The PID file is the source of truth. server.json is purely informational.
 */

import path from 'path'
import os from 'os'
import fs from 'fs-extra'

const ORKA_DIR = path.join(os.homedir(), '.orka')

export const PID_FILE = path.join(ORKA_DIR, 'server.pid')
export const INFO_FILE = path.join(ORKA_DIR, 'server.json')
export const LOG_FILE = path.join(ORKA_DIR, 'orka.log')

export interface ServerInfo {
  port: number
  protocol: 'http' | 'https'
  startedAt: string
}

/** Read the recorded server PID, or null if no pidfile exists. */
export async function readServerPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(PID_FILE, 'utf-8')
    const pid = parseInt(raw.trim(), 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

/** Best-effort check that a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver anything — just probes for existence.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Returns the live server's PID, or null if no server is running.
 * Stale pidfiles are cleaned up automatically.
 */
export async function getRunningServerPid(): Promise<number | null> {
  const pid = await readServerPid()
  if (pid === null) return null
  if (isProcessAlive(pid)) return pid
  // Stale pidfile — remove so subsequent calls don't keep reporting a
  // ghost PID.
  await fs.remove(PID_FILE).catch(() => {})
  await fs.remove(INFO_FILE).catch(() => {})
  return null
}

export async function writeServerState(pid: number, info: ServerInfo): Promise<void> {
  await fs.ensureDir(ORKA_DIR)
  await fs.writeFile(PID_FILE, String(pid), 'utf-8')
  await fs.writeJson(INFO_FILE, info, { spaces: 2 })
}

export async function clearServerState(): Promise<void> {
  await fs.remove(PID_FILE).catch(() => {})
  await fs.remove(INFO_FILE).catch(() => {})
}

export async function readServerInfo(): Promise<ServerInfo | null> {
  try {
    return await fs.readJson(INFO_FILE)
  } catch {
    return null
  }
}
