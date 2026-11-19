import { ChildProcess, spawn } from 'child_process'
import execa from 'execa'
import { logger } from '../utils'

export interface TunnelState {
  running: boolean
  url?: string
  error?: string
  startedAt?: string
  localTarget?: string
}

const TRYCF_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const SPAWN_TIMEOUT_MS = 20_000

class TunnelManager {
  private child: ChildProcess | null = null
  private state: TunnelState = { running: false }
  private urlResolvers: Array<(url: string) => void> = []
  private urlRejectors: Array<(err: Error) => void> = []
  private buffer = ''

  getState(): TunnelState {
    return { ...this.state }
  }

  async start(sharePort: number, protocol: 'http' | 'https'): Promise<TunnelState> {
    if (this.child && this.state.running) return this.getState()

    const target = `${protocol}://localhost:${sharePort}`
    this.state = { running: false, localTarget: target }

    const args = ['tunnel', '--url', target]
    if (protocol === 'https') args.push('--no-tls-verify')

    const found = await this.resolveCloudflared()
    if (!found) {
      this.state.error = 'cloudflared is not installed. Run: orka prepare'
      throw new Error(this.state.error)
    }

    logger.info(`[tunnel] starting cloudflared tunnel --url ${target}`)
    const child = spawn(found, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child

    const onData = (chunk: Buffer) => {
      this.buffer = (this.buffer + chunk.toString('utf8')).slice(-8192)
      const match = TRYCF_RE.exec(this.buffer)
      if (match && !this.state.url) {
        this.state.url = match[0]
        this.state.running = true
        this.state.startedAt = new Date().toISOString()
        logger.info(`[tunnel] ready: ${this.state.url}`)
        this.urlResolvers.splice(0).forEach((r) => r(this.state.url as string))
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('exit', (code, signal) => {
      logger.info(`[tunnel] cloudflared exited code=${code} signal=${signal}`)
      const wasRunning = this.state.running
      this.child = null
      this.state = { running: false }
      if (!wasRunning) {
        const err = new Error(`cloudflared exited before tunnel was ready (code ${code})`)
        this.urlRejectors.splice(0).forEach((rj) => rj(err))
      }
    })

    return new Promise<TunnelState>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('cloudflared did not produce a tunnel URL within 20s'))
        this.stop().catch(() => {})
      }, SPAWN_TIMEOUT_MS)
      this.urlResolvers.push(() => { clearTimeout(timer); resolve(this.getState()) })
      this.urlRejectors.push((err) => { clearTimeout(timer); reject(err) })
    })
  }

  async stop(): Promise<void> {
    const c = this.child
    this.child = null
    this.state = { running: false }
    if (!c) return
    try {
      c.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { c.kill('SIGKILL') } catch {} ; resolve() }, 3000)
        c.once('exit', () => { clearTimeout(t); resolve() })
      })
    } catch (err: any) {
      logger.warn(`[tunnel] stop error: ${err?.message || err}`)
    }
  }

  private async resolveCloudflared(): Promise<string | null> {
    try {
      const { stdout } = await execa('which', ['cloudflared'])
      return stdout.trim() || null
    } catch { return null }
  }
}

let singleton: TunnelManager | null = null
export function getTunnelManager(): TunnelManager {
  if (!singleton) singleton = new TunnelManager()
  return singleton
}
