import { contextBridge, ipcRenderer } from 'electron'
import type { Session } from '../../src/models/Session'

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  getSession: () => ipcRenderer.invoke('get-session'),

  selectNode: (nodeId: string) => ipcRenderer.invoke('select-node', nodeId),

  createFork: (sessionId: string, name: string, parentId: string) =>
    ipcRenderer.invoke('create-fork', sessionId, name, parentId),

  exportFork: (sessionId: string, forkId: string) =>
    ipcRenderer.invoke('export-fork', sessionId, forkId),

  mergeFork: (sessionId: string, forkId: string) =>
    ipcRenderer.invoke('merge-fork', sessionId, forkId),

  closeFork: (sessionId: string, forkId: string) =>
    ipcRenderer.invoke('close-fork', sessionId, forkId),

  openExportFile: (exportPath: string) =>
    ipcRenderer.invoke('open-export-file', exportPath),

  openProjectFolder: () => ipcRenderer.invoke('open-project-folder'),

  focusTerminal: () => ipcRenderer.invoke('focus-terminal'),

  saveAndClose: () => ipcRenderer.invoke('save-and-close'),

  onStateUpdate: (callback: (session: Session) => void) => {
    ipcRenderer.on('state-updated', (_, session) => callback(session))
  },

  closeWindow: () => ipcRenderer.send('close-window'),
})
