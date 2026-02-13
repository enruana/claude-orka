/**
 * TerminalScreenshot - Converts tmux pane ANSI output to a PNG image
 *
 * Pipeline: tmux capture-pane -e → ansi_up (ANSI→HTML) → puppeteer (HTML→PNG)
 * Graceful fallback: returns null if puppeteer is unavailable or fails.
 */

import { AnsiUp } from 'ansi_up'
import { TmuxCommands } from '../utils/tmux'
import { logger } from '../utils'

class TerminalScreenshot {
  private browser: any = null
  private browserPromise: Promise<any> | null = null

  /**
   * Capture a tmux pane as a PNG screenshot buffer.
   * Returns null on any error (caller should fall back to text).
   */
  async capture(paneId: string, lines: number = 50): Promise<Buffer | null> {
    try {
      // 1. Capture ANSI output from tmux
      const ansiText = await TmuxCommands.capturePaneAnsi(paneId, -lines)
      if (!ansiText.trim()) {
        logger.debug('TerminalScreenshot: empty pane content')
        return null
      }

      // 2. Convert ANSI → HTML
      const converter = new AnsiUp()
      converter.use_classes = false
      const htmlBody = converter.ansi_to_html(ansiText)

      // 3. Wrap in styled HTML template
      const html = this.buildHtml(htmlBody)

      // 4. Render to PNG with puppeteer
      const browser = await this.getBrowser()
      if (!browser) return null

      const page = await browser.newPage()
      try {
        await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 2 })
        await page.setContent(html, { waitUntil: 'load' })
        const buffer = await page.screenshot({ type: 'png', fullPage: true })
        return Buffer.from(buffer)
      } finally {
        await page.close()
      }
    } catch (err: any) {
      logger.warn(`TerminalScreenshot: capture failed: ${err.message}`)
      return null
    }
  }

  /** Close the browser instance on shutdown */
  async dispose(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close()
      } catch { /* ignore */ }
      this.browser = null
      this.browserPromise = null
    }
  }

  /**
   * Lazy-init puppeteer browser. Dynamic import so the module doesn't crash
   * if puppeteer is not installed — capture() just returns null.
   */
  private async getBrowser(): Promise<any> {
    if (this.browser) return this.browser

    // Deduplicate concurrent launches
    if (this.browserPromise) return this.browserPromise

    this.browserPromise = (async () => {
      try {
        const puppeteer = await import('puppeteer')
        this.browser = await puppeteer.default.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
        })
        return this.browser
      } catch (err: any) {
        logger.warn(`TerminalScreenshot: puppeteer not available: ${err.message}`)
        this.browserPromise = null
        return null
      }
    })()

    return this.browserPromise
  }

  private buildHtml(body: string): string {
    return `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: Menlo, Monaco, 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.4;
    padding: 16px;
  }
  pre {
    white-space: pre-wrap;
    word-wrap: break-word;
  }
</style>
</head>
<body><pre>${body}</pre></body>
</html>`
  }
}

export const terminalScreenshot = new TerminalScreenshot()
