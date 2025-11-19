import { ipcMain } from 'electron'
import { ClaudeOrka } from '../../src/core/ClaudeOrka'
import { logger, LogLevel } from '../../src/utils/logger'

let orka: ClaudeOrka | null = null

/**
 * Configurar handlers IPC
 */
export function setupIPC(projectPath: string) {
  logger.setLevel(LogLevel.INFO)

  // Crear instancia de ClaudeOrka
  orka = new ClaudeOrka(projectPath)

  // Inicializar
  ipcMain.handle('orka:initialize', async () => {
    try {
      await orka!.initialize()
      return { success: true, data: projectPath }
    } catch (error: any) {
      logger.error('Failed to initialize:', error)
      return { success: false, error: error.message }
    }
  })

  // --- SESIONES ---

  ipcMain.handle('orka:createSession', async (_, name?: string, openTerminal?: boolean) => {
    try {
      const session = await orka!.createSession(name, openTerminal)
      return { success: true, data: session }
    } catch (error: any) {
      logger.error('Failed to create session:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('orka:listSessions', async (_, filters?) => {
    try {
      const sessions = await orka!.listSessions(filters)
      return { success: true, data: sessions }
    } catch (error: any) {
      logger.error('Failed to list sessions:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('orka:getSession', async (_, sessionId: string) => {
    try {
      const session = await orka!.getSession(sessionId)
      return { success: true, data: session }
    } catch (error: any) {
      logger.error('Failed to get session:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('orka:resumeSession', async (_, sessionId: string, openTerminal?: boolean) => {
    try {
      const session = await orka!.resumeSession(sessionId, openTerminal)
      return { success: true, data: session }
    } catch (error: any) {
      logger.error('Failed to resume session:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('orka:closeSession', async (_, sessionId: string) => {
    try {
      await orka!.closeSession(sessionId)
      return { success: true }
    } catch (error: any) {
      logger.error('Failed to close session:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('orka:deleteSession', async (_, sessionId: string) => {
    try {
      await orka!.deleteSession(sessionId)
      return { success: true }
    } catch (error: any) {
      logger.error('Failed to delete session:', error)
      return { success: false, error: error.message }
    }
  })

  // --- FORKS ---

  ipcMain.handle('orka:createFork', async (_, sessionId: string, name?: string, vertical?: boolean) => {
    try {
      const fork = await orka!.createFork(sessionId, name, vertical)
      return { success: true, data: fork }
    } catch (error: any) {
      logger.error('Failed to create fork:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('orka:closeFork', async (_, sessionId: string, forkId: string) => {
    try {
      await orka!.closeFork(sessionId, forkId)
      return { success: true }
    } catch (error: any) {
      logger.error('Failed to close fork:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('orka:resumeFork', async (_, sessionId: string, forkId: string) => {
    try {
      const fork = await orka!.resumeFork(sessionId, forkId)
      return { success: true, data: fork }
    } catch (error: any) {
      logger.error('Failed to resume fork:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('orka:deleteFork', async (_, sessionId: string, forkId: string) => {
    try {
      await orka!.deleteFork(sessionId, forkId)
      return { success: true }
    } catch (error: any) {
      logger.error('Failed to delete fork:', error)
      return { success: false, error: error.message }
    }
  })

  // --- COMANDOS ---

  ipcMain.handle('orka:send', async (_, sessionId: string, command: string, target?: string) => {
    try {
      await orka!.send(sessionId, command, target)
      return { success: true }
    } catch (error: any) {
      logger.error('Failed to send command:', error)
      return { success: false, error: error.message }
    }
  })

  // --- EXPORT & MERGE ---

  ipcMain.handle('orka:export', async (_, sessionId: string, forkId: string) => {
    try {
      const exportPath = await orka!.export(sessionId, forkId)
      return { success: true, data: exportPath }
    } catch (error: any) {
      logger.error('Failed to export:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('orka:merge', async (_, sessionId: string, forkId: string) => {
    try {
      await orka!.merge(sessionId, forkId)
      return { success: true }
    } catch (error: any) {
      logger.error('Failed to merge:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('orka:mergeAndClose', async (_, sessionId: string, forkId: string) => {
    try {
      await orka!.mergeAndClose(sessionId, forkId)
      return { success: true }
    } catch (error: any) {
      logger.error('Failed to merge and close:', error)
      return { success: false, error: error.message }
    }
  })

  logger.info('IPC handlers configured')
}
