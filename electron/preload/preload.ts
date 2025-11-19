import { contextBridge, ipcRenderer } from 'electron'
import type { Session } from '../../src/models/Session'

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  getSession: () => ipcRenderer.invoke('get-session'),

  selectNode: (nodeId: string) => ipcRenderer.invoke('select-node', nodeId),

  createFork: (sessionId: string, name: string) =>
    ipcRenderer.invoke('create-fork', sessionId, name),

  exportFork: (sessionId: string, forkId: string) =>
    ipcRenderer.invoke('export-fork', sessionId, forkId),

  mergeFork: (sessionId: string, forkId: string) =>
    ipcRenderer.invoke('merge-fork', sessionId, forkId),

  onStateUpdate: (callback: (session: Session) => void) => {
    ipcRenderer.on('state-updated', (_, session) => callback(session))
  },

  closeWindow: () => ipcRenderer.send('close-window'),
})
