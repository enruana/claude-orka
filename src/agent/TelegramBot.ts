/**
 * TelegramBot - Per-agent Telegram bot for bidirectional communication
 *
 * Each agent has its own bot instance with its own token.
 * Uses grammY with long polling (no public URL needed).
 *
 * Free text → LLM consultation (reads terminal, answers intelligently)
 * /tell    → Direct command injection into Claude Code terminal
 */

import { Bot, InlineKeyboard } from 'grammy'
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
  sendText(text: string): Promise<boolean>
}

/** Provider for LLM-based Q&A about the agent (injected by AgentDaemon) */
export interface QueryProvider {
  ask(question: string, terminalContent: string): Promise<string>
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

    this.bot.start({
      onStart: () => {
        this.running = true
        logger.info(`[${this.agentId}] Telegram bot started`)
      },
    })
  }

  /** Stop the bot */
  async stop(): Promise<void> {
    if (this.bot && this.running) {
      await this.bot.stop()
      this.running = false
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
        `Muestra las ultimas 50 lineas del terminal del agente.\n\n` +
        `<b>/tell [mensaje]</b>\n` +
        `Envia un mensaje directo al terminal de Claude Code. Util para dar instrucciones, responder preguntas o enviar comandos.\n` +
        `Ejemplo: <code>/tell haz un commit con los cambios</code>\n\n` +
        `<b>/help</b>\n` +
        `Muestra este mensaje de ayuda.\n\n` +
        `<b>💬 Texto libre</b>\n` +
        `Escribe cualquier mensaje y usare IA para leer el terminal del agente y responderte con contexto sobre lo que esta haciendo. Ideal para preguntar cosas como:\n` +
        `• <i>"Como va el proyecto?"</i>\n` +
        `• <i>"Que esta haciendo ahora?"</i>\n` +
        `• <i>"Hay algun error?"</i>`,
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

    // Free text → LLM consultation (read terminal + answer question)
    this.bot.on('message:text', async (ctx) => {
      const question = ctx.message?.text
      if (!question) return

      if (!this.terminalProvider || !this.queryProvider) {
        await ctx.reply('El agente no esta conectado a un terminal.')
        return
      }

      // Show typing indicator
      await ctx.api.sendChatAction(this.config.chatId, 'typing')

      try {
        // Capture terminal
        const terminal = await this.terminalProvider.captureTerminal(200)
        if (!terminal) {
          await ctx.reply('No se pudo leer el terminal del agente.')
          return
        }

        // Ask LLM
        const answer = await this.queryProvider.ask(question, terminal)

        // Send response (truncate to Telegram limit)
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
