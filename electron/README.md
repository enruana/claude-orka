# Claude-Orka Electron App

Aplicación de escritorio para gestionar sesiones de Claude Code con interfaz visual.

## Estructura

```
electron/
├── main/
│   ├── main.ts              # Proceso principal de Electron
│   └── ipc-handlers.ts      # Handlers IPC (conecta UI con SDK)
├── preload/
│   └── preload.ts           # Bridge seguro entre main y renderer
└── renderer/
    ├── index.html           # Estructura HTML
    ├── styles.css           # Estilos
    └── app.js               # Lógica de la UI
```

## Comandos

### Desarrollo

```bash
# Compilar TypeScript y ejecutar app (con DevTools)
npm run electron:dev
```

### Producción

```bash
# Compilar y ejecutar app
npm run electron
```

### Empaquetar

```bash
# Generar .dmg y .zip para macOS
npm run package

# Los archivos se generan en: release/
```

## Características

### 🎯 Selección de Proyecto
- Al iniciar, se abre un diálogo para seleccionar el directorio del proyecto
- El proyecto debe ser un repositorio donde quieras usar Claude-Orka

### 📋 Gestión de Sesiones
- Ver todas las sesiones (filtrar por: activas, guardadas, todas)
- Crear nuevas sesiones
- Restaurar sesiones guardadas con su contexto
- Cerrar sesiones (con opción de auto-guardar contexto)
- Eliminar sesiones permanentemente

### 🌿 Gestión de Forks
- Crear forks desde sesiones activas
- Ver estado de cada fork (active, saved, merged)
- Exportar contexto de forks
- Hacer merge de forks a main
- Cerrar forks (con opción de auto-guardar)
- Restaurar forks guardados

### 💬 Envío de Comandos
- Enviar comandos a main o a cualquier fork activo
- Selector de target (main o fork)
- Atajo: Cmd+Enter o Ctrl+Enter en el textarea

### 🪟 Integración con Terminal
- Al crear o restaurar sesiones, automáticamente abre una ventana de terminal
- La terminal se conecta directamente a la sesión tmux
- Puedes ver e interactuar con Claude en tiempo real

## Flujo de Uso

1. **Iniciar la app** → Seleccionar directorio del proyecto
2. **Crear sesión** → Se abre automáticamente una terminal con Claude
3. **Trabajar en main** → Interactúa normalmente con Claude
4. **Crear fork** → Para explorar una alternativa
5. **Trabajar en fork** → Se abre otra terminal para el fork
6. **Exportar y merge** → Combina el trabajo del fork en main
7. **Cerrar fork** → El contexto se guarda automáticamente
8. **Cerrar sesión** → Todo se guarda para retomarlo después

## Atajos de Teclado

- `Cmd/Ctrl + Enter` - Enviar comando (desde textarea)

## Tecnologías

- **Electron** - Framework de aplicación de escritorio
- **IPC** - Comunicación entre procesos (segura con contextBridge)
- **ClaudeOrka SDK** - Lógica de negocio en Node.js
- **Vanilla JS** - UI sin frameworks pesados

## Notas

### Seguridad
- El `preload.ts` usa `contextBridge` para exponer solo las APIs necesarias
- `nodeIntegration` está deshabilitado
- `contextIsolation` está habilitado

### Plataformas
- ✅ **macOS** - Completamente soportado
- 🔶 **Linux** - Debería funcionar (no testeado)
- ❌ **Windows** - Requiere ajustes en `TmuxCommands.openTerminalWindow()`

## Personalización

### Cambiar tema
Edita `electron/renderer/styles.css`:
```css
:root {
  --bg-primary: #1a1a1a;     /* Fondo principal */
  --accent-primary: #4a9eff; /* Color de acento */
  /* ... más variables */
}
```

### Agregar nuevas funciones
1. Agregar método en SDK (`src/core/ClaudeOrka.ts`)
2. Agregar handler IPC (`electron/main/ipc-handlers.ts`)
3. Exponer en preload (`electron/preload/preload.ts`)
4. Llamar desde UI (`electron/renderer/app.js`)

## Debugging

### DevTools
```bash
npm run electron:dev
```

Los DevTools se abren automáticamente en modo desarrollo.

### Logs
Los logs del proceso principal se muestran en la terminal donde ejecutaste `npm run electron`.

Los logs del renderer se ven en DevTools (Console).

## Troubleshooting

### "tmux is not available"
Instala tmux:
```bash
brew install tmux  # macOS
```

### "Failed to open terminal window"
- En macOS: Asegúrate de dar permisos a Terminal.app
- En Linux: Instala `gnome-terminal` o `xterm`

### La app no muestra sesiones
- Verifica que el directorio seleccionado sea correcto
- Revisa `.claude-orka/state.json` en tu proyecto
- Comprueba los logs en la terminal

---

**¿Dudas?** Revisa el README principal del proyecto.
