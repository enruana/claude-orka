/**
 * NotificationService - Sends notifications via Telegram and Web Push
 */

import { logger } from '../utils'
import { Agent, NotificationConfig } from '../models/Agent'

/**
 * Notification payload
 */
export interface NotificationPayload {
  title: string
  body: string
  agentId?: string
  agentName?: string
  priority?: 'low' | 'normal' | 'high'
  timestamp: string
}

/**
 * NotificationService handles sending notifications through various channels
 */
export class NotificationService {
  /**
   * Send a notification for an agent
   */
  async sendNotification(
    agent: Agent,
    title: string,
    body: string,
    priority: 'low' | 'normal' | 'high' = 'normal'
  ): Promise<void> {
    const payload: NotificationPayload = {
      title,
      body,
      agentId: agent.id,
      agentName: agent.name,
      priority,
      timestamp: new Date().toISOString(),
    }

    const { notifications } = agent

    // Send via all enabled channels
    const promises: Promise<void>[] = []

    if (notifications.telegram?.enabled) {
      promises.push(this.sendTelegram(notifications.telegram, payload))
    }

    if (notifications.webPush?.enabled) {
      promises.push(this.sendWebPush(notifications.webPush, payload))
    }

    // If no channels configured, log warning
    if (promises.length === 0) {
      logger.warn(`No notification channels configured for agent ${agent.id}`)
      logger.info(`Notification: ${title} - ${body}`)
      return
    }

    // Wait for all to complete
    const results = await Promise.allSettled(promises)

    // Log any failures
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error(`Notification failed: ${result.reason}`)
      }
    }
  }

  /**
   * Send notification via Telegram
   */
  private async sendTelegram(
    config: NonNullable<NotificationConfig['telegram']>,
    payload: NotificationPayload
  ): Promise<void> {
    if (!config.botToken || !config.chatId) {
      logger.warn('Telegram notification not configured properly (missing botToken or chatId)')
      return
    }

    try {
      const message = this.formatTelegramMessage(payload)
      const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      })

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`Telegram API error: ${error}`)
      }

      logger.debug(`Telegram notification sent to chat ${config.chatId}`)
    } catch (error: any) {
      logger.error(`Failed to send Telegram notification: ${error.message}`)
      throw error
    }
  }

  /**
   * Format message for Telegram
   */
  private formatTelegramMessage(payload: NotificationPayload): string {
    const priorityEmoji = {
      low: '',
      normal: '',
      high: '',
    }

    const emoji = priorityEmoji[payload.priority || 'normal']
    const agentInfo = payload.agentName ? `<b>Agent:</b> ${payload.agentName}\n` : ''

    return `${emoji}<b>${payload.title}</b>

${agentInfo}${payload.body}

<i>${new Date(payload.timestamp).toLocaleString()}</i>`
  }

  /**
   * Send notification via Web Push
   */
  private async sendWebPush(
    config: NonNullable<NotificationConfig['webPush']>,
    payload: NotificationPayload
  ): Promise<void> {
    if (!config.endpoint || !config.p256dh || !config.auth) {
      logger.warn('Web Push notification not configured properly')
      return
    }

    try {
      // Web Push requires web-push library for proper VAPID signing
      // For now, we'll just log the notification
      // In a full implementation, you would use the web-push npm package
      logger.info(`Web Push notification would be sent: ${payload.title}`)

      // TODO: Implement actual Web Push using web-push library
      // const webpush = require('web-push')
      // await webpush.sendNotification(
      //   { endpoint: config.endpoint, keys: { p256dh: config.p256dh, auth: config.auth } },
      //   JSON.stringify(payload)
      // )

      logger.debug('Web Push notification logged (not actually sent - needs web-push library)')
    } catch (error: any) {
      logger.error(`Failed to send Web Push notification: ${error.message}`)
      throw error
    }
  }

  /**
   * Test Telegram configuration
   */
  async testTelegram(botToken: string, chatId: string): Promise<boolean> {
    try {
      await this.sendTelegram(
        { enabled: true, botToken, chatId },
        {
          title: 'Test Notification',
          body: 'This is a test notification from Claude Orka Agent',
          priority: 'low',
          timestamp: new Date().toISOString(),
        }
      )
      return true
    } catch {
      return false
    }
  }

  /**
   * Send a simple notification without agent context
   */
  async sendSimple(
    title: string,
    body: string,
    config: NotificationConfig
  ): Promise<void> {
    const payload: NotificationPayload = {
      title,
      body,
      priority: 'normal',
      timestamp: new Date().toISOString(),
    }

    if (config.telegram?.enabled) {
      await this.sendTelegram(config.telegram, payload)
    }

    if (config.webPush?.enabled) {
      await this.sendWebPush(config.webPush, payload)
    }
  }
}
