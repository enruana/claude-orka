import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { ClaudeOrka } from '../../src/core/ClaudeOrka.js'
import chokidar from 'chokidar'
import execa from 'execa'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Store windows by project path
const windows = new Map<string, BrowserWindow>()

// Store active sessions
let currentSessionId: string | null = null
let currentProjectPath: string | null = null

function createWindow(sessionId: string, projectPath: string) {
  // If window already exists for this project, focus it
  if (windows.has(projectPath)) {
    const existingWindow = windows.get(projectPath)!
    existingWindow.focus()
    return existingWindow
  }

  // Extract project name from path
  const projectName = path.basename(projectPath)

  const mainWindow = new BrowserWindow({
    width: 600,
    height: 800,
    minWidth: 500,
    minHeight: 600,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    title: `Claude Orka - ${projectName}`,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Store session info
  currentSessionId = sessionId
  currentProjectPath = projectPath

  // Load UI
  if (process.env.NODE_ENV === 'development') {
    // Dev mode - load from Vite dev server
    mainWindow.loadURL('http://localhost:5173')
  } else {
    // Production - load from built files
    const indexPath = path.join(__dirname, '../renderer/index.html')
    mainWindow.loadFile(indexPath)
  }

  // Watch state.json for changes
  watchStateFile(projectPath, mainWindow)

  // Store window
  windows.set(projectPath, mainWindow)

  mainWindow.on('closed', () => {
    windows.delete(projectPath)
  })

  return mainWindow
}

function watchStateFile(projectPath: string, window: BrowserWindow) {
  const statePath = path.join(projectPath, '.claude-orka/state.json')

  const watcher = chokidar.watch(statePath, {
    persistent: true,
    ignoreInitial: true,
  })

  watcher.on('change', async () => {
    try {
      const orka = new ClaudeOrka(projectPath)
      await orka.initialize()

      if (currentSessionId) {
        const session = await orka.getSession(currentSessionId)
        if (session) {
          window.webContents.send('state-updated', session)
        }
      }
    } catch (error) {
      console.error('Error watching state file:', error)
    }
  })

  window.on('closed', () => {
    watcher.close()
  })
}

// IPC Handlers
ipcMain.handle('get-session', async () => {
  if (!currentSessionId || !currentProjectPath) {
    throw new Error('No active session')
  }

  const orka = new ClaudeOrka(currentProjectPath)
  await orka.initialize()

  const session = await orka.getSession(currentSessionId)
  return session
})

ipcMain.handle('select-node', async (_, nodeId: string) => {
  if (!currentSessionId || !currentProjectPath) {
    throw new Error('No active session')
  }

  const orka = new ClaudeOrka(currentProjectPath)
  await orka.initialize()

  const session = await orka.getSession(currentSessionId)
  if (!session) return

  // Get tmux pane ID for the selected node
  let tmuxPaneId: string | undefined

  if (nodeId === 'main') {
    tmuxPaneId = session.main?.tmuxPaneId
  } else {
    const fork = session.forks.find((f) => f.id === nodeId)
    tmuxPaneId = fork?.tmuxPaneId
  }

  if (tmuxPaneId) {
    // Focus the tmux pane
    await execa('tmux', ['select-pane', '-t', tmuxPaneId])
  }
})

ipcMain.handle('create-fork', async (_, sessionId: string, name: string, parentId: string) => {
  if (!currentProjectPath) {
    throw new Error('No active project')
  }

  const orka = new ClaudeOrka(currentProjectPath)
  await orka.initialize()

  const fork = await orka.createFork(sessionId, name, parentId)
  return fork
})

ipcMain.handle('export-fork', async (_, sessionId: string, forkId: string) => {
  if (!currentProjectPath) {
    throw new Error('No active project')
  }

  const orka = new ClaudeOrka(currentProjectPath)
  await orka.initialize()

  const summary = await orka.generateForkExport(sessionId, forkId)
  return summary
})

ipcMain.handle('merge-fork', async (_, sessionId: string, forkId: string) => {
  if (!currentProjectPath) {
    throw new Error('No active project')
  }

  const orka = new ClaudeOrka(currentProjectPath)
  await orka.initialize()

  await orka.merge(sessionId, forkId)
})

ipcMain.handle('close-fork', async (_, sessionId: string, forkId: string) => {
  if (!currentProjectPath) {
    throw new Error('No active project')
  }

  const orka = new ClaudeOrka(currentProjectPath)
  await orka.initialize()

  await orka.closeFork(sessionId, forkId)
})

ipcMain.handle('open-export-file', async (_, exportPath: string) => {
  if (!currentProjectPath) {
    throw new Error('No active project')
  }

  const fullPath = path.join(currentProjectPath, exportPath)
  await shell.openPath(fullPath)
})

ipcMain.handle('open-project-folder', async () => {
  if (!currentProjectPath) {
    throw new Error('No active project')
  }

  // Try to open with Cursor first
  try {
    await execa('cursor', [currentProjectPath])
    return
  } catch (error) {
    // Cursor not available, try VSCode
  }

  // Try to open with VSCode
  try {
    await execa('code', [currentProjectPath])
    return
  } catch (error) {
    // VSCode not available, fallback to Finder
  }

  // Fallback: open in Finder
  await shell.openPath(currentProjectPath)
})

ipcMain.handle('focus-terminal', async () => {
  // Try to activate Terminal.app or iTerm.app using AppleScript
  const terminalApps = ['Terminal', 'iTerm']

  for (const app of terminalApps) {
    try {
      await execa('osascript', ['-e', `tell application "${app}" to activate`])
      return
    } catch (error) {
      // App not available or not running, try next
    }
  }

  // If no terminal app is running, open Terminal.app
  try {
    await execa('open', ['-a', 'Terminal'])
  } catch (error) {
    console.error('Failed to open terminal:', error)
  }
})

ipcMain.handle('save-and-close', async () => {
  if (currentSessionId && currentProjectPath) {
    try {
      const orka = new ClaudeOrka(currentProjectPath)
      await orka.initialize()

      const session = await orka.getSession(currentSessionId)
      if (session?.tmuxSessionId) {
        console.log('Save and close: detaching from tmux session:', session.tmuxSessionId)

        // Detach from tmux (but keep session alive)
        try {
          await execa('tmux', ['detach-client', '-s', session.tmuxSessionId])
          console.log('Detached from tmux session (session remains alive)')
        } catch (error) {
          console.log('Error detaching from tmux:', error)
        }

        // Wait a moment for detach
        await new Promise((resolve) => setTimeout(resolve, 300))

        // Try to close the specific terminal window using AppleScript
        try {
          await execa('osascript', [
            '-e',
            `tell application "Terminal" to close (first window whose name contains "${session.tmuxSessionId}")`,
          ])
          console.log('Closed specific Terminal window')
        } catch (error) {
          console.log('Could not close specific window with AppleScript')

          // Try to close by quitting Terminal if no other windows
          try {
            const { stdout } = await execa('osascript', [
              '-e',
              'tell application "Terminal" to count windows',
            ])
            const windowCount = parseInt(stdout.trim())

            if (windowCount === 1) {
              // Only one window, safe to quit Terminal
              await execa('osascript', ['-e', 'tell application "Terminal" to quit'])
              console.log('Quit Terminal (was last window)')
            } else {
              console.log('Multiple Terminal windows open, cannot close safely')
            }
          } catch (countError) {
            console.log('Could not determine Terminal window count:', countError)
          }
        }
      }
    } catch (error) {
      console.error('Error in save-and-close:', error)
    }
  }

  // Quit the Electron app
  app.quit()
})

ipcMain.on('close-window', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  window?.close()
})

// App lifecycle
app.whenReady().then(() => {
  // Get session ID and project path from command line args
  const args = process.argv.slice(2)
  const sessionIdIndex = args.indexOf('--session-id')
  const projectPathIndex = args.indexOf('--project-path')

  if (sessionIdIndex !== -1 && args[sessionIdIndex + 1]) {
    const sessionId = args[sessionIdIndex + 1]
    const projectPath =
      projectPathIndex !== -1 && args[projectPathIndex + 1]
        ? args[projectPathIndex + 1]
        : process.cwd()

    createWindow(sessionId, projectPath)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // Don't create window on activate if no session
    }
  })
})

app.on('window-all-closed', () => {
  // Quit app on all platforms when windows are closed
  app.quit()
})
