# Claude-Orka CLI

Command-line interface para orquestar sesiones de Claude Code con tmux y gestión de forks.

## Instalación

### Desarrollo Local

```bash
# Desde el directorio del proyecto
npm install
npm link

# Ahora puedes usar el comando `orka` globalmente
orka --help
```

### Desinstalación

```bash
npm unlink -g claude-orka
```

## Comandos Disponibles

### `orka init`

Inicializa Claude-Orka en el proyecto actual.

```bash
orka init
```

Esto crea la estructura `.claude-orka/` con:
- `state.json` - Estado del proyecto
- `exports/` - Exports de forks (se crea automáticamente cuando se necesita)

---

### `orka status`

Muestra el estado completo del proyecto.

```bash
# Vista formateada
orka status

# Salida JSON
orka status --json
```

Muestra:
- Total de sesiones (activas/guardadas)
- Detalle de cada sesión
- Forks por sesión
- Claude Session IDs para restauración

---

## Gestión de Sesiones

### `orka session create [name]`

Crea una nueva sesión de Claude.

```bash
# Con nombre personalizado
orka session create "My Feature"

# Sin nombre (genera automáticamente)
orka session create

# Sin abrir terminal
orka session create "My Feature" --no-terminal
```

**Resultado:**
- Crea sesión de tmux
- Inicia Claude con un session ID único
- Abre ventana de terminal (si --terminal=true)

### `orka session list`

Lista todas las sesiones.

```bash
# Todas las sesiones
orka session list

# Solo activas
orka session list --status active

# Solo guardadas
orka session list --status saved

# Salida JSON
orka session list --json
```

### `orka session get <session-id>`

Obtiene detalles de una sesión específica.

```bash
orka session get abc12345-...

# Salida JSON
orka session get abc12345-... --json
```

### `orka session resume <session-id>`

Restaura una sesión guardada.

```bash
orka session resume abc12345-...

# Sin abrir terminal
orka session resume abc12345-... --no-terminal
```

**Comportamiento:**
- Restaura el main con `claude --resume <session-id>`
- **Automáticamente** restaura todos los forks guardados
- Claude recuerda el contexto de todas las conversaciones

### `orka session close <session-id>`

Cierra una sesión (la guarda para restaurarla después).

```bash
orka session close abc12345-...
```

**Resultado:**
- Mata la sesión de tmux
- Marca sesión como "saved"
- Claude Session ID se conserva para restauración

### `orka session delete <session-id>`

Elimina permanentemente una sesión.

```bash
orka session delete abc12345-...
```

⚠️ **ADVERTENCIA:** Esta acción es irreversible.

---

## Gestión de Forks

### `orka fork create <session-id> [name]`

Crea un fork en una sesión activa.

```bash
# Fork horizontal
orka fork create abc12345-... "Explore Alternative"

# Fork vertical
orka fork create abc12345-... "Another Approach" --vertical

# Sin nombre (genera automáticamente)
orka fork create abc12345-...
```

**Proceso:**
1. Crea split en tmux
2. Ejecuta `claude --resume <parent-session> --fork-session`
3. Detecta automáticamente el fork session ID del history
4. Guarda fork en el state

### `orka fork list <session-id>`

Lista todos los forks de una sesión.

```bash
# Todos los forks
orka fork list abc12345-...

# Solo activos
orka fork list abc12345-... --status active

# Solo guardados
orka fork list abc12345-... --status saved

# Solo mergeados
orka fork list abc12345-... --status merged

# Salida JSON
orka fork list abc12345-... --json
```

### `orka fork resume <session-id> <fork-id>`

Restaura un fork guardado.

```bash
orka fork resume abc12345-... def45678-...
```

**Nota:** No es necesario llamar este comando manualmente si usas `orka session resume`, ya que los forks se restauran automáticamente.

### `orka fork close <session-id> <fork-id>`

Cierra un fork (lo guarda para después).

```bash
orka fork close abc12345-... def45678-...
```

### `orka fork delete <session-id> <fork-id>`

Elimina permanentemente un fork.

```bash
orka fork delete abc12345-... def45678-...
```

---

## Export y Merge

### `orka merge export <session-id> <fork-id>`

Genera un export summary del fork (paso manual).

```bash
orka merge export abc12345-... def45678-...
```

**Proceso:**
1. Envía un prompt a Claude en el fork
2. Claude genera un resumen ejecutivo de la conversación
3. Claude guarda el resumen en `.claude-orka/exports/`

**Importante:** Espera 15-30 segundos para que Claude complete antes de hacer merge.

### `orka merge do <session-id> <fork-id>`

Hace merge del fork al main (requiere export primero).

```bash
orka merge do abc12345-... def45678-...
```

**Proceso:**
1. Lee el export generado
2. Envía el contexto al main
3. Cierra el fork
4. Marca fork como "merged"

### `orka merge auto <session-id> <fork-id>`

Genera export y hace merge automáticamente (recomendado).

```bash
# Con tiempo de espera por defecto (15 segundos)
orka merge auto abc12345-... def45678-...

# Con tiempo personalizado (20 segundos)
orka merge auto abc12345-... def45678-... --wait 20000
```

**Proceso:**
1. Genera export (envía prompt a Claude)
2. Espera el tiempo especificado
3. Hace merge automáticamente

---

## Flujos de Trabajo Completos

### Flujo 1: Explorar alternativa y hacer merge

```bash
# 1. Crear sesión
orka session create "Implement Feature X"
# Output: Session ID: abc12345-...

# 2. Trabajar en el main...

# 3. Crear fork para explorar alternativa
orka fork create abc12345-... "Try Approach Y"
# Output: Fork ID: def45678-...

# 4. Trabajar en el fork...

# 5. Merge automático
orka merge auto abc12345-... def45678-...

# 6. Ver estado final
orka status
```

### Flujo 2: Guardar y restaurar sesión con forks

```bash
# 1. Crear sesión y fork
orka session create "My Work"
orka fork create abc12345-... "Alternative"

# 2. Trabajar en ambos...

# 3. Cerrar todo (sin merge)
orka session close abc12345-...

# 4. Más tarde... restaurar todo
orka session resume abc12345-...
# ✅ Main y fork se restauran automáticamente!
```

### Flujo 3: Explorar múltiples alternativas

```bash
# 1. Crear sesión
orka session create "Complex Feature"

# 2. Crear múltiples forks
orka fork create abc12345-... "Approach A"
orka fork create abc12345-... "Approach B"
orka fork create abc12345-... "Approach C"

# 3. Ver todos
orka fork list abc12345-...

# 4. Merge el mejor
orka merge auto abc12345-... <fork-id-winner>

# 5. Eliminar los demás
orka fork delete abc12345-... <fork-id-loser-1>
orka fork delete abc12345-... <fork-id-loser-2>
```

---

## Tips y Mejores Prácticas

### 1. Nombres Descriptivos

```bash
# ✅ Bueno
orka session create "Implement OAuth Authentication"
orka fork create abc-... "Try JWT instead of sessions"

# ❌ Evitar
orka session create "test"
orka fork create abc-... "fork1"
```

### 2. Usar `status` Frecuentemente

```bash
# Ver estado antes de operaciones importantes
orka status

# Ver sesión específica
orka session get abc12345-...
```

### 3. Merge Automático es Preferible

```bash
# ✅ Recomendado
orka merge auto abc-... def-...

# ⚠️ Manual (más propenso a errores)
orka merge export abc-... def-...
# ... esperar ...
orka merge do abc-... def-...
```

### 4. Los Forks se Restauran Automáticamente

```bash
# ✅ Suficiente - restaura todo
orka session resume abc-...

# ❌ Innecesario - los forks ya se restauran
orka session resume abc-...
orka fork resume abc-... def-...  # No es necesario!
```

### 5. Limpieza Regular

```bash
# Eliminar sesiones viejas
orka session delete <old-session-id>

# O listar primero para decidir
orka session list
```

---

## Troubleshooting

### CLI no disponible globalmente

```bash
npm link
```

### Tmux no está instalado

```bash
# macOS
brew install tmux

# Linux
sudo apt-get install tmux
```

### Claude no está instalado

Sigue las instrucciones en: https://claude.com/claude-code

### Error: "Project not initialized"

```bash
orka init
```

### Los forks no se detectan

Verifica que:
- El fork se creó correctamente en tmux
- El mensaje inicial se envió a Claude
- El session ID se guardó en `~/.claude/history.jsonl`

---

## Estructura de Archivos

```
.claude-orka/
├── state.json          # Estado del proyecto
└── exports/            # Exports de forks (creado on-demand)
    └── fork-*.md       # Resúmenes generados por Claude
```

### state.json

```json
{
  "projectPath": "/path/to/project",
  "sessions": [
    {
      "id": "abc12345-...",
      "name": "My Session",
      "status": "active",
      "main": {
        "claudeSessionId": "xyz789-...",
        "tmuxPaneId": "%0"
      },
      "forks": [
        {
          "id": "def45678-...",
          "name": "My Fork",
          "claudeSessionId": "uvw456-...",
          "status": "merged",
          "contextPath": ".claude-orka/exports/fork-my-fork-2025-11-19.md"
        }
      ]
    }
  ]
}
```

---

## Desarrollo

### Ejecutar sin instalar

```bash
# Usando npm script
npm run orka -- --help

# Usando tsx directamente
npx tsx src/cli/index.ts --help
```

### Debugging

Establece el nivel de log en `src/utils/logger.ts`:

```typescript
logger.setLevel(LogLevel.DEBUG)
```

---

## Próximas Funcionalidades

- [ ] `orka export` - Exportar sesión completa
- [ ] `orka import` - Importar sesión
- [ ] `orka config` - Configuración global
- [ ] `orka template` - Templates de sesiones
- [ ] `orka history` - Ver historial de comandos

---

## Licencia

MIT
