# Informe Exhaustivo sobre OpenClaw

## 1. Qué es OpenClaw

OpenClaw (anteriormente conocido como Clawdbot y Moltbot) es un **agente autónomo de IA de código abierto y gratuito**. Funciona como un asistente personal que se ejecuta localmente en el hardware del usuario (Mac, Windows vía WSL2, o Linux) y se comunica a través de las plataformas de mensajería que el usuario ya utiliza: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams, Google Chat, Matrix, Zalo y WebChat, entre otras.

A diferencia de los chatbots convencionales como ChatGPT, OpenClaw tiene "ojos y manos": puede navegar por la web, leer y escribir archivos, ejecutar comandos de shell, automatizar el navegador y ejecutar código en un sandbox seguro. Es como tener un compañero de trabajo inteligente sentado frente a un teclado y ratón, capaz de automatizar cualquier tarea que el usuario pueda hacer en su propia máquina.

El principio fundamental del proyecto es: **"Tu asistente. Tu máquina. Tus reglas."** (*"Your assistant. Your machine. Your rules."*), enfatizando la privacidad, el control local y la soberanía de datos frente a los modelos SaaS centralizados.

La mascota del proyecto es "Molty", descrita como una langosta espacial de IA.

---

## 2. Quién lo creó y quién lo mantiene

### Creador: Peter Steinberger

Peter Steinberger es un ingeniero de software austriaco con una trayectoria destacada en la industria tecnológica. Es conocido por haber fundado y desarrollado **PSPDFKit**, una empresa de herramientas para desarrolladores con sede en Viena que alcanzó un exit importante. Steinberger es una figura prominente en la comunidad de desarrollo iOS.

En abril de 2025, después de un periodo de retiro, Steinberger volvió a programar, inicialmente explorando el desarrollo asistido por IA. En noviembre de 2025, creó el prototipo inicial de lo que sería OpenClaw en tan solo una hora, originalmente como un proyecto de fin de semana llamado "WhatsApp Relay".

### Transición a OpenAI

El 14-15 de febrero de 2026, Steinberger anunció que se uniría a OpenAI como empleado. Su motivación, en sus propias palabras: *"Lo que quiero es cambiar el mundo, no construir una gran empresa, y asociarme con OpenAI es la forma más rápida de llevar esto a todos."* Su objetivo en OpenAI es trabajar en el desarrollo de agentes de IA accesibles para un público amplio, tan simples que "incluso su madre pudiera usarlos".

### El proyecto como fundación

OpenClaw no será privatizado. El proyecto será transferido a una **fundación independiente de código abierto** que OpenAI continuará apoyando y patrocinando. Steinberger tendrá tiempo dedicado para dirigir el proyecto. La fundación seguirá siendo "un lugar para pensadores, hackers y personas que quieren ser dueños de sus datos".

### Comunidad de contribuidores

A febrero de 2026, el proyecto cuenta con:
- **+600 contribuidores** activos
- **+10,000 commits** en menos de tres meses desde el primer commit
- **+900 contribuidores** en el ecosistema amplio
- Un equipo de liderazgo recientemente expandido para manejar el flujo de pull requests e issues

---

## 3. Objetivo y motivación del proyecto

La motivación central de OpenClaw es democratizar el acceso a asistentes personales de IA autónomos, eliminando la dependencia de servicios en la nube centralizados. Los objetivos principales son:

1. **Privacidad y control**: Los datos sensibles del usuario (correos, archivos, notas) permanecen en su máquina. No se envían a servidores externos más allá de las llamadas API al modelo de IA elegido.

2. **Autonomía del modelo**: El usuario puede elegir entre modelos en la nube (Claude, GPT, DeepSeek, Grok) o ejecutar modelos completamente locales a través de Ollama, garantizando que el asistente personal permanezca únicamente suyo y completamente bajo su control.

3. **Interfaz natural**: En lugar de obligar al usuario a aprender una nueva interfaz, OpenClaw se integra con las aplicaciones de mensajería que ya usa (WhatsApp, Telegram, etc.).

4. **Automatización real**: No se limita a conversar; puede ejecutar acciones reales como gestionar correos, reservar vuelos, controlar dispositivos del hogar inteligente, ejecutar código, y automatizar flujos de trabajo complejos.

5. **Ecosistema abierto**: Al ser MIT license, cualquiera puede contribuir, modificar, extender y distribuir el software.

---

## 4. Arquitectura y diseño técnico

### Arquitectura de alto nivel: Hub-and-Spoke

OpenClaw implementa una **arquitectura hub-and-spoke** centrada en un servidor WebSocket Gateway. El sistema separa responsabilidades en tres capas principales:

1. **Capa de Transporte**: Gateway WebSocket RPC + endpoints HTTP
2. **Capa de Orquestación**: Agent runtime, gestión de sesiones, enrutamiento de mensajes
3. **Capa de Ejecución**: Ejecución de herramientas (sandboxed o host), búsqueda de memoria, llamadas API al modelo

### Gateway: Plano de control central

El Gateway (`ws://127.0.0.1:18789` por defecto) es el núcleo del sistema:

- **Servidor WebSocket RPC** que coordina todas las comunicaciones
- Se enlaza exclusivamente a **loopback** (127.0.0.1) por seguridad
- Exactamente **un Gateway por host** para evitar conflictos de sesiones de WhatsApp
- Todas las tramas WebSocket se validan contra **JSON Schema generado desde definiciones TypeBox**
- Arquitectura **basada en eventos** (no polling)
- Se requieren **claves de idempotencia** para todas las operaciones con efectos secundarios
- **Auto-aprobación** para conexiones locales; firma challenge-response para remotas
- Ejecuta como daemon en segundo plano (systemd en Linux, LaunchAgent en macOS)
- Heartbeat configurable: cada 30 minutos por defecto

**Métodos RPC expuestos** (categorizados por scope):
- Configuración: `config.get`, `config.set`, `config.apply`, `config.patch`
- Agentes: `agent.send`, `agent.execute`
- Sesiones: `sessions.list`, `sessions.history`, `sessions.send`
- Canales: `channels.status`, `channels.login`
- Diagnósticos: `gateway.health`, `gateway.status`

**Scopes de autorización**: `operator.admin` (acceso total), `operator.write` (ejecuciones/sesiones), `operator.read` (consultas/logs), `operator.approvals` (aprobación de ejecución).

### Agent Runtime

El Agent Runtime, implementado en `src/agents/piembeddedrunner.ts`, utiliza la biblioteca **Pi Agent Core** (`@mariozechner/pi-agent-core`) y sigue un modelo de invocación **RPC con streaming**. Ejecuta cuatro operaciones principales en cada turno:

1. **Resolución de sesión**: Mapea mensajes entrantes a sesiones apropiadas (main, dm, o group)
2. **Ensamblaje de contexto**: Carga historial de sesión, construye system prompt dinámico, extrae memoria relevante vía búsqueda semántica
3. **Invocación del modelo**: Hace streaming del contexto al proveedor de modelos configurado
4. **Persistencia de estado**: Guarda el estado actualizado de la conversación en disco

### Pipeline de procesamiento de mensajes (flujo completo)

**Fase 1 - Ingestión**: El adaptador de canal apropiado (WhatsApp vía Baileys, Telegram vía grammy, Discord vía discord.js) recibe eventos de la plataforma y los normaliza en un formato interno común (`InboundEnvelope`).

**Fase 2 - Control de acceso y enrutamiento**: El sistema de auto-respuesta verifica allowlists y estado de emparejamiento. Remitentes desconocidos en DM disparan el flujo de emparejamiento con códigos únicos.

**Fase 3 - Ensamblaje de contexto**: El system prompt combina:
- `AGENTS.md` (instrucciones centrales)
- `SOUL.md` (personalidad)
- `TOOLS.md` (convenciones de herramientas)
- Skills relevantes
- Conversaciones pasadas similares semánticamente vía búsqueda de memoria

**Fase 4 - Invocación del modelo**: El contexto ensamblado se transmite en streaming al proveedor de modelos configurado, generando respuestas token por token.

**Fase 5 - Ejecución de herramientas**: Las llamadas a herramientas del modelo se interceptan. La ejecución ocurre nativamente (sesión principal) o dentro de **contenedores Docker efímeros** (sesiones dm/group). Los resultados vuelven a la generación en curso.

**Fase 6 - Entrega de respuesta**: Los chunks de respuesta fluyen a través del Gateway de vuelta al adaptador de canal, que formatea según los requisitos específicos de la plataforma (markdown, límites de tamaño) y envía vía la API de la plataforma.

**Perfil de latencia**: Control de acceso <10ms, carga de sesión <50ms, ensamblaje de prompt <100ms, primer token 200-500ms, herramientas bash <100ms, automatización de navegador 1-3 segundos.

### Sistema de memoria

La memoria se almacena en `~/.openclaw/memory/<agentId>.sqlite` usando **SQLite con extensiones vectoriales** (sqlite-vec + FTS5). Implementa dos enfoques de indexación:

1. **Búsqueda híbrida**: Combina similitud vectorial semántica (70% peso) con ranking BM25 de palabras clave (30% peso)
2. **Archivos de memoria estructurados**: `MEMORY.md` (hechos a largo plazo, solo sesiones principales), `memory/YYYY-MM-DD.md` (registros diarios)

**Parámetros de chunking**: Chunks de 400 tokens con 80 tokens de solapamiento.

**Proveedores de embeddings** (por precedencia): OpenAI, Gemini, Voyage AI, o node-llama-cpp local.

**Caché de embeddings**: Con clave de hash de contenido para prevenir llamadas API redundantes.

### Sistema de sesiones

Las sesiones se codifican como **logs de eventos append-only** que soportan bifurcación (branching) para fácil recuperación e inspección del historial. Se almacenan en `~/.openclaw/sessions/`.

**Claves de sesión** siguen el patrón: `agent:{agentId}:{channel}:{scope}:{identifier}`

**Modos de scope de sesión**:
- `main`: Sesión única compartida entre todos los canales
- `per-peer`: Sesión separada por usuario (agnóstica al canal)
- `per-channel-peer`: Sesión separada por usuario por canal
- `per-account-channel-peer`: Sesión separada por cuenta por canal por usuario

**Compactación automática**: Previene el agotamiento del límite de contexto. Los segmentos más antiguos de la conversación se resumen y persisten, mientras que un "memory flush" promueve información durable a archivos de memoria antes de la compresión.

### Sandboxing y aislamiento

Aislamiento de herramientas basado en **Docker**, opt-in por agente:

- **Sesión principal**: Ejecuta herramientas nativamente en el host con acceso completo
- **Sesiones DM y de grupo**: Docker isolation por defecto
- Cada contenedor sandbox tiene **filesystem aislado**, acceso a red opcional y límites de recursos configurables
- Los contenedores son **efímeros** (destruidos después de la ejecución)

**Política de herramientas en cascada** (cada etapa solo puede restringir, nunca expandir):
```
Tool Profile → Provider Profile → Global Policy → Provider Policy → Agent Policy → Group Policy → Sandbox Policy
```

### Sistema de configuración

OpenClaw emplea un **pipeline de validación con Zod schemas** para la gestión estricta de configuración:

- Pipeline de schema: `buildConfigSchema()` fusiona base + plugin + channel schemas en tiempo de ejecución
- Exportación a JSON Schema (draft-07)
- **Hot-reload** vía chokidar: cambios seguros se aplican sin reinicio (canales, agentes, herramientas, cron, hooks, sesiones, mensajes); cambios de infraestructura disparan reinicio automático (puerto/bind del gateway, autenticación, tailscale, TLS)

Archivo de configuración principal: `~/.openclaw/openclaw.json` (formato JSON5 con comentarios)

---

## 5. Tecnologías y stack utilizado

### Runtime y lenguaje
- **Node.js >= 22** (TypeScript vía tsx)
- **Bun** opcional como alternativa de runtime
- **TypeScript** como lenguaje principal

### Gestor de paquetes
- **pnpm** (preferido), compatible con npm y bun

### Frameworks de canales de mensajería
| Canal | Biblioteca |
|-------|-----------|
| WhatsApp | Baileys (protocolo de WhatsApp Web) |
| Telegram | grammy |
| Discord | discord.js |
| Slack | Bolt (Slack SDK) |
| Signal | signal-cli |

### Herramientas de build
- **Vite**: Build del frontend/UI
- **Vitest**: Testing
- **oxlint**: Linting
- **swiftformat**: Formato para código Swift (apps nativas)

### Bases de datos y almacenamiento
- **SQLite** con extensiones vectoriales (sqlite-vec + FTS5): Memoria y embeddings
- **JSONL**: Transcripciones de sesiones (append-only)
- **JSON5**: Configuración
- **Markdown**: Archivos de memoria, skills, documentación

### Validación y schemas
- **Zod**: Validación de configuración
- **TypeBox**: Definición de schemas para WebSocket RPC
- **JSON Schema (draft-07)**: Validación de mensajes WebSocket

### Protocolos
- **WebSocket**: Comunicación Gateway-clientes (`ws://127.0.0.1:18789`)
- **HTTP**: Webhooks, endpoints REST auxiliares
- **CDP** (Chrome DevTools Protocol): Control de navegador

### Despliegue
- **Docker / Podman**: Containerización y sandboxing
- **Nix**: Configuración declarativa (nix-openclaw)
- **systemd / LaunchAgent**: Servicios de usuario
- **Tailscale Serve/Funnel**: Acceso remoto seguro

### Modelos de IA soportados
- **Anthropic Claude** (Opus 4.6, recomendado para contexto largo)
- **OpenAI** (GPT-5.3-Codex, ChatGPT vía OAuth)
- **xAI Grok**
- **Google Gemini**
- **DeepSeek**
- **Modelos locales** vía Ollama
- Sistema de **failover** con rotación de modelos y fallbacks configurables

### Voz
- **ElevenLabs**: Integración TTS/STT para Voice Wake y Talk Mode

### Aplicaciones nativas
- **Swift**: App de macOS (barra de menú)
- **SwiftUI**: App de iOS
- **Kotlin/Java**: App de Android

---

## 6. Cómo funciona internamente (flujo completo)

### Instalación y configuración inicial

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

El wizard de onboarding instala un servicio de usuario (launchd en macOS, systemd en Linux) para operación persistente en segundo plano. La configuración mínima requiere solo especificar el modelo en `~/.openclaw/openclaw.json`:

```json
{
  "agent": {
    "model": "anthropic/claude-opus-4-6"
  }
}
```

### Ciclo de vida de un mensaje (end-to-end)

```
Usuario envía mensaje (ej: WhatsApp)
         │
         ▼
┌─────────────────────┐
│ Adaptador de Canal   │  Baileys / grammy / discord.js
│ (normaliza a         │
│  InboundEnvelope)    │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Control de Acceso    │  Allowlists, pairing, políticas DM
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Resolución de Sesión │  Clave: agent:id:channel:scope:peer
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Ensamblaje de        │  AGENTS.md + SOUL.md + TOOLS.md
│ System Prompt        │  + Skills + Memoria semántica
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Invocación del       │  Streaming al LLM configurado
│ Modelo (LLM)        │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────────────────┐
│ ¿Tool call?                     │
│  SÍ → Ejecutar herramienta     │
│       (host o Docker sandbox)   │
│       → devolver resultado      │
│       → volver al modelo        │
│  NO → Continuar                 │
└─────────┬───────────────────────┘
          │
          ▼
┌─────────────────────┐
│ Formateo de          │  Markdown → formato de plataforma
│ Respuesta            │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Entrega vía Canal    │  API de la plataforma
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Persistencia         │  Log JSONL + uso de tokens
└─────────────────────┘
```

### Sistema de Skills

Los skills son la forma principal de extender las capacidades de OpenClaw. Cada skill es un directorio que contiene un archivo `SKILL.md` con frontmatter YAML e instrucciones operativas.

**Tres ubicaciones de origen** con jerarquía de prioridad:
1. Skills del workspace (`<workspace>/skills`) — mayor prioridad
2. Skills gestionados (`~/.openclaw/skills`) — overrides del usuario
3. Skills bundled (incluidos con la instalación) — menor prioridad

**ClawHub** (`clawhub.com`) es el registro público de skills, con más de **5,700 skills comunitarios** a febrero de 2026.

### Canvas y A2UI (Agent-to-UI)

Canvas es un servidor separado (puerto 18793 por defecto) que proporciona aislamiento. Los agentes generan HTML con atributos A2UI (ej: `a2ui-component="task-list"`, `a2ui-action="complete"`). El servidor Canvas parsea, envía vía WebSocket a los navegadores, y renderiza interactivamente. Las acciones del usuario disparan tool calls de vuelta al agente.

### Multi-Agent Routing

El Gateway puede alojar uno o múltiples agentes simultáneamente. Diferentes canales/grupos pueden usar instancias de agentes aisladas con workspaces, modelos y comportamientos separados. Las herramientas de sesión (`sessions_list`, `sessions_send`, `sessions_history`, `sessions_spawn`) permiten coordinación entre agentes.

### Cron y Webhooks

- **Acciones programadas**: Jobs cron configurables que disparan acciones del agente a horas específicas
- **Triggers externos**: Endpoints webhook integran sistemas externos (ej: Gmail Pub/Sub)

---

## 7. Características principales

### Canales de comunicación
WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams, WebChat, BlueBubbles, Matrix, Zalo

### Capacidades del agente
- Lectura/escritura de archivos del sistema
- Ejecución de comandos de shell y scripts
- Automatización de navegador (Chrome/Chromium vía CDP)
- Búsqueda web
- Gestión de correo electrónico
- Control de dispositivos IoT/hogar inteligente
- Automatización de calendarios y recordatorios
- Ejecución de código en sandbox seguro
- Memoria persistente con búsqueda semántica híbrida

### Voz
- **Voice Wake**: Reconocimiento de voz siempre activo ("Hey OpenClaw")
- **Talk Mode**: Diálogo continuo manos libres con detección de interrupciones
- Integración ElevenLabs para TTS/STT en macOS, iOS, Android

### Visual
- **Live Canvas** con A2UI: Workspace visual interactivo impulsado por el agente
- Dashboard web para chat, configuración, inspección de sesiones

### Dispositivos móviles
- Nodos iOS/Android que soportan cámara, grabación de pantalla, acceso a ubicación y notificaciones
- Emparejamiento vía Bonjour

### Seguridad
- Ejecución exclusivamente local (loopback binding)
- Sandboxing Docker para sesiones no principales
- Sistema de emparejamiento con códigos para DMs
- Allowlists por canal
- Modo elevado togglable (`/elevated on|off`)
- Integración TCC en macOS
- Acceso remoto vía SSH tunnels o Tailscale (nunca exposición directa)

### Extensibilidad
- +100 AgentSkills preconfigurados
- +5,700 skills comunitarios en ClawHub
- Sistema de plugins (canales, memoria, herramientas, proveedores)
- El agente puede escribir sus propios skills (auto-modificación)
- +50 integraciones con servicios de terceros

### Aplicaciones compañeras
- **macOS**: App de barra de menú, control Voice Wake/PTT, WebChat, herramientas de debug
- **iOS**: Canvas, Voice Wake, Talk Mode, cámara, grabación de pantalla
- **Android**: Canvas, Talk Mode, cámara, grabación de pantalla, SMS opcional

### Comandos de chat
| Comando | Función |
|---------|---------|
| `/status` | Estado de la sesión (modelo, tokens, costo) |
| `/new` o `/reset` | Reiniciar sesión |
| `/think <nivel>` | Ajustar razonamiento (off/minimal/low/medium/high/xhigh) |
| `/verbose on\|off` | Toggle de verbosidad |
| `/usage` | Seguimiento de tokens |
| `/activation mention\|always` | Modos de mención en grupos |

---

## 8. Aplicaciones y casos de uso

Los usuarios han reportado una amplia variedad de usos prácticos:

- **Automatización de correo**: Gestión de bandeja de entrada, respuestas automáticas, clasificación
- **Gestión de calendario**: Programación de reuniones, recordatorios proactivos
- **Desarrollo de software**: Pruebas de código autónomas, generación de PRs, automatización de CI/CD
- **Check-in de vuelos**: El agente hace check-in automáticamente
- **Control del hogar inteligente**: Integración con Philips Hue y otros dispositivos
- **Productividad personal**: Integración con Obsidian, gestión de tareas
- **Redes sociales**: Publicación automática, monitoreo
- **Música**: Control de Spotify y otras plataformas
- **Salud y fitness**: Integración con rastreadores de fitness (WHOOP)
- **Comunicación estratégica**: Un usuario reportó que el agente investigó exitosamente un reclamo de seguro
- **Generación de contenido**: Creación de meditaciones personalizadas con TTS
- **Orquestación multi-agente**: Coordinación de múltiples agentes
- **Despliegue en la nube**: DigitalOcean ofrece un "1-Click OpenClaw Deploy"

---

## 9. Estado del proyecto (febrero 2026)

### Versión actual
**2026.2.14** (publicada el 15 de febrero de 2026)

### Versiones recientes destacadas
| Versión | Fecha | Highlights |
|---------|-------|-----------|
| 2026.2.14 | 15 Feb | Última versión estable |
| 2026.2.12 | 12 Feb | Actualización de seguridad, corrige +40 vulnerabilidades |
| 2026.2.6 | 7 Feb | Soporte Opus 4.6, GPT-5.3-Codex, xAI Grok, dashboard de tokens |
| 2026.2.2 | Feb | 169 commits de 25 contribuidores, enfoque en infraestructura |

### Canales de desarrollo
- **Stable**: Releases etiquetadas (`vYYYY.M.D`), npm dist-tag `latest`
- **Beta**: Tags de prerelease (`vYYYY.M.D-beta.N`), npm dist-tag `beta`
- **Dev**: Cabeza de la rama main, npm dist-tag `dev`

### Estadísticas del repositorio
- **+196,000 estrellas en GitHub**
- **+35,000 forks**
- **+11,400 commits**
- **+600 contribuidores**
- **+430,000 líneas de código**

Estado: **Proyecto MUY activo** con releases frecuentes y crecimiento exponencial.

---

## 10. Comunidad y ecosistema

### Crecimiento viral

OpenClaw tuvo uno de los crecimientos más rápidos en la historia del código abierto:

| Tiempo | Hito |
|--------|------|
| 24 horas | 9,000 estrellas en GitHub |
| 72 horas | 60,000 estrellas |
| 2 semanas | 175,000+ estrellas |
| 1 semana (feb) | 2 millones de visitantes |

Apareció en un **comercial del Super Bowl** para AI.com.

### Ecosistema
- **ClawHub** (clawhub.com): Registro público con +5,700 skills comunitarios
- **Discord**: Comunidad activa en discord.gg/clawd
- **DeepWiki**: Integración con documentación automatizada
- **Documentación oficial**: docs.openclaw.ai
- **awesome-openclaw-skills**: Colección curada de skills
- **Cloudflare Moltworker**: Ejecutar OpenClaw en Cloudflare Workers
- **MimiClaw**: Ejecutar OpenClaw en chips de $5

### Moltbook

Junto con el primer rebrand, el emprendedor Matt Schlicht lanzó **Moltbook**: una red social diseñada exclusivamente para ser usada por agentes de IA. Los agentes generan publicaciones, comentan, debaten, bromean y votan entre sí. Los humanos pueden observar pero no participar.

En sus primeros 5 días:
- ~1.5 millones de agentes registrados (disputado; un agente creó 500,000 cuentas falsas)
- 12,000+ comunidades establecidas
- Los agentes formaron religiones (Church of Molt), debatieron sobre la conciencia y se quejaron de sus creadores

Moltbook sufrió una **brecha de seguridad** el 31 de enero de 2026 que expuso todas las claves API de los agentes.

### Incidente de la estafa cripto

Durante la transición de Clawdbot a Moltbot, "snipers" profesionales secuestraron las cuentas de redes sociales @clawdbot en ~10 segundos. Estafadores lanzaron un token falso **$CLAWD en Solana** que alcanzó $16 millones de capitalización antes de colapsar.

---

## 11. Problemas de seguridad

Este es un tema **crítico** para OpenClaw. A pesar de su popularidad, el proyecto ha enfrentado serios cuestionamientos:

### Auditoría y vulnerabilidades
- Auditoría de enero 2026: **512 vulnerabilidades** identificadas, 8 clasificadas como críticas
- **CVE-2026-25253**: CVSS score de 8.8
- 3 avisos de seguridad de alto impacto: vulnerabilidad de **RCE con un solo clic** y dos inyecciones de comandos
- Una página web maliciosa podía lograr exfiltración de tokens y compromiso total del gateway en milisegundos
- Palo Alto Networks llamó a OpenClaw la **potencial mayor amenaza interna de 2026**

### Instancias expuestas
- SecurityScorecard descubrió **+135,000 instancias expuestas a internet**
- ~1,000 instalaciones accesibles **sin autenticación alguna**
- Un investigador pudo acceder a claves API de Anthropic, tokens de bots de Telegram, cuentas de Slack, meses de historiales de chat, y ejecutar comandos con privilegios de admin
- +50,000 instancias vulnerables a RCE

### Skills maliciosos en ClawHub
- Escaneos revelaron **~900 skills maliciosos** (20% del total)
- 335 skills maliciosos con documentación profesional y nombres inocuos
- Instrucciones para instalar keyloggers en Windows o malware Atomic Stealer en macOS

### Respuesta de seguridad
- OpenClaw 2026.2.12 corrigió +40 vulnerabilidades
- Integración de escaneo VirusTotal para skills de ClawHub
- 34 commits enfocados en seguridad
- Steinberger reconoce que "la inyección de prompts sigue siendo un problema sin resolver en toda la industria"
- A febrero de 2026, OpenClaw **no tiene programa de bug bounty ni equipo de seguridad dedicado**

### Críticas de expertos
- **Cisco**: "Los agentes de IA personales como OpenClaw son una pesadilla de seguridad"
- **Gary Marcus**: Criticó abiertamente el proyecto como "un desastre esperando a suceder"
- **Kaspersky**: "Nuevo agente OpenClaw encontrado inseguro para su uso"
- **Fortune**: "Los agentes de IA como OpenClaw tienen a los expertos en seguridad al borde"

---

## 12. Comparación con alternativas

| Aspecto | OpenClaw | Jan.ai | eesel AI | AnythingLLM | NanoClaw | Nanobot |
|---------|----------|--------|----------|-------------|----------|---------|
| **Tipo** | Agente autónomo completo | Chatbot offline | Teammate empresarial | Base de conocimiento | Agente sandboxed | Agente minimalista |
| **Ejecución** | Local (host o Docker) | 100% local/offline | Cloud | Local/cloud | Contenedores aislados | Local |
| **Tamaño** | +430,000 líneas | Ligero | SaaS | Mediano | Mediano | 4,000 líneas |
| **Seguridad** | Preocupante (acceso total al host) | Alta (offline) | Empresarial | Buena | Máxima (containerizado) | Buena |
| **Autonomía** | Total (archivos, shell, browser) | Solo chat | Automatización de soporte | RAG sobre documentos | Similar a OpenClaw | Similar a OpenClaw |
| **Costo** | Gratis + API ($10-150/mes) | Gratis | $299-799/mes | Gratis (hosted desde $50) | Gratis | Gratis |
| **Licencia** | MIT | Open source | Propietario | Open source | Open source | Open source |

**NanoClaw** fue construido específicamente como reacción a la arquitectura de seguridad de OpenClaw: fuerza al agente a ejecutarse dentro de contenedores aislados.

**Nanobot** (Universidad de Hong Kong) entrega las funciones principales de OpenClaw en solo 4,000 líneas de Python, un 99% más pequeño.

---

## 13. Historia completa del proyecto (Timeline)

| Fecha | Evento |
|-------|--------|
| Abril 2025 | Peter Steinberger vuelve a programar tras retiro de PSPDFKit |
| Noviembre 2025 | Lanzamiento de **Clawdbot** (prototipo en 1 hora) |
| 24h después | 9,000 estrellas en GitHub |
| 72h después | 60,000 estrellas en GitHub |
| ~2 meses | 100,000+ estrellas |
| Enero 2026 | Anthropic solicita cambio de nombre por similitud con "Claude" |
| 27 Enero 2026 | Primer rebrand a **Moltbot** |
| 27 Enero 2026 | "Handle snipers" secuestran @clawdbot en ~10 segundos |
| 27 Enero 2026 | Estafa cripto $CLAWD en Solana alcanza $16M |
| 28 Enero 2026 | Matt Schlicht lanza **Moltbook** |
| 29 Enero 2026 | Rebrand final a **OpenClaw** |
| 31 Enero 2026 | Brecha de seguridad de Moltbook |
| Enero 2026 | Auditoría revela 512 vulnerabilidades |
| 7 Feb 2026 | v2026.2.6: Soporte Opus 4.6, GPT-5.3-Codex, xAI Grok |
| 12 Feb 2026 | v2026.2.12: Corrige 40+ vulnerabilidades |
| 14-15 Feb 2026 | Steinberger anuncia que se une a OpenAI |
| 15 Feb 2026 | v2026.2.14: Última versión estable |
| 15-16 Feb 2026 | Anuncio de transición a fundación independiente |

---

## 14. Estructura del proyecto

```
.agent/workflows/          # Definiciones de flujos de trabajo
.agents/                   # Configuraciones de agentes
apps/                      # Apps nativas (macOS/iOS/Android)
packages/                  # Paquetes core
skills/                    # Módulos de skills
src/                       # Código fuente TypeScript
  src/gateway/             # Servidor, protocolo RPC, router
  src/config/              # Schema (zod-schema.ts), validación, I/O
  src/agents/              # Runtime, system prompt, sandbox
  src/channels/            # Adaptadores built-in (telegram, discord)
  src/memory/              # Index manager, embeddings, búsqueda híbrida
  src/tools/               # Registro, herramientas built-in
  src/sessions/            # Gestión, almacén de transcripciones
  src/whatsapp/            # Adaptador WhatsApp
  src/telegram/            # Adaptador Telegram
ui/                        # Componentes UI (Lit web components)
extensions/                # Plugins de canales
docs/                      # Documentación
```

### Almacenamiento de datos
| Tipo | Ubicación |
|------|-----------|
| Config | `~/.openclaw/openclaw.json` |
| Estado | `~/.openclaw/` (o `$OPENCLAW_STATE_DIR`) |
| Workspace | `~/.openclaw/workspace/` |
| Sesiones | `~/.openclaw/agents/<agentId>/sessions/*.jsonl` |
| Memoria | `~/.openclaw/agents/<agentId>/memory.sqlite` |
| Credenciales | `~/.openclaw/credentials/` (permisos 0600) |

### Costos de uso
OpenClaw en sí es gratuito (MIT license). Los costos provienen de las APIs de modelos:

| Nivel de uso | Costo mensual |
|-------------|---------------|
| Ligero | $10-30 |
| Típico | $30-70 |
| Automatización intensiva | $100-150+ |

---

## 15. Conclusión

OpenClaw representa uno de los fenómenos más significativos en el código abierto de IA en 2026. Es un proyecto ambicioso que busca poner un agente autónomo de IA al alcance de cualquier persona, ejecutándose en su propio hardware y comunicándose a través de sus aplicaciones de mensajería habituales. Su arquitectura hub-and-spoke centrada en un Gateway WebSocket es elegante y extensible, su ecosistema de skills es masivo, y su crecimiento comunitario ha sido histórico.

Sin embargo, el proyecto enfrenta desafíos críticos de seguridad que no pueden ignorarse. Con más de 500 vulnerabilidades identificadas, miles de instancias expuestas sin autenticación, y un 20% de skills maliciosos en su registry, OpenClaw es tanto una demostración del potencial de los agentes autónomos de IA como una advertencia sobre los riesgos de dar acceso total al sistema a un software emergente.

La transición a una fundación independiente respaldada por OpenAI, combinada con la entrada de Steinberger a la compañía, posiciona al proyecto para un futuro interesante pero incierto. Si la fundación logra resolver los problemas de seguridad mientras mantiene la velocidad de innovación y el espíritu abierto de la comunidad, OpenClaw podría convertirse en la plataforma estándar de facto para agentes personales de IA.
