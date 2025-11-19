#!/usr/bin/env node

import { register } from 'tsx/esm/api'
import { pathToFileURL } from 'url'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Register tsx to handle TypeScript files
const unregister = register()

// Import and run the CLI
const cliPath = resolve(__dirname, '../src/cli/index.ts')
await import(pathToFileURL(cliPath).href)

// Cleanup
unregister()
