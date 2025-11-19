import execa from 'execa'
import { logger } from './logger'

/**
 * Error personalizado para comandos tmux
 */
export class TmuxError extends Error {
  constructor(message: string, public command: string, public originalError?: any) {
    super(message)
    this.name = 'TmuxError'
  }
}

/**
 * Wrapper de comandos tmux
 */
export class TmuxCommands {
  /**
   * Verificar si tmux está disponible
   */
  static async isAvailable(): Promise<boolean> {
    try {
      await execa('which', ['tmux'])
      return true
    } catch {
      return false
    }
  }

  /**
   * Crear una nueva sesión tmux en modo detached
   */
  static async createSession(name: string, projectPath: string): Promise<void> {
    try {
      logger.debug(`Creating tmux session: ${name} at ${projectPath}`)
      await execa('tmux', ['new-session', '-d', '-s', name, '-c', projectPath])
      logger.info(`Tmux session created: ${name}`)
    } catch (error: any) {
      throw new TmuxError(
        `Failed to create tmux session: ${name}`,
        `tmux new-session -d -s ${name} -c ${projectPath}`,
        error
      )
    }
  }

  /**
   * Abrir una terminal que se adjunte a una sesión tmux existente
   * (Solo macOS por ahora)
   */
  static async openTerminalWindow(sessionName: string): Promise<void> {
    try {
      logger.debug(`Opening terminal window for session: ${sessionName}`)

      // Detectar sistema operativo
      const platform = process.platform

      if (platform === 'darwin') {
        // macOS - Usar Terminal.app
        const script = `tell application "Terminal"
          do script "tmux attach -t ${sessionName}"
          activate
        end tell`

        await execa('osascript', ['-e', script])
        logger.info('Terminal window opened (Terminal.app)')
      } else if (platform === 'linux') {
        // Linux - Intentar con gnome-terminal, xterm, etc.
        try {
          await execa('gnome-terminal', ['--', 'tmux', 'attach', '-t', sessionName])
          logger.info('Terminal window opened (gnome-terminal)')
        } catch {
          try {
            await execa('xterm', ['-e', `tmux attach -t ${sessionName}`])
            logger.info('Terminal window opened (xterm)')
          } catch {
            logger.warn('Could not open terminal window on Linux')
            throw new Error('No suitable terminal emulator found')
          }
        }
      } else {
        logger.warn(`Platform ${platform} not supported for opening terminal windows`)
        throw new Error(`Platform ${platform} not supported`)
      }
    } catch (error: any) {
      throw new TmuxError(
        `Failed to open terminal window for session: ${sessionName}`,
        `osascript/terminal`,
        error
      )
    }
  }

  /**
   * Cerrar una sesión tmux
   */
  static async killSession(sessionName: string): Promise<void> {
    try {
      logger.debug(`Killing tmux session: ${sessionName}`)
      await execa('tmux', ['kill-session', '-t', sessionName])
      logger.info(`Tmux session killed: ${sessionName}`)
    } catch (error: any) {
      throw new TmuxError(
        `Failed to kill tmux session: ${sessionName}`,
        `tmux kill-session -t ${sessionName}`,
        error
      )
    }
  }

  /**
   * Verificar si una sesión existe
   */
  static async sessionExists(sessionName: string): Promise<boolean> {
    try {
      await execa('tmux', ['has-session', '-t', sessionName])
      return true
    } catch {
      return false
    }
  }

  /**
   * Obtener el ID del pane principal de una sesión
   */
  static async getMainPaneId(sessionName: string): Promise<string> {
    try {
      logger.debug(`Getting main pane ID for session: ${sessionName}`)
      const { stdout } = await execa('tmux', [
        'list-panes',
        '-t',
        sessionName,
        '-F',
        '#{pane_id}',
      ])
      const paneId = stdout.split('\n')[0]
      logger.debug(`Main pane ID: ${paneId}`)
      return paneId
    } catch (error: any) {
      throw new TmuxError(
        `Failed to get main pane ID for session: ${sessionName}`,
        `tmux list-panes -t ${sessionName} -F '#{pane_id}'`,
        error
      )
    }
  }

  /**
   * Obtener el ID de la ventana principal de una sesión
   */
  static async getMainWindowId(sessionName: string): Promise<string> {
    try {
      logger.debug(`Getting main window ID for session: ${sessionName}`)
      const { stdout } = await execa('tmux', [
        'list-windows',
        '-t',
        sessionName,
        '-F',
        '#{window_id}',
      ])
      const windowId = stdout.split('\n')[0]
      logger.debug(`Main window ID: ${windowId}`)
      return windowId
    } catch (error: any) {
      throw new TmuxError(
        `Failed to get main window ID for session: ${sessionName}`,
        `tmux list-windows -t ${sessionName} -F '#{window_id}'`,
        error
      )
    }
  }

  /**
   * Dividir un pane (crear fork)
   * @param sessionName Nombre de la sesión
   * @param vertical Si es true, divide verticalmente (-h), si es false horizontalmente (-v)
   * @returns ID del nuevo pane creado
   */
  static async splitPane(sessionName: string, vertical: boolean = false): Promise<string> {
    try {
      const direction = vertical ? '-h' : '-v'
      logger.debug(`Splitting pane in session ${sessionName} (${vertical ? 'vertical' : 'horizontal'})`)

      await execa('tmux', ['split-window', '-t', sessionName, direction])

      // Obtener el ID del último pane creado
      const { stdout } = await execa('tmux', [
        'list-panes',
        '-t',
        sessionName,
        '-F',
        '#{pane_id}',
      ])
      const panes = stdout.split('\n')
      const newPaneId = panes[panes.length - 1]

      logger.info(`New pane created: ${newPaneId}`)
      return newPaneId
    } catch (error: any) {
      throw new TmuxError(
        `Failed to split pane in session: ${sessionName}`,
        `tmux split-window -t ${sessionName} ${vertical ? '-h' : '-v'}`,
        error
      )
    }
  }

  /**
   * Listar todos los panes de una sesión
   * @param sessionName Nombre de la sesión
   * @returns Array de IDs de panes
   */
  static async listPanes(sessionName: string): Promise<string[]> {
    try {
      const { stdout } = await execa('tmux', [
        'list-panes',
        '-t',
        sessionName,
        '-F',
        '#{pane_id}',
      ])
      return stdout.trim().split('\n').filter(Boolean)
    } catch (error: any) {
      throw new TmuxError(
        `Failed to list panes for session: ${sessionName}`,
        `tmux list-panes -t ${sessionName}`,
        error
      )
    }
  }

  /**
   * Cerrar un pane específico
   */
  static async killPane(paneId: string): Promise<void> {
    try {
      logger.debug(`Killing pane: ${paneId}`)
      await execa('tmux', ['kill-pane', '-t', paneId])
      logger.info(`Pane killed: ${paneId}`)
    } catch (error: any) {
      throw new TmuxError(
        `Failed to kill pane: ${paneId}`,
        `tmux kill-pane -t ${paneId}`,
        error
      )
    }
  }

  /**
   * Enviar texto a un pane (SIN Enter)
   * IMPORTANTE: No envía Enter, debe llamarse a sendEnter() por separado
   */
  static async sendKeys(paneId: string, text: string): Promise<void> {
    try {
      logger.debug(`Sending keys to pane ${paneId}: ${text.substring(0, 50)}...`)
      await execa('tmux', ['send-keys', '-t', paneId, text])
    } catch (error: any) {
      throw new TmuxError(
        `Failed to send keys to pane: ${paneId}`,
        `tmux send-keys -t ${paneId} "${text}"`,
        error
      )
    }
  }

  /**
   * Enviar SOLO Enter a un pane
   */
  static async sendEnter(paneId: string): Promise<void> {
    try {
      logger.debug(`Sending Enter to pane: ${paneId}`)
      await execa('tmux', ['send-keys', '-t', paneId, 'Enter'])
    } catch (error: any) {
      throw new TmuxError(
        `Failed to send Enter to pane: ${paneId}`,
        `tmux send-keys -t ${paneId} Enter`,
        error
      )
    }
  }

  /**
   * Enviar teclas especiales (flechas, escape, etc.)
   * @param paneId ID del pane
   * @param key Nombre de la tecla: 'Up', 'Down', 'Left', 'Right', 'Escape', 'Space', etc.
   */
  static async sendSpecialKey(paneId: string, key: string): Promise<void> {
    try {
      logger.debug(`Sending special key '${key}' to pane: ${paneId}`)
      await execa('tmux', ['send-keys', '-t', paneId, key])
    } catch (error: any) {
      throw new TmuxError(
        `Failed to send special key '${key}' to pane: ${paneId}`,
        `tmux send-keys -t ${paneId} ${key}`,
        error
      )
    }
  }

  /**
   * Capturar el contenido de un pane
   * @param paneId ID del pane
   * @param startLine Línea desde donde empezar a capturar (negativo = desde el final)
   * @returns Contenido del pane
   */
  static async capturePane(paneId: string, startLine: number = -100): Promise<string> {
    try {
      logger.debug(`Capturing pane ${paneId} from line ${startLine}`)
      const { stdout } = await execa('tmux', [
        'capture-pane',
        '-t',
        paneId,
        '-p',
        '-S',
        startLine.toString(),
      ])
      return stdout
    } catch (error: any) {
      throw new TmuxError(
        `Failed to capture pane: ${paneId}`,
        `tmux capture-pane -t ${paneId} -p -S ${startLine}`,
        error
      )
    }
  }

  /**
   * Listar todas las sesiones tmux
   */
  static async listSessions(): Promise<Array<{ id: string; name: string }>> {
    try {
      const { stdout } = await execa('tmux', ['list-sessions', '-F', '#{session_id}:#{session_name}'])
      return stdout.split('\n').map((line: string) => {
        const [id, name] = line.split(':')
        return { id, name }
      })
    } catch (error: any) {
      // Si no hay sesiones, tmux devuelve error
      if (error.stderr?.includes('no server running')) {
        return []
      }
      throw new TmuxError(
        'Failed to list tmux sessions',
        'tmux list-sessions',
        error
      )
    }
  }
}
