/**
 * TelegramBot - Per-agent Telegram bot for bidirectional communication
 *
 * Each agent has its own bot instance with its own token.
 * Uses grammY with long polling (no public URL needed).
 *
 * Free text → LLM consultation (reads terminal, answers intelligently)
 * /tell    → Direct command injection into Claude Code terminal
 */

import { Bot, InlineKeyboard, InputFile } from 'grammy'
import { logger } from '../utils'
import type { TelegramConfig } from '../models/Agent'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramNotification {
  level: 'info' | 'warn' | 'error' | 'action'
  title: string
  body: string
  terminalSnippet?: string
}

export interface TelegramApprovalRequest {
  id: string
  description: string
  resolve: (approved: boolean) => void
}

/** Provider for terminal access (injected by AgentDaemon) */
export interface TerminalProvider {
  captureTerminal(lines?: number): Promise<string | null>
  captureScreenshot(lines?: number): Promise<Buffer | null>
  sendText(text: string): Promise<boolean>
}

/** Provider for LLM-based Q&A about the agent (injected by AgentDaemon) */
export interface QueryProvider {
  ask(question: string, terminalContent: string): Promise<string>
}

/** Provider for human instructions that go through the LLM decision pipeline */
export interface InstructionProvider {
  instruct(instruction: string): Promise<InstructionResult | null>
}

export interface InstructionResult {
  action: string
  response?: string
  reason: string
  notification?: { message: string; level: string }
}

// ---------------------------------------------------------------------------
// TelegramBot (per-agent instance)
// ---------------------------------------------------------------------------

export class TelegramBot {
  private bot: Bot | null = null
  private config: TelegramConfig
  private agentId: string
  private agentName: string
  private running: boolean = false
  private pendingApprovals: Map<string, TelegramApprovalRequest> = new Map()
  private terminalProvider: TerminalProvider | null = null
  private queryProvider: QueryProvider | null = null
  private instructionProvider: InstructionProvider | null = null

  constructor(agentId: string, agentName: string, config: TelegramConfig) {
    this.agentId = agentId
    this.agentName = agentName
    this.config = config
  }

  /** Set the terminal provider (called by AgentDaemon) */
  setTerminalProvider(provider: TerminalProvider): void {
    this.terminalProvider = provider
  }

  /** Set the query provider for LLM-based consultation (called by AgentDaemon) */
  setQueryProvider(provider: QueryProvider): void {
    this.queryProvider = provider
  }

  /** Set the instruction provider for human→LLM→terminal pipeline (called by AgentDaemon) */
  setInstructionProvider(provider: InstructionProvider): void {
    this.instructionProvider = provider
  }

  /** Start the bot */
  async start(): Promise<void> {
    if (this.running) await this.stop()

    if (!this.config.enabled || !this.config.botToken || !this.config.chatId) {
      return
    }

    this.bot = new Bot(this.config.botToken)

    // Auth middleware
    this.bot.use(async (ctx, next) => {
      if (ctx.from?.id !== this.config.chatId) return
      await next()
    })

    this.registerCommands()
    this.registerCallbackHandlers()

    this.bot.catch((err) => {
      logger.error(`[${this.agentId}] Telegram bot error: ${err.message}`)
    })

    // Set running before start() to avoid race with stop()
    this.running = true

    this.startPolling(this.bot)
  }

  /**
   * Start long polling with retry logic for 409 conflicts.
   * When the server restarts, the old polling request may still be alive
   * (Telegram's getUpdates has a 30s timeout). We retry until it expires.
   */
  private startPolling(bot: Bot, attempt = 0): void {
    const MAX_RETRIES = 3
    const RETRY_DELAY_MS = 5_000

    bot.start({
      onStart: () => {
        logger.info(`[${this.agentId}] Telegram bot started`)
      },
    }).catch((err: any) => {
      // Bot was stopped while starting — not an error
      if (!this.running) return

      const is409 = err?.error_code === 409 || err?.description?.includes('terminated by other getUpdates')

      if (is409 && attempt < MAX_RETRIES) {
        logger.warn(`[${this.agentId}] Telegram 409 conflict (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${RETRY_DELAY_MS / 1000}s...`)
        setTimeout(() => {
          if (!this.running) return
          this.startPolling(bot, attempt + 1)
        }, RETRY_DELAY_MS)
      } else {
        logger.error(`[${this.agentId}] Telegram bot polling failed: ${err.message}`)
        this.running = false
      }
    })
  }

  /** Stop the bot */
  async stop(): Promise<void> {
    this.running = false

    // Resolve all pending approvals as rejected
    this.pendingApprovals.forEach((req) => req.resolve(false))
    this.pendingApprovals.clear()

    if (this.bot) {
      try {
        await this.bot.stop()
      } catch (err: any) {
        logger.debug(`[${this.agentId}] Telegram bot stop error (safe to ignore): ${err.message}`)
      }
      this.bot = null
      logger.info(`[${this.agentId}] Telegram bot stopped`)
    }
  }

  isRunning(): boolean {
    return this.running
  }

  // -----------------------------------------------------------------------
  // Proactive Messages (Agent → User)
  // -----------------------------------------------------------------------

  async sendNotification(notification: TelegramNotification): Promise<void> {
    if (!this.bot || !this.running) return

    const emoji = notification.level === 'error' ? '🔴'
      : notification.level === 'warn' ? '⚠️'
      : notification.level === 'action' ? '🎬'
      : 'ℹ️'

    let text = `${emoji} <b>${esc(notification.title)}</b>\n`
    text += `<i>${esc(this.agentName)}</i>\n\n`
    text += esc(notification.body)

    if (notification.terminalSnippet) {
      const snippet = notification.terminalSnippet.slice(-500)
      text += `\n\n<pre>${esc(snippet)}</pre>`
    }

    try {
      await this.bot.api.sendMessage(this.config.chatId, text, { parse_mode: 'HTML' })
    } catch (err: any) {
      logger.error(`[${this.agentId}] Telegram send failed: ${err.message}`)
    }
  }

  requestApproval(request: Omit<TelegramApprovalRequest, 'resolve'>): Promise<boolean> {
    if (!this.bot || !this.running) return Promise.resolve(false)

    return new Promise<boolean>((resolve) => {
      const full: TelegramApprovalRequest = { ...request, resolve }
      this.pendingApprovals.set(request.id, full)

      const keyboard = new InlineKeyboard()
        .text('✅ Aprobar', `approve:${request.id}`)
        .text('❌ Rechazar', `reject:${request.id}`)

      this.bot!.api.sendMessage(
        this.config.chatId,
        `⚠️ <b>Aprobacion requerida</b>\n<i>${esc(this.agentName)}</i>\n\n${esc(request.description)}`,
        { parse_mode: 'HTML', reply_markup: keyboard }
      ).catch(err => {
        logger.error(`[${this.agentId}] Approval send failed: ${err.message}`)
        this.pendingApprovals.delete(request.id)
        resolve(false)
      })

      // Timeout 5min
      setTimeout(() => {
        if (this.pendingApprovals.has(request.id)) {
          this.pendingApprovals.delete(request.id)
          resolve(false)
        }
      }, 5 * 60 * 1000)
    })
  }

  // -----------------------------------------------------------------------
  // Commands (User → Agent) — all scoped to THIS agent
  // -----------------------------------------------------------------------

  private registerCommands(): void {
    if (!this.bot) return

    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        `<b>🎭 ${esc(this.agentName)}</b>\n\n` +
        `Hola! Soy el bot de este agente. Puedes preguntarme sobre el estado del proyecto o enviar comandos al terminal.\n\n` +
        `Escribe /help para ver todos los comandos disponibles.`,
        { parse_mode: 'HTML' }
      )
    })

    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        `<b>🎭 ${esc(this.agentName)} - Ayuda</b>\n\n` +
        `<b>📋 Comandos disponibles:</b>\n\n` +
        `<b>/status</b>\n` +
        `Estado actual del agente (ID, conexion).\n\n` +
        `<b>/log</b>\n` +
        `Muestra las ultimas 50 lineas del terminal en texto.\n\n` +
        `<b>/sshot</b>\n` +
        `Captura de pantalla del terminal como imagen PNG (con colores).\n\n` +
        `<b>/ask [pregunta]</b>\n` +
        `Consulta sobre el estado del agente usando IA. Lee el terminal y responde con contexto.\n` +
        `Ejemplo: <code>/ask como va el proyecto?</code>\n\n` +
        `<b>/tell [mensaje]</b>\n` +
        `Envia texto directo al terminal (sin pasar por IA). Util para comandos raw.\n` +
        `Ejemplo: <code>/tell /compact</code>\n\n` +
        `<b>/help</b>\n` +
        `Muestra este mensaje de ayuda.\n\n` +
        `<b>💬 Texto libre (instrucciones)</b>\n` +
        `Escribe cualquier mensaje y sera procesado como una instruccion. El agente leera el terminal, decidira que accion tomar y la ejecutara.\n` +
        `Ejemplo: <i>"pasa a la epic 8"</i>, <i>"haz commit y push"</i>, <i>"para y esperame"</i>`,
        { parse_mode: 'HTML' }
      )
    })

    this.bot.command('status', async (ctx) => {
      await ctx.reply(
        `<b>🎭 ${esc(this.agentName)}</b>\n\n` +
        `ID: <code>${this.agentId}</code>\n` +
        `Bot: 🟢 Activo`,
        { parse_mode: 'HTML' }
      )
    })

    this.bot.command('log', async (ctx) => {
      if (!this.terminalProvider) {
        await ctx.reply('Terminal no disponible.')
        return
      }
      const content = await this.terminalProvider.captureTerminal(50)
      if (!content) {
        await ctx.reply('No se pudo capturar el terminal.')
        return
      }
      const truncated = content.slice(-3500)
      await ctx.reply(`<pre>${esc(truncated)}</pre>`, { parse_mode: 'HTML' })
    })

    // /sshot → Terminal screenshot as PNG image (colors + formatting preserved)
    this.bot.command('sshot', async (ctx) => {
      if (!this.terminalProvider) {
        await ctx.reply('Terminal no disponible.')
        return
      }

      const screenshot = await this.terminalProvider.captureScreenshot(50)
      if (screenshot) {
        await ctx.replyWithPhoto(new InputFile(screenshot, 'terminal.png'), {
          caption: this.agentName,
        })
        return
      }

      // Fallback to text if screenshot failed (puppeteer not available)
      await ctx.reply('No se pudo generar screenshot. Usa /log para ver el terminal en texto.')
    })

    // /ask → LLM Q&A consultation (read-only, does not act on terminal)
    this.bot.command('ask', async (ctx) => {
      const question = (ctx.message?.text || '').replace(/^\/ask\s*/, '').trim()
      if (!question) {
        await ctx.reply('Uso: /ask [pregunta]\nEjemplo: /ask como va el proyecto?')
        return
      }
      if (!this.terminalProvider || !this.queryProvider) {
        await ctx.reply('El agente no esta conectado a un terminal.')
        return
      }

      await ctx.api.sendChatAction(this.config.chatId, 'typing')

      try {
        const terminal = await this.terminalProvider.captureTerminal(200)
        if (!terminal) {
          await ctx.reply('No se pudo leer el terminal del agente.')
          return
        }
        const answer = await this.queryProvider.ask(question, terminal)
        const truncated = answer.slice(0, 3800)
        await ctx.reply(truncated, { parse_mode: 'HTML' })
      } catch (err: any) {
        logger.error(`[${this.agentId}] Query failed: ${err.message}`)
        await ctx.reply(`❌ Error al consultar: ${esc(err.message)}`)
      }
    })

    // /tell → Direct injection into terminal
    this.bot.command('tell', async (ctx) => {
      const text = (ctx.message?.text || '').replace(/^\/tell\s*/, '').trim()
      if (!text) {
        await ctx.reply('Uso: /tell [mensaje]\nEjemplo: /tell haz un commit con los cambios')
        return
      }
      if (!this.terminalProvider) {
        await ctx.reply('Terminal no disponible.')
        return
      }
      const success = await this.terminalProvider.sendText(text)
      if (success) {
        await ctx.reply(`✅ Enviado al terminal:\n<i>${esc(text)}</i>`, { parse_mode: 'HTML' })
      } else {
        await ctx.reply('❌ No se pudo enviar al terminal.')
      }
    })

    // Free text → Instruction mode (human→LLM→terminal pipeline)
    // Falls back to Q&A if no instruction provider is set
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message?.text
      if (!text) return

      // Show typing indicator
      await ctx.api.sendChatAction(this.config.chatId, 'typing')

      // Instruction mode: send through LLM decision pipeline
      if (this.instructionProvider) {
        try {
          const result = await this.instructionProvider.instruct(text)
          if (!result) {
            await ctx.reply('⏳ El agente esta ocupado o no pudo procesar la instruccion. Intenta de nuevo en unos segundos.')
            return
          }

          let reply = `✅ <b>${esc(result.action)}</b>\n`
          if (result.response) {
            reply += `📝 <i>${esc(result.response.slice(0, 500))}</i>\n`
          }
          reply += `\n💡 ${esc(result.reason)}`

          await ctx.reply(reply, { parse_mode: 'HTML' })
        } catch (err: any) {
          logger.error(`[${this.agentId}] Instruction failed: ${err.message}`)
          await ctx.reply(`❌ Error al procesar instruccion: ${esc(err.message)}`)
        }
        return
      }

      // Fallback: Q&A mode (backward compat if no instruction provider)
      if (!this.terminalProvider || !this.queryProvider) {
        await ctx.reply('El agente no esta conectado a un terminal.')
        return
      }

      try {
        const terminal = await this.terminalProvider.captureTerminal(200)
        if (!terminal) {
          await ctx.reply('No se pudo leer el terminal del agente.')
          return
        }
        const answer = await this.queryProvider.ask(text, terminal)
        const truncated = answer.slice(0, 3800)
        await ctx.reply(truncated, { parse_mode: 'HTML' })
      } catch (err: any) {
        logger.error(`[${this.agentId}] Query failed: ${err.message}`)
        await ctx.reply(`❌ Error al consultar: ${esc(err.message)}`)
      }
    })
  }

  // -----------------------------------------------------------------------
  // Callback Handlers (Inline Keyboard)
  // -----------------------------------------------------------------------

  private registerCallbackHandlers(): void {
    if (!this.bot) return

    this.bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
      const id = ctx.match[1]
      const req = this.pendingApprovals.get(id)
      if (!req) {
        await ctx.answerCallbackQuery({ text: 'Solicitud expirada.' })
        return
      }
      this.pendingApprovals.delete(id)
      req.resolve(true)
      await ctx.editMessageText(`✅ <b>Aprobado</b>\n<i>${esc(req.description)}</i>`, { parse_mode: 'HTML' })
      await ctx.answerCallbackQuery({ text: 'Aprobado!' })
    })

    this.bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
      const id = ctx.match[1]
      const req = this.pendingApprovals.get(id)
      if (!req) {
        await ctx.answerCallbackQuery({ text: 'Solicitud expirada.' })
        return
      }
      this.pendingApprovals.delete(id)
      req.resolve(false)
      await ctx.editMessageText(`❌ <b>Rechazado</b>\n<i>${esc(req.description)}</i>`, { parse_mode: 'HTML' })
      await ctx.answerCallbackQuery({ text: 'Rechazado.' })
    })

    this.bot.on('callback_query:data', async (ctx) => {
      await ctx.answerCallbackQuery()
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
