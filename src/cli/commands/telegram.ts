import { Command } from 'commander'
import chalk from 'chalk'
import { Output } from '../utils/output'
import { handleError } from '../utils/errors'

export function telegramCommand(program: Command) {
  const telegram = program
    .command('telegram')
    .description('Telegram bot utilities')

  telegram
    .command('test')
    .description('Send a test message to a bot')
    .requiredOption('-t, --token <token>', 'Bot token')
    .requiredOption('-c, --chat-id <chatId>', 'Chat ID')
    .action(async (options) => {
      try {
        console.log('Enviando mensaje de prueba...')

        const response = await fetch(`https://api.telegram.org/bot${options.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: parseInt(options.chatId),
            text: '🎭 <b>Orka Bot - Test</b>\n\nConexion exitosa! El bot esta funcionando correctamente.',
            parse_mode: 'HTML',
          }),
        })

        const data = await response.json() as { ok: boolean; description?: string }

        if (data.ok) {
          Output.success('Mensaje de prueba enviado! Revisa tu Telegram.')
        } else {
          Output.error(`Error: ${data.description || 'Unknown error'}`)
        }
      } catch (error) {
        handleError(error)
      }
    })

  telegram
    .command('chat-id')
    .description('Detect your chat ID from recent messages to a bot')
    .requiredOption('-t, --token <token>', 'Bot token')
    .action(async (options) => {
      try {
        console.log('Buscando mensajes recientes...')
        console.log(chalk.gray('(Asegurate de haberle enviado un mensaje al bot primero)\n'))

        const response = await fetch(`https://api.telegram.org/bot${options.token}/getUpdates?limit=5`)
        const data = await response.json() as { ok: boolean; result: Array<{ message?: { from?: { id: number; first_name?: string } } }> }

        if (!data.ok || !data.result?.length) {
          Output.warn('No se encontraron mensajes. Enviale un mensaje al bot primero.')
          return
        }

        for (const update of data.result) {
          if (update.message?.from?.id) {
            const name = update.message.from.first_name || 'Unknown'
            console.log(`  Chat ID: ${chalk.green.bold(update.message.from.id)} (${name})`)
            return
          }
        }

        Output.warn('No se encontraron mensajes con chat ID.')
      } catch (error) {
        handleError(error)
      }
    })
}
