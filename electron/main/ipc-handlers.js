"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupIPC = setupIPC;
const electron_1 = require("electron");
const ClaudeOrka_1 = require("../../src/core/ClaudeOrka");
const logger_1 = require("../../src/utils/logger");
let orka = null;
/**
 * Configurar handlers IPC
 */
function setupIPC(projectPath) {
    logger_1.logger.setLevel(logger_1.LogLevel.INFO);
    // Crear instancia de ClaudeOrka
    orka = new ClaudeOrka_1.ClaudeOrka(projectPath);
    // Inicializar
    electron_1.ipcMain.handle('orka:initialize', async () => {
        try {
            await orka.initialize();
            return { success: true, projectPath };
        }
        catch (error) {
            logger_1.logger.error('Failed to initialize:', error);
            return { success: false, error: error.message };
        }
    });
    // --- SESIONES ---
    electron_1.ipcMain.handle('orka:createSession', async (_, name, openTerminal) => {
        try {
            const session = await orka.createSession(name, openTerminal);
            return { success: true, data: session };
        }
        catch (error) {
            logger_1.logger.error('Failed to create session:', error);
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('orka:listSessions', async (_, filters) => {
        try {
            const sessions = await orka.listSessions(filters);
            return { success: true, data: sessions };
        }
        catch (error) {
            logger_1.logger.error('Failed to list sessions:', error);
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('orka:getSession', async (_, sessionId) => {
        try {
            const session = await orka.getSession(sessionId);
            return { success: true, data: session };
        }
        catch (error) {
            logger_1.logger.error('Failed to get session:', error);
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('orka:resumeSession', async (_, sessionId, openTerminal) => {
        try {
            const session = await orka.resumeSession(sessionId, openTerminal);
            return { success: true, data: session };
        }
        catch (error) {
            logger_1.logger.error('Failed to resume session:', error);
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('orka:closeSession', async (_, sessionId, saveContext) => {
        try {
            await orka.closeSession(sessionId, saveContext);
            return { success: true };
        }
        catch (error) {
            logger_1.logger.error('Failed to close session:', error);
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('orka:deleteSession', async (_, sessionId) => {
        try {
            await orka.deleteSession(sessionId);
            return { success: true };
        }
        catch (error) {
            logger_1.logger.error('Failed to delete session:', error);
            return { success: false, error: error.message };
        }
    });
    // --- FORKS ---
    electron_1.ipcMain.handle('orka:createFork', async (_, sessionId, name, vertical) => {
        try {
            const fork = await orka.createFork(sessionId, name, vertical);
            return { success: true, data: fork };
        }
        catch (error) {
            logger_1.logger.error('Failed to create fork:', error);
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('orka:closeFork', async (_, sessionId, forkId, saveContext) => {
        try {
            await orka.closeFork(sessionId, forkId, saveContext);
            return { success: true };
        }
        catch (error) {
            logger_1.logger.error('Failed to close fork:', error);
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('orka:resumeFork', async (_, sessionId, forkId) => {
        try {
            const fork = await orka.resumeFork(sessionId, forkId);
            return { success: true, data: fork };
        }
        catch (error) {
            logger_1.logger.error('Failed to resume fork:', error);
            return { success: false, error: error.message };
        }
    });
    // --- COMANDOS ---
    electron_1.ipcMain.handle('orka:send', async (_, sessionId, command, target) => {
        try {
            await orka.send(sessionId, command, target);
            return { success: true };
        }
        catch (error) {
            logger_1.logger.error('Failed to send command:', error);
            return { success: false, error: error.message };
        }
    });
    // --- EXPORT & MERGE ---
    electron_1.ipcMain.handle('orka:export', async (_, sessionId, forkId, customName) => {
        try {
            const exportPath = await orka.export(sessionId, forkId, customName);
            return { success: true, data: exportPath };
        }
        catch (error) {
            logger_1.logger.error('Failed to export:', error);
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('orka:merge', async (_, sessionId, forkId) => {
        try {
            await orka.merge(sessionId, forkId);
            return { success: true };
        }
        catch (error) {
            logger_1.logger.error('Failed to merge:', error);
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('orka:mergeAndClose', async (_, sessionId, forkId) => {
        try {
            await orka.mergeAndClose(sessionId, forkId);
            return { success: true };
        }
        catch (error) {
            logger_1.logger.error('Failed to merge and close:', error);
            return { success: false, error: error.message };
        }
    });
    logger_1.logger.info('IPC handlers configured');
}
//# sourceMappingURL=ipc-handlers.js.map