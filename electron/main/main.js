"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectPath = exports.mainWindow = void 0;
const electron_1 = require("electron");
const path = __importStar(require("path"));
const ipc_handlers_1 = require("./ipc-handlers");
let mainWindow = null;
exports.mainWindow = mainWindow;
let projectPath = null;
exports.projectPath = projectPath;
function createWindow() {
    exports.mainWindow = mainWindow = new electron_1.BrowserWindow({
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
    });
    // Cargar el HTML
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    // DevTools en modo desarrollo
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
    mainWindow.on('closed', () => {
        exports.mainWindow = mainWindow = null;
    });
}
async function selectProjectPath() {
    const result = await electron_1.dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Selecciona el directorio del proyecto',
        buttonLabel: 'Seleccionar',
    });
    if (!result.canceled && result.filePaths.length > 0) {
        exports.projectPath = projectPath = result.filePaths[0];
        return projectPath;
    }
    return null;
}
electron_1.app.on('ready', async () => {
    // Pedir al usuario que seleccione el proyecto
    const selectedPath = await selectProjectPath();
    if (!selectedPath) {
        console.log('No se seleccionó ningún proyecto, cerrando...');
        electron_1.app.quit();
        return;
    }
    // Configurar IPC handlers con el path del proyecto
    (0, ipc_handlers_1.setupIPC)(selectedPath);
    // Crear ventana
    createWindow();
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
electron_1.app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
//# sourceMappingURL=main.js.map