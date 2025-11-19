#!/usr/bin/env node

import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Run the bundled CLI
const cliPath = resolve(__dirname, '../dist/cli.js')
await import(cliPath)
