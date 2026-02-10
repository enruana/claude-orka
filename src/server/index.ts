import express from 'express'
import cors from 'cors'
import path from 'path'
import http from 'http'
import { fileURLToPath } from 'url'
import { getGlobalStateManager } from '../core/GlobalStateManager'
import { projectsRouter } from './api/projects'
import { sessionsRouter } from './api/sessions'
import { browseRouter } from './api/browse'
import { filesRouter } from './api/files'
import { gitRouter } from './api/git'
import { transcribeRouter } from './api/transcribe'
import { agentsRouter } from './api/agents'
import { hooksRouter } from './api/hooks'
import { getAgentManager } from '../agent/AgentManager'
import { logger } from '../utils'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface ServerOptions {
  port?: number
}

export async function createServer(options: ServerOptions = {}) {
  // Initialize global logger
  logger.setGlobalLogFile()

  const globalState = await getGlobalStateManager()
  const port = options.port || globalState.getServerPort()

  const app = express()

  // Middleware
  app.use(cors())
  app.use(express.json())

  // API routes
  app.use('/api/projects', projectsRouter)
  app.use('/api/sessions', sessionsRouter)
  app.use('/api/browse', browseRouter)
  app.use('/api/files', filesRouter)
  app.use('/api/git', gitRouter)
  app.use('/api/transcribe', transcribeRouter)
  app.use('/api/agents', agentsRouter)
  app.use('/api/hooks', hooksRouter)

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // ttyd HTTP proxy - forwards /ttyd/:port/* to the actual ttyd instance
  // Critical for mobile where only the main server port is reachable
  app.use('/ttyd', (req, res) => {
    const match = req.url.match(/^\/(\d+)(.*)$/)
    if (!match) {
      res.status(400).send('Invalid ttyd path')
      return
    }
    const ttydPort = parseInt(match[1])
    const ttydPath = match[2] || '/'

    // Pipe HTTP request directly to ttyd
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: ttydPort,
      path: ttydPath,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${ttydPort}` },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers)
      proxyRes.pipe(res)
    })

    proxyReq.on('error', (err) => {
      logger.error(`ttyd HTTP proxy error (port ${ttydPort}): ${err.message}`)
      if (!res.headersSent) {
        res.status(502).send('Terminal not available')
      }
    })

    req.pipe(proxyReq)
  })

  // Terminal route - serve custom HTML with xterm.js + virtual keyboard
  // Register both with and without trailing slash for Express 5 compatibility
  const serveTerminal: express.RequestHandler = async (_req, res) => {
    const fsExtra = await import('fs-extra')

    // Look for terminal-mobile.html in possible locations
    const possiblePaths = [
      path.join(__dirname, 'terminal-mobile.html'),           // Built CLI: dist/terminal-mobile.html
      path.join(__dirname, '../server/terminal-mobile.html'), // Built SDK: dist/src/server
      path.join(__dirname, '../../src/server/terminal-mobile.html'), // Source: src/server
    ]

    for (const htmlPath of possiblePaths) {
      if (await fsExtra.default.pathExists(htmlPath)) {
        return res.sendFile(htmlPath)
      }
    }

    logger.error('terminal-mobile.html not found in any expected location')
    res.status(404).send('Terminal HTML not found')
  }
  app.get('/terminal/:port', serveTerminal)
  app.get('/terminal/:port/', serveTerminal)

  // Serve static files for the UI
  // Look for built UI files - check for assets directory (only exists in built output)
  const possibleUIPaths = [
    path.join(__dirname, 'web-ui'),                   // Built CLI (esbuild): dist/cli.js -> dist/web-ui
    path.join(__dirname, '../web-ui'),                // Built SDK (tsc): dist/src/server -> dist/web-ui
    path.join(__dirname, '../../dist/web-ui'),        // Source (tsx): src/server -> dist/web-ui
  ]

  logger.info(`Looking for UI. __dirname: ${__dirname}`)
  const fs = await import('fs-extra')
  let uiPath: string | null = null
  for (const p of possibleUIPaths) {
    const assetsPath = path.join(p, 'assets')
    const exists = await fs.default.pathExists(assetsPath)
    logger.info(`  Checking: ${p} (assets: ${exists})`)
    try {
      // Check for assets directory to ensure this is built output, not source
      if (exists) {
        uiPath = p
        break
      }
    } catch {
      // Continue
    }
  }

  if (uiPath) {
    app.use(express.static(uiPath))
    // SPA fallback - serve index.html for all non-API routes
    // Express 5 requires named parameters for wildcards
    app.use((req, res, next) => {
      // Exclude API routes, terminal routes, and non-GET requests
      if (req.path.startsWith('/api') || req.path.startsWith('/terminal') || req.path.startsWith('/ttyd') || req.method !== 'GET') {
        return next()
      }
      res.sendFile(path.join(uiPath!, 'index.html'))
    })
    logger.info(`Serving UI from: ${uiPath}`)
  } else {
    // No UI found, serve a simple status page
    app.get('/', (_req, res) => {
      res.send(`
        <html>
          <head><title>Claude Orka</title></head>
          <body style="font-family: sans-serif; padding: 40px; background: #1e1e2e; color: #cdd6f4;">
            <h1>Claude Orka Server</h1>
            <p>Server is running. UI not found.</p>
            <p>API available at <a href="/api/health" style="color: #89b4fa;">/api/health</a></p>
            <h2>Projects</h2>
            <pre id="projects">Loading...</pre>
            <script>
              fetch('/api/projects')
                .then(r => r.json())
                .then(data => {
                  document.getElementById('projects').textContent = JSON.stringify(data, null, 2);
                });
            </script>
          </body>
        </html>
      `)
    })
  }

  return { app, port }
}

export async function startServer(options: ServerOptions = {}): Promise<void> {
  const { app, port } = await createServer(options)

  // Initialize and start the Agent Manager (includes hook server)
  try {
    const agentManager = await getAgentManager()
    await agentManager.startHookServer()
    const hookPort = 9999 // Default hook server port
    logger.info(`Hook server started on port ${hookPort}`)
  } catch (error: any) {
    logger.error(`Failed to start hook server: ${error.message}`)
  }

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      logger.info(`Orka server running at http://localhost:${port}`)
      console.log(`
┌─────────────────────────────────────────┐
│                                         │
│   🎭 Claude Orka Server                 │
│                                         │
│   Running at: http://localhost:${port}     │
│                                         │
│   API:  http://localhost:${port}/api       │
│   UI:   http://localhost:${port}           │
│   Hooks: http://localhost:9999          │
│                                         │
└─────────────────────────────────────────┘
      `)
      resolve()
    })

    // WebSocket proxy for ttyd - each connection gets its own independent pipe
    server.on('upgrade', (req, socket, head) => {
      const match = req.url?.match(/^\/ttyd\/(\d+)(.*)$/)
      if (!match) return

      const ttydPort = parseInt(match[1])
      const ttydPath = match[2] || '/'

      logger.info(`WS proxy: upgrading connection to ttyd port ${ttydPort} path ${ttydPath}`)

      // Create a fresh HTTP request to ttyd for this specific connection
      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: ttydPort,
        path: ttydPath,
        method: 'GET',
        headers: {
          ...req.headers,
          host: `127.0.0.1:${ttydPort}`,
        },
      })

      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        // Build the 101 response to send back to the client
        let responseHead = `HTTP/1.1 101 Switching Protocols\r\n`
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value) responseHead += `${key}: ${value}\r\n`
        }
        responseHead += '\r\n'

        socket.write(responseHead)

        // Forward any buffered data
        if (proxyHead && proxyHead.length > 0) socket.write(proxyHead)
        if (head && head.length > 0) proxySocket.write(head)

        // Pipe the two sockets together - fully independent per connection
        proxySocket.pipe(socket)
        socket.pipe(proxySocket)

        // Clean up on either side closing
        const cleanup = () => {
          proxySocket.destroy()
          socket.destroy()
        }
        socket.on('error', cleanup)
        socket.on('close', cleanup)
        proxySocket.on('error', cleanup)
        proxySocket.on('close', cleanup)

        logger.info(`WS proxy: connected to ttyd port ${ttydPort}`)
      })

      proxyReq.on('error', (err) => {
        logger.error(`WS proxy error (port ${ttydPort}): ${err.message}`)
        socket.destroy()
      })

      proxyReq.end()
    })
  })
}
