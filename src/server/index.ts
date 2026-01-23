import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { getGlobalStateManager } from '../core/GlobalStateManager'
import { projectsRouter } from './api/projects'
import { sessionsRouter } from './api/sessions'
import { browseRouter } from './api/browse'
import { filesRouter } from './api/files'
import { gitRouter } from './api/git'
import { transcribeRouter } from './api/transcribe'
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

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // Mobile terminal route - serve custom HTML with virtual keyboard
  app.get('/terminal/:port', async (_req, res) => {
    const fs = await import('fs-extra')

    // Look for terminal-mobile.html in possible locations
    const possiblePaths = [
      path.join(__dirname, 'terminal-mobile.html'),           // Built CLI: dist/terminal-mobile.html
      path.join(__dirname, '../server/terminal-mobile.html'), // Built SDK: dist/src/server
      path.join(__dirname, '../../src/server/terminal-mobile.html'), // Source: src/server
    ]

    for (const htmlPath of possiblePaths) {
      if (await fs.default.pathExists(htmlPath)) {
        logger.info(`Serving mobile terminal from: ${htmlPath}`)
        return res.sendFile(htmlPath)
      }
    }

    res.status(404).send('Mobile terminal HTML not found')
  })

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
      if (req.path.startsWith('/api') || req.path.startsWith('/terminal') || req.method !== 'GET') {
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

  return new Promise((resolve) => {
    app.listen(port, () => {
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
│                                         │
└─────────────────────────────────────────┘
      `)
      resolve()
    })
  })
}
