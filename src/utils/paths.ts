import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs-extra'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Resolve a module directory inside this package's node_modules.
 * Works for: global install, local install, running from source (tsx).
 */
export function getPackageNodeModulesPath(moduleName: string): string | null {
  const candidates = [
    // Global/local install (dist/utils/paths.js → dist/ → package root)
    path.join(__dirname, '..', 'node_modules', moduleName),
    // Compiled SDK or source (dist/utils/ or src/utils/ → package root)
    path.join(__dirname, '../..', 'node_modules', moduleName),
    // Fallback: cwd (for development with npm link)
    path.join(process.cwd(), 'node_modules', moduleName),
  ]

  for (const candidate of candidates) {
    if (fs.pathExistsSync(candidate)) {
      return candidate
    }
  }
  return null
}
