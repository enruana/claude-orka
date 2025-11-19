#!/usr/bin/env node

import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// Suppress experimental JSON import warnings
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' &&
      warning.message.includes('Importing JSON modules')) {
    return
  }
  console.warn(warning)
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Run the bundled CLI
const cliPath = resolve(__dirname, '../dist/cli.js')
await import(cliPath)
