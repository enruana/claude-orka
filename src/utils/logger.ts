/**
 * Logger simple para Claude-Orka
 */

import fs from 'fs-extra'
import path from 'path'
import os from 'os'

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class Logger {
  private level: LogLevel = LogLevel.INFO
  private logFilePath: string | null = null

  setLevel(level: LogLevel) {
    this.level = level
  }

  /**
   * Set log file in global ~/.orka/ directory
   */
  setGlobalLogFile() {
    const logDir = path.join(os.homedir(), '.orka')
    fs.ensureDirSync(logDir)
    this.logFilePath = path.join(logDir, 'orka.log')
  }

  /**
   * @deprecated Use setGlobalLogFile() instead
   */
  setLogFile(_projectPath: string) {
    // Now redirects to global log
    this.setGlobalLogFile()
  }

  private writeToFile(level: string, ...args: any[]) {
    if (!this.logFilePath) return

    const timestamp = new Date().toISOString()
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ')
    const logLine = `${timestamp} [${level}] ${message}\n`

    try {
      fs.appendFileSync(this.logFilePath, logLine)
    } catch (error) {
      // Silently fail if we can't write to log file
    }
  }

  debug(...args: any[]) {
    if (this.level <= LogLevel.DEBUG) {
      console.log('[DEBUG]', ...args)
      this.writeToFile('DEBUG', ...args)
    }
  }

  info(...args: any[]) {
    if (this.level <= LogLevel.INFO) {
      console.log('[INFO]', ...args)
      this.writeToFile('INFO', ...args)
    }
  }

  warn(...args: any[]) {
    if (this.level <= LogLevel.WARN) {
      console.warn('[WARN]', ...args)
      this.writeToFile('WARN', ...args)
    }
  }

  error(...args: any[]) {
    if (this.level <= LogLevel.ERROR) {
      console.error('[ERROR]', ...args)
      this.writeToFile('ERROR', ...args)
    }
  }
}

export const logger = new Logger()
