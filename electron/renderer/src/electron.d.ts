import type { Session } from '../../../src/models/Session'

export interface ElectronAPI {
  getSession: () => Promise<Session>
  selectNode: (nodeId: string) => Promise<void>
  createFork: (sessionId: string, name: string, parentId: string) => Promise<void>
  exportFork: (sessionId: string, forkId: string) => Promise<void>
  mergeFork: (sessionId: string, forkId: string) => Promise<void>
  closeFork: (sessionId: string, forkId: string) => Promise<void>
  openExportFile: (exportPath: string) => Promise<void>
  onStateUpdate: (callback: (session: Session) => void) => void
  closeWindow: () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
