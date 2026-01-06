import { app, BrowserWindow, ipcMain, shell, screen } from 'electron'
import path from 'path'
import fs from 'fs-extra'
import { fileURLToPath } from 'url'
import { ClaudeOrka } from '../../src/core/ClaudeOrka.js'
import chokidar from 'chokidar'
import execa from 'execa'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// UI Logger - writes to orka.log
class UILogger {
  private logPath: string | null = null

  setProjectPath(projectPath: string) {
    this.logPath = path.join(projectPath, '.claude-orka', 'orka.log')
  }

  private write(level: string, ...args: any[]) {
    const timestamp = new Date().toISOString()
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ')
    const logLine = `${timestamp} [UI:${level}] ${message}`

    console.log(logLine)

    if (this.logPath) {
      try {
        fs.appendFileSync(this.logPath, logLine + '\n')
      } catch (e) {
        // Silently fail if we can't write
      }
    }
  }

  info(...args: any[]) { this.write('INFO', ...args) }
  error(...args: any[]) { this.write('ERROR', ...args) }
  debug(...args: any[]) { this.write('DEBUG', ...args) }
  warn(...args: any[]) { this.write('WARN', ...args) }
}

const uiLogger = new UILogger()

// Store windows by project path
const windows = new Map<string, BrowserWindow>()
const taskbarWindows = new Map<string, BrowserWindow>()

// Store active sessions
let currentSessionId: string | null = null
let currentProjectPath: string | null = null

function createWindow(sessionId: string, projectPath: string) {
  uiLogger.setProjectPath(projectPath)
  uiLogger.info('=== Creating main window ===')
  uiLogger.info(`Session ID: ${sessionId}`)
  uiLogger.info(`Project path: ${projectPath}`)

  // If window already exists for this project, focus it
  if (windows.has(projectPath)) {
    uiLogger.info('Window already exists, focusing existing window')
    const existingWindow = windows.get(projectPath)!
    existingWindow.focus()
    return existingWindow
  }

  // Extract project name from path
  const projectName = path.basename(projectPath)

  // Icon path - check multiple locations
  const iconPath = path.join(__dirname, '../../../public/icon.png')
  const preloadPath = path.join(__dirname, '../preload/preload.js')

  uiLogger.info(`Icon path: ${iconPath}`)
  uiLogger.info(`Preload path: ${preloadPath}`)
  uiLogger.info(`Preload exists: ${fs.existsSync(preloadPath)}`)

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
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  uiLogger.info('BrowserWindow created')

  // Store session info
  currentSessionId = sessionId
  currentProjectPath = projectPath

  // Load UI
  let loadTarget: string
  if (process.env.NODE_ENV === 'development') {
    // Dev mode - load from Vite dev server
    loadTarget = 'http://localhost:5173'
    uiLogger.info(`Loading UI from dev server: ${loadTarget}`)
    mainWindow.loadURL(loadTarget)
  } else {
    // Production - load from built files
    loadTarget = path.join(__dirname, '../renderer/index.html')
    uiLogger.info(`Loading UI from file: ${loadTarget}`)
    uiLogger.info(`File exists: ${fs.existsSync(loadTarget)}`)
    mainWindow.loadFile(loadTarget)
  }

  // Add window lifecycle events for debugging
  mainWindow.webContents.on('did-start-loading', () => {
    uiLogger.info('WebContents: did-start-loading')
  })

  mainWindow.webContents.on('did-stop-loading', () => {
    uiLogger.info('WebContents: did-stop-loading')
  })

  mainWindow.webContents.on('dom-ready', () => {
    uiLogger.info('WebContents: dom-ready')
  })

  mainWindow.webContents.on('did-finish-load', () => {
    uiLogger.info('WebContents: did-finish-load')
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    uiLogger.error(`WebContents: did-fail-load - Code: ${errorCode}, Desc: ${errorDescription}, URL: ${validatedURL}`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    uiLogger.error('WebContents: render-process-gone', details)
  })

  mainWindow.webContents.on('unresponsive', () => {
    uiLogger.warn('WebContents: unresponsive')
  })

  mainWindow.webContents.on('responsive', () => {
    uiLogger.info('WebContents: responsive again')
  })

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    const levelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR']
    const levelName = levelNames[level] || 'LOG'
    uiLogger.info(`[Renderer:${levelName}] ${message}`)
  })

  mainWindow.on('ready-to-show', () => {
    uiLogger.info('Window: ready-to-show')
  })

  mainWindow.on('show', () => {
    uiLogger.info('Window: show')
  })

  // Watch state.json for changes
  watchStateFile(projectPath, mainWindow)

  // Store window
  windows.set(projectPath, mainWindow)

  mainWindow.on('closed', () => {
    uiLogger.info('Window: closed')
    windows.delete(projectPath)
    // Close taskbar if exists
    const taskbar = taskbarWindows.get(projectPath)
    if (taskbar && !taskbar.isDestroyed()) {
      taskbar.close()
    }
    taskbarWindows.delete(projectPath)
  })

  uiLogger.info('Window setup complete')
  return mainWindow
}

function createTaskbarWindow(projectPath: string): BrowserWindow {
  console.log('[Taskbar] Creating taskbar window for project:', projectPath)

  // If taskbar already exists for this project, return it
  if (taskbarWindows.has(projectPath)) {
    const existingTaskbar = taskbarWindows.get(projectPath)!
    console.log('[Taskbar] Taskbar already exists, showing it')
    existingTaskbar.show()
    return existingTaskbar
  }

  // Get screen dimensions
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize

  console.log('[Taskbar] Screen size:', width, 'x', height)

  // Icon path
  const iconPath = path.join(__dirname, '../../../public/icon.png')

  const taskbarWindow = new BrowserWindow({
    width: 80,
    height: 220, // Initial height
    minHeight: 160,
    maxHeight: height - 100, // Leave some margin from screen edges
    x: width - 90,
    y: height / 2 - 110,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    movable: true,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Load taskbar UI
  if (process.env.NODE_ENV === 'development') {
    console.log('[Taskbar] Loading from dev server: http://localhost:5173/taskbar.html')
    taskbarWindow.loadURL('http://localhost:5173/taskbar.html')
  } else {
    const taskbarPath = path.join(__dirname, '../renderer/taskbar.html')
    console.log('[Taskbar] Loading from file:', taskbarPath)
    taskbarWindow.loadFile(taskbarPath)
  }

  // Store taskbar window
  taskbarWindows.set(projectPath, taskbarWindow)

  taskbarWindow.on('closed', () => {
    console.log('[Taskbar] Taskbar window closed')
    taskbarWindows.delete(projectPath)
  })

  taskbarWindow.on('ready-to-show', async () => {
    console.log('[Taskbar] Taskbar ready to show')
    taskbarWindow.show()

    // Send initial session data
    try {
      const orka = new ClaudeOrka(projectPath)
      await orka.initialize()

      if (currentSessionId) {
        const session = await orka.getSession(currentSessionId)
        if (session) {
          taskbarWindow.webContents.send('session-data', session)
        }
      }
    } catch (error) {
      console.error('[Taskbar] Error loading session data:', error)
    }
  })

  console.log('[Taskbar] Taskbar window created successfully')
  return taskbarWindow
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

          // Also update taskbar if it exists
          const taskbar = taskbarWindows.get(projectPath)
          if (taskbar && !taskbar.isDestroyed()) {
            taskbar.webContents.send('session-data', session)
          }
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
  uiLogger.info('IPC: get-session called')
  uiLogger.info(`  currentSessionId: ${currentSessionId}`)
  uiLogger.info(`  currentProjectPath: ${currentProjectPath}`)

  if (!currentSessionId || !currentProjectPath) {
    uiLogger.error('IPC: get-session failed - No active session')
    throw new Error('No active session')
  }

  try {
    uiLogger.info('IPC: Initializing ClaudeOrka...')
    const orka = new ClaudeOrka(currentProjectPath)
    await orka.initialize()
    uiLogger.info('IPC: ClaudeOrka initialized')

    uiLogger.info(`IPC: Getting session ${currentSessionId}...`)
    const session = await orka.getSession(currentSessionId)

    if (session) {
      uiLogger.info(`IPC: Session retrieved successfully - ${session.name}`)
      uiLogger.info(`IPC: Session has ${session.forks?.length || 0} forks`)
    } else {
      uiLogger.warn('IPC: Session not found')
    }

    return session
  } catch (error: any) {
    uiLogger.error(`IPC: get-session error - ${error.message}`)
    throw error
  }
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

  // Send state update to UI immediately after fork creation
  const updatedSession = await orka.getSession(sessionId)
  if (updatedSession && currentProjectPath) {
    const mainWin = windows.get(currentProjectPath)
    const taskbarWin = taskbarWindows.get(currentProjectPath)
    if (mainWin) mainWin.webContents.send('state-updated', updatedSession)
    if (taskbarWin) taskbarWin.webContents.send('state-updated', updatedSession)
  }

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

  // Send state update to UI
  const updatedSession = await orka.getSession(sessionId)
  if (updatedSession && currentProjectPath) {
    const mainWin = windows.get(currentProjectPath)
    const taskbarWin = taskbarWindows.get(currentProjectPath)
    if (mainWin) mainWin.webContents.send('state-updated', updatedSession)
    if (taskbarWin) taskbarWin.webContents.send('state-updated', updatedSession)
  }
})

ipcMain.handle('close-fork', async (_, sessionId: string, forkId: string) => {
  if (!currentProjectPath) {
    throw new Error('No active project')
  }

  const orka = new ClaudeOrka(currentProjectPath)
  await orka.initialize()

  await orka.closeFork(sessionId, forkId)

  // Send state update to UI
  const updatedSession = await orka.getSession(sessionId)
  if (updatedSession && currentProjectPath) {
    const mainWin = windows.get(currentProjectPath)
    const taskbarWin = taskbarWindows.get(currentProjectPath)
    if (mainWin) mainWin.webContents.send('state-updated', updatedSession)
    if (taskbarWin) taskbarWin.webContents.send('state-updated', updatedSession)
  }
})

ipcMain.handle('save-node-position', async (_, sessionId: string, nodeId: string, position: { x: number; y: number }) => {
  if (!currentProjectPath) {
    throw new Error('No active project')
  }

  const orka = new ClaudeOrka(currentProjectPath)
  await orka.initialize()

  await orka.saveNodePosition(sessionId, nodeId, position)
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

  const projectName = path.basename(currentProjectPath)

  uiLogger.info(`[OpenFolder] Looking for window with project: ${projectName}`)

  // Try to focus existing Cursor window first
  try {
    const checkCursor = await execa('osascript', [
      '-e',
      `tell application "System Events"
        if exists (processes where name is "Cursor") then
          tell application "Cursor"
            activate
            set windowList to name of every window
            repeat with i from 1 to count of windowList
              set windowName to item i of windowList
              if windowName contains "${projectName}" then
                set index of window i to 1
                return "found"
              end if
            end repeat
          end tell
        end if
        return "not_found"
      end tell`,
    ])

    uiLogger.info(`[OpenFolder] Cursor check result: ${checkCursor.stdout.trim()}`)
    if (checkCursor.stdout.trim() === 'found') {
      return
    }
  } catch (error: any) {
    uiLogger.info(`[OpenFolder] Could not check/focus Cursor: ${error.message}`)
  }

  // Try to focus existing VSCode window
  try {
    const checkVSCode = await execa('osascript', [
      '-e',
      `tell application "System Events"
        if exists (processes where name is "Code") then
          tell application "Visual Studio Code"
            activate
            set windowList to name of every window
            repeat with i from 1 to count of windowList
              set windowName to item i of windowList
              if windowName contains "${projectName}" then
                set index of window i to 1
                return "found"
              end if
            end repeat
          end tell
        end if
        return "not_found"
      end tell`,
    ])

    uiLogger.info(`[OpenFolder] VSCode check result: ${checkVSCode.stdout.trim()}`)
    if (checkVSCode.stdout.trim() === 'found') {
      return
    }
  } catch (error: any) {
    uiLogger.info(`[OpenFolder] Could not check/focus VSCode: ${error.message}`)
  }

  // No existing window found, open new one with Cursor
  uiLogger.info('[OpenFolder] No existing window found, opening new one')
  try {
    await execa('cursor', [currentProjectPath])
    uiLogger.info('[OpenFolder] Opened new Cursor window')
    return
  } catch (error) {
    // Cursor not available, try VSCode
  }

  // Try to open with VSCode
  try {
    await execa('code', [currentProjectPath])
    uiLogger.info('[OpenFolder] Opened new VSCode window')
    return
  } catch (error) {
    // VSCode not available, fallback to Finder
  }

  // Fallback: open in Finder
  uiLogger.info('[OpenFolder] Fallback to Finder')
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

ipcMain.handle('minimize-to-taskbar', async () => {
  console.log('[Minimize] minimize-to-taskbar called')

  if (!currentProjectPath) {
    console.error('[Minimize] No active project path')
    throw new Error('No active project')
  }

  console.log('[Minimize] Current project path:', currentProjectPath)

  const mainWindow = windows.get(currentProjectPath)
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log('[Minimize] Hiding main window and creating taskbar')
    mainWindow.hide()
    createTaskbarWindow(currentProjectPath)
  } else {
    console.error('[Minimize] Main window not found or destroyed')
  }
})

ipcMain.handle('restore-from-taskbar', async () => {
  if (!currentProjectPath) {
    throw new Error('No active project')
  }

  const mainWindow = windows.get(currentProjectPath)
  const taskbarWindow = taskbarWindows.get(currentProjectPath)

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }

  if (taskbarWindow && !taskbarWindow.isDestroyed()) {
    taskbarWindow.close()
  }
  taskbarWindows.delete(currentProjectPath)
})

ipcMain.handle('resize-taskbar', async (_, newHeight: number) => {
  if (!currentProjectPath) {
    throw new Error('No active project')
  }

  const taskbarWindow = taskbarWindows.get(currentProjectPath)
  if (taskbarWindow && !taskbarWindow.isDestroyed()) {
    const [currentWidth] = taskbarWindow.getSize()
    const bounds = taskbarWindow.getBounds()

    // Keep the window centered vertically when resizing
    const heightDiff = newHeight - bounds.height
    const newY = bounds.y - heightDiff / 2

    taskbarWindow.setBounds({
      x: bounds.x,
      y: Math.max(50, newY), // Don't go above screen
      width: currentWidth,
      height: newHeight,
    })
  }
})

// App lifecycle
app.whenReady().then(() => {
  console.log('[Electron] App ready')

  // Get session ID and project path from command line args
  const args = process.argv.slice(2)
  console.log('[Electron] Command line args:', args)

  const sessionIdIndex = args.indexOf('--session-id')
  const projectPathIndex = args.indexOf('--project-path')

  console.log('[Electron] sessionIdIndex:', sessionIdIndex)
  console.log('[Electron] projectPathIndex:', projectPathIndex)

  if (sessionIdIndex !== -1 && args[sessionIdIndex + 1]) {
    const sessionId = args[sessionIdIndex + 1]
    const projectPath =
      projectPathIndex !== -1 && args[projectPathIndex + 1]
        ? args[projectPathIndex + 1]
        : process.cwd()

    console.log('[Electron] Creating window with sessionId:', sessionId)
    console.log('[Electron] Creating window with projectPath:', projectPath)

    createWindow(sessionId, projectPath)
  } else {
    console.error('[Electron] Missing required --session-id argument')
    console.log('[Electron] Available args:', args)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // Don't create window on activate if no session
    }
  })
})

app.on('window-all-closed', () => {
  console.log('[Electron] All windows closed, quitting...')
  // Quit app on all platforms when windows are closed
  app.quit()
})
