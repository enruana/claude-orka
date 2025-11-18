"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
/**
 * API expuesta al renderer process
 */
const orkaAPI = {
    // Inicialización
    initialize: () => electron_1.ipcRenderer.invoke('orka:initialize'),
    // Sesiones
    createSession: (name, openTerminal) => electron_1.ipcRenderer.invoke('orka:createSession', name, openTerminal),
    listSessions: (filters) => electron_1.ipcRenderer.invoke('orka:listSessions', filters),
    getSession: (sessionId) => electron_1.ipcRenderer.invoke('orka:getSession', sessionId),
    resumeSession: (sessionId, openTerminal) => electron_1.ipcRenderer.invoke('orka:resumeSession', sessionId, openTerminal),
    closeSession: (sessionId, saveContext) => electron_1.ipcRenderer.invoke('orka:closeSession', sessionId, saveContext),
    deleteSession: (sessionId) => electron_1.ipcRenderer.invoke('orka:deleteSession', sessionId),
    // Forks
    createFork: (sessionId, name, vertical) => electron_1.ipcRenderer.invoke('orka:createFork', sessionId, name, vertical),
    closeFork: (sessionId, forkId, saveContext) => electron_1.ipcRenderer.invoke('orka:closeFork', sessionId, forkId, saveContext),
    resumeFork: (sessionId, forkId) => electron_1.ipcRenderer.invoke('orka:resumeFork', sessionId, forkId),
    // Comandos
    send: (sessionId, command, target) => electron_1.ipcRenderer.invoke('orka:send', sessionId, command, target),
    // Export & Merge
    export: (sessionId, forkId, customName) => electron_1.ipcRenderer.invoke('orka:export', sessionId, forkId, customName),
    merge: (sessionId, forkId) => electron_1.ipcRenderer.invoke('orka:merge', sessionId, forkId),
    mergeAndClose: (sessionId, forkId) => electron_1.ipcRenderer.invoke('orka:mergeAndClose', sessionId, forkId),
};
// Exponer API al renderer
electron_1.contextBridge.exposeInMainWorld('orka', orkaAPI);
//# sourceMappingURL=preload.js.map