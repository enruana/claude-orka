import { contextBridge, ipcRenderer } from 'electron'

/**
 * API expuesta al renderer process
 */
const orkaAPI = {
  // Inicialización
  initialize: () => ipcRenderer.invoke('orka:initialize'),

  // Sesiones
  createSession: (name?: string, openTerminal?: boolean) => ipcRenderer.invoke('orka:createSession', name, openTerminal),
  getSessions: (filters?: any) => ipcRenderer.invoke('orka:listSessions', filters), // Alias para app.js
  listSessions: (filters?: any) => ipcRenderer.invoke('orka:listSessions', filters),
  getSession: (sessionId: string) => ipcRenderer.invoke('orka:getSession', sessionId),
  resumeSession: (sessionId: string, openTerminal?: boolean) => ipcRenderer.invoke('orka:resumeSession', sessionId, openTerminal),
  closeSession: (sessionId: string, saveContext?: boolean) =>
    ipcRenderer.invoke('orka:closeSession', sessionId, saveContext),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('orka:deleteSession', sessionId),

  // Forks
  createFork: (sessionId: string, name?: string, vertical?: boolean) =>
    ipcRenderer.invoke('orka:createFork', sessionId, name, vertical),
  closeFork: (sessionId: string, forkId: string, saveContext?: boolean) =>
    ipcRenderer.invoke('orka:closeFork', sessionId, forkId, saveContext),
  resumeFork: (sessionId: string, forkId: string) =>
    ipcRenderer.invoke('orka:resumeFork', sessionId, forkId),
  deleteFork: (sessionId: string, forkId: string) =>
    ipcRenderer.invoke('orka:deleteFork', sessionId, forkId),

  // Comandos
  send: (sessionId: string, command: string, target?: string) =>
    ipcRenderer.invoke('orka:send', sessionId, command, target),
  sendCommand: (sessionId: string, forkId: string, command: string) =>
    ipcRenderer.invoke('orka:send', sessionId, command, forkId), // Alias para app.js

  // Export & Merge
  export: (sessionId: string, forkId: string, customName?: string) =>
    ipcRenderer.invoke('orka:export', sessionId, forkId, customName),
  merge: (sessionId: string, forkId: string) =>
    ipcRenderer.invoke('orka:merge', sessionId, forkId),
  mergeAndClose: (sessionId: string, forkId: string) =>
    ipcRenderer.invoke('orka:mergeAndClose', sessionId, forkId),
}

// Exponer API al renderer
contextBridge.exposeInMainWorld('orka', orkaAPI)

// Tipos para TypeScript (opcional, para el renderer)
export type OrkaAPI = typeof orkaAPI
