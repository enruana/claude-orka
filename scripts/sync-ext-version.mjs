#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const manifestPath = new URL('../chrome-extension/manifest.json', import.meta.url)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

if (manifest.version === pkg.version) {
  process.exit(0)
}

manifest.version = pkg.version
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`chrome-extension/manifest.json → ${pkg.version}`)
