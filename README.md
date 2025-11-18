# Claude-Orka 🐋

**SDK para orquestar sesiones de Claude Code con tmux**

Claude-Orka te permite gestionar múltiples sesiones de Claude Code como si fueran ramas de Git, facilitando la exploración de diferentes enfoques sin perder contexto.

## Características

✅ **Múltiples sesiones persistentes** - Crea y guarda sesiones con contexto completo
✅ **Forks de conversación** - Ramifica conversaciones para explorar alternativas
✅ **Auto-export de contextos** - Guarda automáticamente usando `/fork:export` de Claude
✅ **Merge a main** - Combina el trabajo de forks en la sesión principal
✅ **Restauración de sesiones** - Retoma sesiones guardadas con todo su contexto
✅ **Todo en `.claude-orka/`** - Estado centralizado por proyecto

## Requisitos

- **Node.js** >= 18
- **tmux** instalado (`brew install tmux` en macOS)
- **Claude Code CLI** instalado

## Instalación

```bash
npm install claude-orka
```

## Uso Básico

```typescript
import { ClaudeOrka } from 'claude-orka'

// Crear instancia para tu proyecto
const orka = new ClaudeOrka('/path/to/your/project')
await orka.initialize()

// Crear una nueva sesión
const session = await orka.createSession('my-feature')
console.log('Sesión creada:', session.id)

// Crear un fork para explorar una alternativa
const fork = await orka.createFork(session.id, 'testing-redis')
console.log('Fork creado:', fork.id)

// Enviar comandos
await orka.send(session.id, 'Implementa autenticación JWT')
await orka.send(session.id, 'Prueba con Redis en lugar de cache en memoria', fork.id)

// Exportar y hacer merge del fork
await orka.export(session.id, fork.id)
await orka.merge(session.id, fork.id)

// Cerrar fork (auto-guarda contexto)
await orka.closeFork(session.id, fork.id)

// Cerrar sesión (auto-guarda contexto)
await orka.closeSession(session.id)

// Más tarde... restaurar la sesión
const restoredSession = await orka.resumeSession(session.id)
console.log('Sesión restaurada con contexto completo')
```

## Estructura del Proyecto

Cuando inicializas ClaudeOrka en un proyecto, crea la siguiente estructura:

```
your-project/
├── .claude-orka/              # Carpeta de Orka (agregar a .gitignore)
│   ├── state.json            # Estado de todas las sesiones
│   ├── sessions/             # Contextos de sesiones
│   │   └── session-abc123.md
│   ├── forks/                # Contextos de forks
│   │   └── fork-feature-xyz.md
│   └── exports/              # Exports manuales
│
└── .gitignore                # Debe incluir .claude-orka/
```

## API Completa

### ClaudeOrka

#### Constructor

```typescript
new ClaudeOrka(projectPath: string)
```

#### Inicialización

```typescript
await orka.initialize()
```

#### Sesiones

```typescript
// Crear sesión
await orka.createSession(name?: string): Promise<Session>

// Listar sesiones
await orka.listSessions(filters?: SessionFilters): Promise<Session[]>

// Obtener sesión
await orka.getSession(sessionId: string): Promise<Session | null>

// Restaurar sesión guardada
await orka.resumeSession(sessionId: string): Promise<Session>

// Cerrar sesión (guarda contexto por defecto)
await orka.closeSession(sessionId: string, saveContext?: boolean): Promise<void>

// Eliminar sesión permanentemente
await orka.deleteSession(sessionId: string): Promise<void>
```

#### Forks

```typescript
// Crear fork
await orka.createFork(
  sessionId: string,
  name?: string,
  vertical?: boolean
): Promise<Fork>

// Cerrar fork (guarda contexto por defecto)
await orka.closeFork(
  sessionId: string,
  forkId: string,
  saveContext?: boolean
): Promise<void>

// Restaurar fork guardado
await orka.resumeFork(sessionId: string, forkId: string): Promise<Fork>
```

#### Comandos

```typescript
// Enviar comando a main o fork
await orka.send(
  sessionId: string,
  command: string,
  target?: string  // ID del fork (opcional)
): Promise<void>
```

#### Export & Merge

```typescript
// Exportar contexto de fork
await orka.export(
  sessionId: string,
  forkId: string,
  customName?: string
): Promise<string>

// Hacer merge a main
await orka.merge(sessionId: string, forkId: string): Promise<void>

// Exportar, merge y cerrar (todo en uno)
await orka.mergeAndClose(sessionId: string, forkId: string): Promise<void>
```

## Ejemplos de Uso

### Ejemplo 1: Explorar alternativas

```typescript
import { ClaudeOrka } from 'claude-orka'

const orka = new ClaudeOrka(process.cwd())
await orka.initialize()

// Crear sesión principal
const session = await orka.createSession('auth-implementation')

// Trabajo en main
await orka.send(session.id, 'Necesito implementar autenticación')

// Fork para probar JWT
const jwtFork = await orka.createFork(session.id, 'jwt-approach')
await orka.send(session.id, 'Implementa con JWT', jwtFork.id)

// Fork para probar OAuth
const oauthFork = await orka.createFork(session.id, 'oauth-approach')
await orka.send(session.id, 'Implementa con OAuth 2.0', oauthFork.id)

// Decidir cuál usar y hacer merge
await orka.mergeAndClose(session.id, jwtFork.id)

// Descartar el otro fork
await orka.closeFork(session.id, oauthFork.id, false) // No guardar
```

### Ejemplo 2: Sesión larga con pausas

```typescript
import { ClaudeOrka } from 'claude-orka'

const orka = new ClaudeOrka('/Users/me/my-app')
await orka.initialize()

// Día 1: Crear sesión y trabajar
const session = await orka.createSession('refactor-db')
await orka.send(session.id, 'Vamos a refactorizar la capa de datos')
// ... trabajo ...

// Cerrar al final del día (guarda contexto automáticamente)
await orka.closeSession(session.id)

// Día 2: Restaurar sesión con todo el contexto
const restored = await orka.resumeSession(session.id)
console.log('Sesión restaurada! Claude tiene todo el contexto.')
```

### Ejemplo 3: Listar y gestionar sesiones

```typescript
import { ClaudeOrka } from 'claude-orka'

const orka = new ClaudeOrka(process.cwd())
await orka.initialize()

// Listar todas las sesiones activas
const activeSessions = await orka.listSessions({ status: 'active' })
console.log('Sesiones activas:', activeSessions.length)

// Listar todas las sesiones guardadas
const savedSessions = await orka.listSessions({ status: 'saved' })
console.log('Sesiones guardadas:', savedSessions.length)

// Buscar por nombre
const authSessions = await orka.listSessions({ name: 'auth' })
console.log('Sesiones de autenticación:', authSessions)

// Cerrar todas las sesiones activas
for (const session of activeSessions) {
  await orka.closeSession(session.id)
}
```

## Modelos de Datos

### Session

```typescript
interface Session {
  id: string                    // session-{nanoid}
  name: string                  // Nombre descriptivo
  tmuxSessionName: string       // orchestrator-{id}
  projectPath: string           // Path absoluto
  createdAt: string             // ISO timestamp
  status: 'active' | 'saved'    // Estado
  main: MainBranch              // Rama principal
  forks: Fork[]                 // Forks de la sesión
  lastActivity: string          // ISO timestamp
}
```

### Fork

```typescript
interface Fork {
  id: string                    // fork-{name?}-{nanoid}
  name: string                  // Nombre descriptivo
  tmuxPaneId?: string           // ID del pane (si está activo)
  parentId: string              // 'main' o ID de otro fork
  createdAt: string             // ISO timestamp
  contextPath?: string          // Path al contexto guardado
  status: 'active' | 'saved' | 'merged'
  lastActivity: string          // ISO timestamp
  mergedToMain?: boolean        // Si se hizo merge
  mergedAt?: string             // Timestamp del merge
}
```

## Consideraciones

### Auto-Export

Cuando cierras una sesión o fork con `saveContext=true` (default):
1. Se envía `/fork:export` a Claude
2. Se espera 3 segundos
3. Se captura el output
4. Se guarda en `.claude-orka/sessions/` o `.claude-orka/forks/`

### Gitignore

Agrega esto a tu `.gitignore`:

```
.claude-orka/
```

### Logs

Controla el nivel de logs:

```typescript
import { logger, LogLevel } from 'claude-orka'

logger.setLevel(LogLevel.DEBUG) // DEBUG, INFO, WARN, ERROR
```

## Roadmap

- [x] Sprint 1: Setup + Modelos
- [x] Sprint 2: TmuxCommands
- [x] Sprint 3: StateManager
- [x] Sprint 4-5: SessionManager
- [x] Sprint 6: ClaudeOrka SDK
- [x] Sprint 7: Electron App ✅

## Electron App

Claude-Orka incluye una aplicación de escritorio con interfaz visual:

### Ejecutar la app

```bash
# Modo desarrollo (con DevTools)
npm run electron:dev

# Modo producción
npm run electron
```

### Empaquetar la app

```bash
# Generar .dmg y .zip para macOS
npm run package
```

La app te permitirá:
- 🎯 Seleccionar el directorio del proyecto
- 📋 Ver todas las sesiones (activas y guardadas)
- ➕ Crear nuevas sesiones
- ▶️ Restaurar sesiones guardadas
- 🌿 Crear y gestionar forks
- 📤 Exportar y hacer merge de forks
- 💬 Enviar comandos a sesiones/forks
- 🪟 Abrir terminales directamente desde la UI

## Contribuir

Las contribuciones son bienvenidas! Por favor:

1. Fork el proyecto
2. Crea una rama (`git checkout -b feature/amazing`)
3. Commit tus cambios (`git commit -m 'Add amazing feature'`)
4. Push (`git push origin feature/amazing`)
5. Abre un Pull Request

## Licencia

MIT

## Autor

Claude-Orka - Orquestador de sesiones de Claude Code

---

**¿Necesitas ayuda?** Abre un issue en GitHub
