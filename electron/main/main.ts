import { app, BrowserWindow, dialog } from 'electron'
import * as path from 'path'
import { setupIPC } from './ipc-handlers'

let mainWindow: BrowserWindow | null = null
let projectPath: string | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: 'Claude Orka',
    backgroundColor: '#1a1a1a',
  })

  // Cargar el HTML
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  // DevTools en modo desarrollo
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function selectProjectPath() {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Selecciona el directorio del proyecto',
    buttonLabel: 'Seleccionar',
  })

  if (!result.canceled && result.filePaths.length > 0) {
    projectPath = result.filePaths[0]
    return projectPath
  }

  return null
}

app.on('ready', async () => {
  // Pedir al usuario que seleccione el proyecto
  const selectedPath = await selectProjectPath()

  if (!selectedPath) {
    console.log('No se seleccionó ningún proyecto, cerrando...')
    app.quit()
    return
  }

  // Configurar IPC handlers con el path del proyecto
  setupIPC(selectedPath)

  // Crear ventana
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})

export { mainWindow, projectPath }
