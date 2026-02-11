# Master Agents - Sistema de Agentes Autonomos para Claude Code

## Que es un Master Agent

Un Master Agent es un **humano virtual** que se sienta frente a una sesion de Claude Code y la opera de forma autonoma. Igual que un desarrollador humano escribiria instrucciones, aprobaria permisos, responderia preguntas y guiaria el trabajo, el agente hace exactamente eso: observa el terminal, entiende lo que esta pasando, decide que hacer y ejecuta la accion.

La idea fundamental es simple: Claude Code ya es capaz de hacer trabajo complejo de software, pero necesita un humano que lo guie, apruebe permisos y le de instrucciones. El Master Agent reemplaza a ese humano para flujos de trabajo que pueden ser automatizados.

---

## Por que existe esto

### El problema

Claude Code es increiblemente capaz, pero tiene limitaciones operativas:

1. **Se detiene y espera input**: Cada vez que termina una tarea, necesita que alguien le diga que hacer despues.
2. **Pide permisos constantemente**: Editar archivos, ejecutar comandos, crear archivos - cada accion requiere aprobacion.
3. **No tiene autonomia continua**: No puede ejecutar un flujo de trabajo de 10 pasos sin intervencion humana en cada paso.
4. **Se pierde sin contexto**: Despues de `/compact` o `/clear`, necesita que alguien le recuerde donde iba.

### La solucion

El Master Agent convierte a Claude Code en un worker autonomo. Le das un objetivo ("implementa el sistema de autenticacion siguiendo estos pasos...") y el agente se encarga de:

- Guiar a Claude paso a paso a traves del flujo de trabajo
- Aprobar permisos automaticamente cuando es seguro
- Responder preguntas que Claude haga durante el trabajo
- Detectar errores y pedir que los corrija
- Escalar al humano real solo cuando realmente se queda atascado

### Casos de uso reales

- **Desarrollo autonomo**: "Implementa estas 5 features en orden, corre los tests despues de cada una"
- **CI/CD asistido**: "Ejecuta el pipeline de deploy, aprueba los pasos, reporta si algo falla"
- **Mantenimiento nocturno**: "Actualiza las dependencias, corre los tests, haz commit si todo pasa"
- **Code review automatizado**: "Revisa los PRs abiertos, deja comentarios con sugerencias"
- **Pair programming autonomo**: "Trabaja en el feature X mientras yo trabajo en el feature Y"

---

## Como funciona - Arquitectura

### Vista general

```
                    Claude Code (en tmux)
                         |
                    [Hook events]
                         |
                         v
+------------------+    HTTP POST     +------------------+
|  .claude/        | ──────────────>  |   Hook Server    |
|  settings.json   |   curl + stdin   |   (port 9999)    |
|  (hooks config)  |                  +--------+---------+
+------------------+                           |
                                               v
                                    +----------+---------+
                                    |   Agent Manager    |
                                    |  (orquestador)     |
                                    +----------+---------+
                                               |
                                    +----------+---------+
                                    |   Agent Daemon     |
                                    |  (ciclo de accion) |
                                    +----------+---------+
                                               |
                              +----------------+----------------+
                              |                |                |
                              v                v                v
                       Terminal          Claude Haiku       Terminal
                       Reader            (analisis)         Writer
                       (captura)         (decision)         (ejecucion)
```

### El ciclo de accion

Cada vez que Claude Code se detiene (o cualquier hook event configurado), el agente ejecuta un ciclo completo:

```
1. HOOK RECEIVED      → Claude Code disparo un evento (Stop, Notification, etc.)
2. TERMINAL CAPTURE   → Leer las ultimas 500 lineas del terminal
3. STATE ANALYSIS     → Parsear: esta esperando input? hay error? pide permiso?
4. LLM REQUEST        → Enviar contexto a Claude Haiku con el prompt maestro
5. LLM RESPONSE       → Recibir la decision: que accion tomar y por que
6. DECISION           → Evaluar confianza, verificar limites
7. EXECUTION          → Enviar la accion al terminal (texto, 'y', 'n', escape, etc.)
8. CYCLE DONE         → Registrar resultado, esperar siguiente evento
```

Cada ciclo genera un `cycleId` unico que agrupa todos los logs, permitiendo trazabilidad completa de cada accion del agente.

---

## Componentes del sistema

### Agent Model (`src/models/Agent.ts`)

Define la estructura de datos de un agente:

| Campo | Descripcion |
|-------|-------------|
| `masterPrompt` | Objetivo y comportamiento del agente (markdown) |
| `hookEvents` | Eventos que activan al agente (Stop, Notification, PreCompact, etc.) |
| `autoApprove` | Auto-aprobar prompts de permisos simples |
| `maxConsecutiveResponses` | Limite de respuestas consecutivas antes de escalar |
| `decisionHistorySize` | Ventana de decisiones pasadas para contexto |
| `promptRoles` | Roles alternativos (diferentes estrategias de prompt) |
| `connection` | Proyecto, sesion y pane tmux al que esta conectado |

### AgentManager (`src/agent/AgentManager.ts`)

Orquestador central. Maneja:

- Ciclo de vida de agentes (crear, eliminar, iniciar, detener, pausar, reanudar)
- Servidor de hooks (inicio/parada)
- Ruteo de eventos a daemons
- Conexion/desconexion de agentes a proyectos
- Instalacion/desinstalacion de hooks en `.claude/settings.json`
- Sistema de logs estructurados con `cycleId`

### AgentDaemon (`src/agent/AgentDaemon.ts`)

Proceso individual por agente. Ejecuta el ciclo de accion completo:

- Pre-flight checks (cooldown de 3s, timeout de 2min, ya procesando?)
- Captura de terminal via tmux
- Analisis de estado (spinners, prompts de permisos, errores)
- Toma de decisiones (fast-path para permisos, LLM para todo lo demas)
- Ejecucion (enviar texto, aprobar, rechazar, compact, escape, pedir ayuda)
- Registro de historial de decisiones (ventana deslizante)

**Protecciones:**
- Minimo 3 segundos entre respuestas (evita loops)
- Timeout de 2 minutos para procesamiento (force-reset si se atasca)
- Maximo 10 waits consecutivos antes de escalar al humano
- Limite configurable de respuestas consecutivas

### ClaudeAnalyzer (`src/agent/ClaudeAnalyzer.ts`)

Motor de decision basado en Claude Haiku:

- Construye un system prompt que define al agente como "humano virtual"
- Incluye el `masterPrompt` del agente como objetivo
- Envia las ultimas 150 lineas del terminal como contexto
- Incluye historial de decisiones recientes para coherencia
- Parsea respuesta JSON: `{ action, response, reason, confidence, notifyHuman }`
- Captura metadata del LLM: modelo, latencia, longitudes de prompts, respuesta raw
- Timeout de 60 segundos para la llamada API
- Fallback a heuristicas si el LLM falla

### HookServer (`src/agent/HookServer.ts`)

Servidor Express que recibe hooks de Claude Code:

- Escucha en `http://localhost:9999`
- Recibe POST de curl commands generados por el HookConfigGenerator
- Parsea payloads (JSON o stdin raw)
- Normaliza tipos de eventos
- Despacha a handlers del AgentManager

### HookConfigGenerator (`src/agent/HookConfigGenerator.ts`)

Genera la configuracion de hooks en `.claude/settings.json`:

- Crea comandos curl que envian datos del hook al servidor
- Siempre incluye SessionStart (para tracking de sesiones despues de compact/clear)
- Merge con hooks existentes (no sobreescribe)
- Soporta instalacion y desinstalacion limpia

### TerminalReader (`src/agent/TerminalReader.ts`)

Interfaz de lectura/escritura del terminal tmux:

- **Lectura**: Captura contenido del pane (500 lineas)
- **Parsing**: Detecta spinners, prompts de permisos, errores, estado de espera
- **Escritura**: Envia texto, Enter, 'y', 'n', Escape, Ctrl+C, '/compact'

### NotificationService (`src/agent/NotificationService.ts`)

Envio de notificaciones cuando el agente necesita atencion:

- **Telegram**: Via bot token + chat ID
- **Web Push**: Via endpoint + claves p256dh/auth

---

## Flujo detallado: De hook a ejecucion

### 1. Claude Code dispara un hook

Claude Code tiene un sistema de hooks configurable. Cuando ocurre un evento (por ejemplo, Claude termina de responder), ejecuta los scripts configurados en `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST http://localhost:9999/api/hooks/agent-abc123 -H 'Content-Type: application/json' -d \"$(cat)\""
      }]
    }]
  }
}
```

Claude Code pasa el payload del evento via stdin al comando curl.

### 2. Hook Server recibe y procesa

El servidor HTTP recibe el POST, parsea el payload y crea un `ProcessedHookEvent`:

```typescript
{
  payload: {
    event_type: 'Stop',
    session_id: 'uuid-...',
    cwd: '/path/to/project',
    stop_data: { stop_hook_active: true }
  },
  agentId: 'agent-abc123',
  projectPath: '/path/to/project',
  receivedAt: '2025-02-11T...',
  status: 'pending'
}
```

### 3. AgentManager filtra y rutea

El manager aplica filtros antes de despachar:

1. **Filtro de tipo**: El evento debe estar en `agent.hookEvents`
2. **Filtro de sesion**: El `session_id` del hook debe coincidir con `agent.connection.claudeSessionId`
3. **Caso especial SessionStart**: Actualiza `claudeSessionId` si cambio (despues de compact/clear)

### 4. AgentDaemon ejecuta el ciclo

El daemon genera un `cycleId` unico y ejecuta todas las fases, registrando cada paso con logs estructurados:

**Fase 1 - Hook received**
```
phase: 'hook_received'
→ event_type, session_id, cwd, hook-specific data
```

**Fase 2 - Terminal capture**
```
phase: 'terminal_capture'
→ charCount, lineCount, snapshot (ultimas 20 lineas)
```

**Fase 3 - Terminal state**
```
phase: 'terminal_state'
→ isProcessing, isWaitingForInput, hasPermissionPrompt, hasError, errorText
```

Si Claude esta procesando (spinner visible), el agente espera sin interrumpir.

**Fase 4 - LLM analysis**

Si hay un fast-path disponible (permission prompt simple + autoApprove), se salta el LLM.

De lo contrario:

```
phase: 'llm_request'
→ model (haiku), systemPromptLength, userPromptLength

phase: 'llm_response'
→ latencyMs, rawResponse (truncado a 500 chars), parseSuccess
```

El LLM recibe:
- System prompt: identidad de "humano virtual" + masterPrompt + contexto del proyecto
- User prompt: tipo de evento + contexto del evento + historial de decisiones + ultimas 150 lineas del terminal

Y responde con JSON:
```json
{
  "action": "respond",
  "response": "great, now run the tests",
  "reason": "Claude finished implementing the feature, time to verify",
  "confidence": 0.85,
  "notifyHuman": false
}
```

**Fase 5 - Decision**
```
phase: 'decision'
→ action, reason, confidence, response, notifyHuman
```

Si la confianza es menor a 30%, escala al humano automaticamente.

**Fase 6 - Execution**
```
phase: 'execution'
→ action, response sent, result
```

Acciones posibles:

| Accion | Que hace |
|--------|----------|
| `respond` | Escribe un mensaje y presiona Enter |
| `approve` | Escribe 'y' y presiona Enter |
| `reject` | Escribe 'n' y presiona Enter |
| `wait` | No hace nada, espera el siguiente evento |
| `compact` | Envia '/compact' para comprimir contexto |
| `escape` | Presiona Escape para cancelar |
| `request_help` | Pausa el agente y notifica al humano |

**Fase 7 - Cycle done**
```
phase: 'cycle_done'
→ durationMs
```

---

## Sistema de logs y trazabilidad

### Logs estructurados con cycleId

Cada ciclo de accion genera un ID unico (`cycle-{nanoid}`). Todos los logs de ese ciclo comparten el mismo `cycleId`, permitiendo agruparlos en la UI:

```
cycleId: cycle-a1b2c3d4
├── [info]   📥 Hook: Stop                    (hook_received)
├── [info]   📸 Terminal captured (4521 chars)  (terminal_capture)
├── [info]   🔍 State: waiting for input       (terminal_state)
├── [info]   🤖 LLM request                    (llm_request)
├── [info]   🤖 LLM response (342ms)           (llm_response)
├── [action] 💭 Decision: respond (85%)         (decision)
├── [action] 🎯 Executing: respond              (execution)
└── [debug]  ✅ Cycle complete (1234ms)          (cycle_done)
```

### UI de logs agrupados

La modal de logs muestra los ciclos como tarjetas colapsables:

- **Header**: timestamp, tipo de evento, decision final + badge de confianza, duracion del ciclo
- **Body**: todos los logs del ciclo en orden cronologico, con iconos de fase
- **Borde izquierdo**: color segun la decision (verde para respond/approve, amarillo para wait, rojo para error/request_help, azul para compact/escape)
- Los logs sin `cycleId` (conexion, desconexion, etc.) se muestran como entradas individuales entre ciclos

---

## Configuracion de un agente

### Crear un agente

Un agente se crea con:

1. **Nombre**: Identificador amigable ("Deploy Bot", "Test Runner", etc.)
2. **Master Prompt**: Objetivo y comportamiento en markdown
3. **Hook Events**: Que eventos activan al agente
4. **Auto-approve**: Si aprueba permisos automaticamente
5. **Max consecutive responses**: Limite antes de escalar
6. **Decision history size**: Cuantas decisiones pasadas incluir como contexto

### Ejemplo de Master Prompt

```markdown
## Objetivo
Implementar el sistema de autenticacion del proyecto.

## Pasos
1. Crear el modelo de usuario con email y password hash
2. Implementar registro (POST /api/auth/register)
3. Implementar login (POST /api/auth/login) con JWT
4. Agregar middleware de autenticacion
5. Proteger las rutas que requieren auth
6. Correr los tests despues de cada paso

## Reglas
- Usa bcrypt para hash de passwords
- Usa jsonwebtoken para JWT
- Los tokens expiran en 24 horas
- Si algun test falla, arreglalo antes de continuar
- Cuando termines todos los pasos, haz commit y notificame
```

### Prompt Roles

Un agente puede tener multiples "roles" - diferentes estrategias de prompt que se pueden activar sin recrear el agente:

- **Workflow Guide**: Guia paso a paso de un flujo de trabajo
- **Code Reviewer**: Revisa codigo y da feedback
- **Deployment**: Ejecuta y monitorea deploys
- **Debug Mode**: Modo investigacion para bugs complejos

### Conectar a un proyecto

El agente se conecta a:
- Un **proyecto** (path al directorio)
- Una **sesion de Orka** (opcional, para tracking)
- Un **pane de tmux** (el terminal donde corre Claude Code)
- Un **branch** (main o un fork especifico)

Al conectar, se instalan los hooks en `.claude/settings.json` del proyecto y se reinicia la sesion de Claude Code para que los cargue.

---

## Manejo de sesiones y recuperacion

### Tracking de session_id

Claude Code asigna un `session_id` unico a cada sesion. Despues de `/compact` o `/clear`, puede cambiar el `session_id`. El agente detecta esto via el evento `SessionStart` y actualiza automaticamente su `claudeSessionId` para que los eventos siguientes no sean filtrados.

### Despues de compact/clear

Cuando se detecta compact o clear:
1. Se actualiza el `claudeSessionId`
2. Se resetea el historial de decisiones (el contexto de Claude fue borrado)
3. Se resetea el contador de waits consecutivos
4. El siguiente evento Stop activa un ciclo normal donde el agente evalua la situacion fresca

---

## Limites y protecciones

| Proteccion | Valor | Proposito |
|------------|-------|-----------|
| Cooldown entre respuestas | 3 segundos | Evitar loops de respuesta rapida |
| Timeout de procesamiento | 2 minutos | Force-reset si el ciclo se atasca |
| Max waits consecutivos | 10 | Escalar si el agente no progresa |
| Max respuestas consecutivas | Configurable (default 5) | Evitar que el agente opere indefinidamente sin supervision |
| Confianza minima | 30% | Escalar si el LLM no esta seguro |
| Timeout de LLM | 60 segundos | No bloquear si la API no responde |

---

## Estado actual del sistema

### Que funciona hoy

- Creacion, configuracion y eliminacion de agentes via UI y API
- Conexion de agentes a proyectos con instalacion automatica de hooks
- Recepcion y procesamiento de hook events (Stop, SessionStart, PreCompact, Notification)
- Captura de terminal y analisis de estado
- Toma de decisiones via Claude Haiku con system prompt conversacional
- Ejecucion de acciones: respond, approve, reject, wait, compact, escape, request_help
- Historial de decisiones como contexto para coherencia
- Prompt roles intercambiables
- Notificaciones via Telegram
- Logs estructurados agrupados por ciclo con trazabilidad completa
- UI con vista de canvas (ReactFlow), logs modal, configuracion modal
- Mejora de prompts asistida por IA
- Tracking automatico de session_id despues de compact/clear
- Manual trigger para forzar un ciclo de analisis

### Limitaciones actuales

- **Un modelo fijo para analisis**: Siempre usa Claude Haiku. No hay opcion de usar Sonnet para decisiones mas complejas.
- **Sin memoria persistente**: El agente no recuerda entre reinicios del daemon (solo tiene el historial de decisiones en memoria, configurable en tamano).
- **Sin herramientas MCP activas**: La infraestructura para herramientas MCP existe (`src/agent/mcp/`) pero no hay herramientas implementadas. El agente solo puede interactuar via el terminal.
- **Polling en la UI**: La UI consulta el API cada 2 segundos en lugar de usar WebSockets para actualizaciones en tiempo real.
- **Sin metricas agregadas**: No hay dashboard de metricas (tasa de exito, tiempo promedio de ciclo, distribucion de acciones, etc.).
- **Single-pane monitoring**: Un agente solo puede monitorear un pane/branch a la vez.
