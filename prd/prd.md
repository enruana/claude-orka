# Especificación Técnica: tmux Orchestrator para Claude Code

## 1. Contexto y Problema

### 1.1 Situación Actual
Cuando se trabaja con Claude Code, el contexto de la conversación es limitado. Al evaluar diferentes enfoques o soluciones, el contexto se consume rápidamente, obligando al usuario a:
- Perder el hilo de la sesión principal
- Repetir información de contexto
- No poder experimentar sin afectar el flujo principal

### 1.2 Necesidad
Se necesita una forma de **ramificar el trabajo** (similar a Git branches) donde se pueda:
- Crear un "fork" del contexto actual
- Explorar una solución alternativa sin afectar la rama principal
- Decidir si mantener, descartar o fusionar el trabajo del fork
- Todo esto sin consumir el contexto de la sesión principal

## 2. Solución Propuesta

### 2.1 Concepto General
Desarrollar un **orquestador de terminales** que use **tmux** como motor de ejecución para gestionar múltiples sesiones de Claude Code como si fueran ramas de Git.

### 2.2 Flujo de Trabajo Deseado
```
1. Usuario trabaja en sesión principal (main) de Claude Code
2. Llega a un punto donde quiere explorar alternativa
3. Crea un fork → Se abre nuevo panel tmux con Claude Code
4. Trabaja en el fork independientemente
5. Al terminar:
   a) Si no le gustó → Cierra el fork (descarta)
   b) Si le gustó → Exporta contexto y hace merge a main
```

### 2.3 Arquitectura de Componentes

```
┌─────────────────────────────────────────┐
│         TUI (Blessed)                   │
│  - Árbol de sesiones                    │
│  - Panel de comandos                    │
│  - Vista de estado                      │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│      Orquestador (Core)                 │
│  - SessionManager                       │
│  - StateManager                         │
│  - CommandExecutor                      │
│  - ContextMerger                        │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│         tmux                            │
│  - Sesiones                             │
│  - Ventanas                             │
│  - Paneles (main + forks)               │
└─────────────────────────────────────────┘
```

## 3. Especificación Técnica Detallada

### 3.1 Estructura de Datos

#### Estado Global (orchestrator-state.json)
```json
{
  "version": "1.0.0",
  "sessions": {
    "session-abc123": {
      "id": "session-abc123",
      "name": "my-project",
      "tmuxSessionName": "orchestrator-session-abc123",
      "projectPath": "/home/user/project",
      "createdAt": "2025-11-12T10:00:00Z",
      "status": "active",
      "main": {
        "tmuxPaneId": "%1",
        "tmuxWindowId": "@1",
        "lastActivity": "2025-11-12T10:30:00Z"
      },
      "forks": [
        {
          "id": "fork-refactor-api-xyz789",
          "name": "refactor-api",
          "tmuxPaneId": "%2",
          "parentId": "main",
          "projectPath": "/home/user/project",
          "createdAt": "2025-11-12T10:15:00Z",
          "contextExportPath": null,
          "status": "active",
          "lastActivity": "2025-11-12T10:30:00Z"
        }
      ]
    }
  },
  "activeSessions": ["session-abc123"],
  "lastUpdated": "2025-11-12T10:30:00Z"
}
```

### 3.2 Modelos de Datos

#### Session
```typescript
interface Session {
  id: string;                    // ID único generado
  name: string;                  // Nombre descriptivo
  tmuxSessionName: string;       // Nombre en tmux
  projectPath: string;           // Path del proyecto
  createdAt: string;             // ISO timestamp
  status: 'active' | 'inactive' | 'error';
  main: MainBranch;              // Rama principal
  forks: Fork[];                 // Ramas derivadas
}
```

#### Fork
```typescript
interface Fork {
  id: string;                    // fork-{name?}-{shortId}
  name: string;                  // Nombre descriptivo
  tmuxPaneId: string;            // ID del pane en tmux
  parentId: string;              // 'main' o ID de otro fork
  projectPath: string;           // Path heredado
  createdAt: string;             // ISO timestamp
  contextExportPath?: string;    // Path del contexto exportado
  status: 'active' | 'merging' | 'closed';
  lastActivity: string;          // ISO timestamp
}
```

### 3.3 Componentes Core

#### 3.3.1 SessionManager

**Responsabilidad**: Gestión del ciclo de vida de sesiones y forks.

**Métodos principales**:

```typescript
class SessionManager {
  // Crear nueva sesión tmux con Claude Code
  async createSession(projectPath: string, name?: string): Promise<Session>
  
  // Crear fork (nuevo pane) desde main o desde otro fork
  async createFork(
    sessionId: string, 
    forkName?: string, 
    parentId?: string,
    vertical?: boolean
  ): Promise<Fork>
  
  // Enviar comando a un pane específico
  async sendCommand(
    sessionId: string, 
    command: string, 
    targetId?: string
  ): Promise<void>
  
  // Exportar contexto de un fork
  async exportForkContext(
    sessionId: string, 
    forkId: string, 
    exportPath: string
  ): Promise<string>
  
  // Cerrar fork (opcionalmente exportando primero)
  async closeFork(
    sessionId: string, 
    forkId: string, 
    exportFirst?: boolean
  ): Promise<void>
  
  // Hacer merge del contexto de fork a main
  async mergeForkToMain(
    sessionId: string, 
    forkId: string
  ): Promise<void>
  
  // Listar todas las sesiones
  async listSessions(): Promise<Session[]>
  
  // Cerrar sesión completa
  async closeSession(sessionId: string): Promise<void>
}
```

**Detalles de implementación**:

- **IDs únicos**: Usar `nanoid` para generar IDs cortos
  - Si se pasa nombre: `fork-{sanitized-name}-{8-char-id}`
  - Si no: `fork-{8-char-id}`
  
- **División de panes**: Por defecto horizontal (`-v` en tmux)
  - Opcionalmente vertical (`-h` en tmux)
  
- **Generación de nombres tmux**: `orchestrator-{session-id}`

#### 3.3.2 StateManager

**Responsabilidad**: Persistencia del estado en JSON.

**Métodos principales**:

```typescript
class StateManager {
  // Inicializar estado desde archivo o crear nuevo
  async initialize(): Promise<void>
  
  // Operaciones de sesiones
  async addSession(session: Session): Promise<void>
  async getSession(sessionId: string): Promise<Session | null>
  async getAllSessions(): Promise<Session[]>
  async updateSessionStatus(sessionId: string, status: Session['status']): Promise<void>
  
  // Operaciones de forks
  async addFork(sessionId: string, fork: Fork): Promise<void>
  async updateForkExportPath(sessionId: string, forkId: string, path: string): Promise<void>
  async updateForkStatus(sessionId: string, forkId: string, status: Fork['status']): Promise<void>
  
  // Operaciones de actividad
  async updateLastActivity(sessionId: string, targetId?: string): Promise<void>
}
```

**Detalles de implementación**:

- Archivo JSON en: `./state/orchestrator-state.json`
- Formato indentado (2 espacios) para legibilidad
- Actualizar `lastUpdated` en cada guardado
- Crear directorio automáticamente si no existe

#### 3.3.3 TmuxCommands (Utils)

**Responsabilidad**: Wrapper de comandos tmux.

**Métodos principales**:

```typescript
class TmuxCommands {
  // Verificar disponibilidad
  static async isAvailable(): Promise<boolean>
  
  // Gestión de sesiones
  static async createSession(name: string, dir: string): Promise<string>
  static async listSessions(): Promise<Array<{id: string, name: string}>>
  static async killSession(name: string): Promise<void>
  static async sessionExists(name: string): Promise<boolean>
  
  // Gestión de panes
  static async getMainWindowId(session: string): Promise<string>
  static async getMainPaneId(session: string): Promise<string>
  static async splitPane(session: string, dir: string, vertical?: boolean): Promise<string>
  static async killPane(paneId: string): Promise<void>
  
  // Comandos
  static async sendCommand(paneId: string, command: string, enter?: boolean): Promise<void>
  static async capturePane(paneId: string, startLine?: number): Promise<string>
}
```

**Detalles de implementación**:

- Usar `execa` para ejecutar comandos
- Lanzar `TmuxError` personalizado en caso de fallo
- Capturar outputs con formato `-F` para parsing fácil
- Usar `-d` (detached) al crear sesiones

### 3.4 Flujo de Exportación y Merge

#### Proceso de Exportación de Fork

```
1. Usuario decide cerrar fork con merge
2. Orquestador ejecuta:
   ┌─────────────────────────────────────┐
   │ Fork Pane                           │
   │ $ claude code export \              │
   │   --output /path/to/exports/        │
   │   fork-xyz-context.txt              │
   └─────────────────────────────────────┘
3. Esperar 2-3 segundos para que termine
4. Verificar que archivo exista
5. Guardar path en fork.contextExportPath
6. Cerrar pane (tmux kill-pane)
```

#### Proceso de Merge a Main

```
1. Verificar que fork tenga contextExportPath
2. En pane main, ejecutar:
   ┌─────────────────────────────────────┐
   │ Main Pane                           │
   │ $ cat /path/to/exports/             │
   │   fork-xyz-context.txt              │
   └─────────────────────────────────────┘
3. El output se mostrará en main
4. Usuario puede copiar/usar el contexto
```

**Nota importante**: El contexto **NO** se guarda físicamente durante el trabajo, solo se exporta al cerrar el fork para hacer merge.

### 3.5 Interfaz TUI (MVP con Blessed)

#### Layout Propuesto

```
┌─────────────────────────────────────────────────────┐
│ tmux Orchestrator v1.0              [q] Quit        │
├─────────────────────┬───────────────────────────────┤
│                     │                               │
│  Sessions Tree      │  Command Panel                │
│                     │                               │
│  ▾ my-project       │  > _                          │
│    ├─ main          │                               │
│    └─ forks         │  Last command:                │
│       ├─ refactor   │  claude code export...        │
│       └─ feature-x  │                               │
│                     │                               │
├─────────────────────┴───────────────────────────────┤
│ Status: 1 active session | 2 forks | Last: 10:30   │
└─────────────────────────────────────────────────────┘
```

#### Keybindings Básicos (MVP)

```
n  - Nueva sesión
f  - Nuevo fork
c  - Enviar comando al target seleccionado
e  - Exportar contexto de fork
m  - Merge fork a main
x  - Cerrar fork/sesión
q  - Salir
↑↓ - Navegar árbol
```

#### Componentes Blessed

```typescript
// src/tui/App.ts
class OrchestratorApp {
  private screen: blessed.Widgets.Screen
  private sessionTree: SessionTree
  private commandPanel: CommandPanel
  private statusBar: StatusBar
  
  async start(): Promise<void>
  private setupKeybindings(): void
  private render(): void
}

// src/tui/components/SessionTree.ts
class SessionTree extends blessed.Widgets.Tree {
  async loadSessions(): Promise<void>
  getSelectedTarget(): { sessionId: string, targetId: string }
}

// src/tui/components/CommandPanel.ts
class CommandPanel extends blessed.Widgets.Box {
  async promptCommand(): Promise<string>
  displayOutput(output: string): void
}
```

## 4. Estructura del Proyecto

```
tmux-orchestrator/
├── src/
│   ├── core/
│   │   ├── SessionManager.ts
│   │   ├── StateManager.ts
│   │   └── ContextMerger.ts
│   ├── models/
│   │   ├── State.ts
│   │   ├── Session.ts
│   │   └── Fork.ts
│   ├── utils/
│   │   ├── tmux.ts
│   │   └── logger.ts
│   ├── tui/
│   │   ├── App.ts
│   │   ├── components/
│   │   │   ├── SessionTree.ts
│   │   │   ├── CommandPanel.ts
│   │   │   └── StatusBar.ts
│   │   └── keybindings.ts
│   └── index.ts
├── state/
│   └── orchestrator-state.json
├── package.json
├── tsconfig.json
└── README.md
```

## 5. Dependencias

```json
{
  "dependencies": {
    "execa": "^8.0.1",
    "nanoid": "^5.0.4",
    "blessed": "^0.1.81"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "@types/blessed": "^0.1.25",
    "typescript": "^5.3.0",
    "tsx": "^4.7.0"
  }
}
```

## 6. Plan de Implementación

### Fase 1: Fundamentos (Semana 1)
- [ ] Setup proyecto TypeScript
- [ ] Implementar modelos de datos
- [ ] Implementar TmuxCommands (utils)
- [ ] Implementar StateManager
- [ ] Tests básicos de persistencia

### Fase 2: Core Logic (Semana 2)
- [ ] Implementar SessionManager completo
- [ ] Lógica de creación de sesiones
- [ ] Lógica de creación de forks
- [ ] Envío de comandos
- [ ] Exportación de contexto
- [ ] Tests de SessionManager

### Fase 3: TUI Básico (Semana 3)
- [ ] Setup Blessed
- [ ] Implementar SessionTree
- [ ] Implementar CommandPanel
- [ ] Implementar StatusBar
- [ ] Keybindings básicos
- [ ] Integración con SessionManager

### Fase 4: Merge y Refinamiento (Semana 4)
- [ ] Implementar merge de contextos
- [ ] Manejo de errores robusto
- [ ] Logging completo
- [ ] Documentación
- [ ] Testing end-to-end

## 7. Casos de Uso

### 7.1 Crear nueva sesión y fork

```bash
# Usuario inicia orquestador
$ npm start

# En TUI:
[n] → Prompt: "Project path: /home/user/my-app"
     → Prompt: "Session name (optional): my-app"
     → Crea sesión tmux con Claude Code

[f] → Prompt: "Fork name (optional): try-redis"
     → Divide pane y abre Claude Code en fork
```

### 7.2 Trabajar en fork y hacer merge

```bash
# Usuario trabaja en fork
[c] → "Implementa cache con Redis"
     → Comando se envía a fork seleccionado

# Decide hacer merge
[e] → Exporta contexto a archivo
[m] → Merge contexto a main
[x] → Cierra fork
```

### 7.3 Descartar fork

```bash
# Usuario no quiere el trabajo del fork
[x] → Prompt: "Export before closing? (y/n)"
     → n
     → Cierra fork sin exportar
```

## 8. Consideraciones Técnicas

### 8.1 Manejo de Errores

- Verificar disponibilidad de tmux al inicio
- Capturar errores de comandos tmux
- Manejar sesiones/panes que ya no existen
- Validar paths de archivos

### 8.2 Sincronización

- StateManager es la fuente de verdad
- Guardar estado después de cada operación
- No asumir que tmux está sincronizado con estado

### 8.3 Limitaciones Conocidas

- No hay comunicación bidireccional real con Claude Code
- No se puede "pausar" el contexto de Claude Code
- La exportación depende de que Claude Code tenga el comando `export`
- tmux debe estar instalado

### 8.4 Extensiones Futuras

- Interfaz web con WebSockets
- Soporte para múltiples backends (no solo tmux)
- Historial de comandos por sesión
- Diff visual entre contextos
- Auto-merge inteligente con IA

## 9. Comandos de Desarrollo

```bash
# Instalar dependencias
npm install

# Desarrollo
npm run dev

# Build
npm run build

# Ejecutar
npm start

# Tests
npm test
```

## 10. Ejemplo de Estado Final

```json
{
  "version": "1.0.0",
  "sessions": {
    "session-myapp-a1b2c3d4": {
      "id": "session-myapp-a1b2c3d4",
      "name": "my-app",
      "tmuxSessionName": "orchestrator-session-myapp-a1b2c3d4",
      "projectPath": "/home/user/my-app",
      "createdAt": "2025-11-12T09:00:00Z",
      "status": "active",
      "main": {
        "tmuxPaneId": "%1",
        "tmuxWindowId": "@1",
        "lastActivity": "2025-11-12T10:45:00Z"
      },
      "forks": [
        {
          "id": "fork-redis-cache-x9y8z7w6",
          "name": "redis-cache",
          "tmuxPaneId": "%3",
          "parentId": "main",
          "projectPath": "/home/user/my-app",
          "createdAt": "2025-11-12T10:00:00Z",
          "contextExportPath": "/home/user/my-app/.orchestrator/exports/fork-redis-cache-x9y8z7w6-context.txt",
          "status": "closed",
          "lastActivity": "2025-11-12T10:30:00Z"
        }
      ]
    }
  },
  "activeSessions": ["session-myapp-a1b2c3d4"],
  "lastUpdated": "2025-11-12T10:45:00Z"
}
```

---

**Versión**: 1.0  
**Fecha**: 2025-11-12  
**Autor**: Especificación para implementación con Claude Code