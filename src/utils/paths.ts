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

/**
 * Resolve the skills source directory.
 * Handles both contexts:
 *   - tsc compiled: dist/utils/paths.js → __dirname = dist/utils/ → ../skills = dist/skills/
 *   - esbuild bundled: dist/cli.js → __dirname = dist/ → ./skills = dist/skills/
 *   - dev (tsx): src/utils/paths.ts → __dirname = src/utils/ → ../assets/skills
 */
export function getSkillsSourcePath(): string | null {
  const candidates = [
    // esbuild bundle: dist/cli.js → __dirname = dist/ → dist/skills/
    path.join(__dirname, 'skills'),
    // tsc compiled: dist/utils/ → dist/skills/
    path.join(__dirname, '..', 'skills'),
    // Dev (tsx): src/utils/ → src/assets/skills/
    path.join(__dirname, '..', 'assets', 'skills'),
    // Dev fallback
    path.join(__dirname, 'assets', 'skills'),
  ]

  for (const candidate of candidates) {
    if (fs.pathExistsSync(candidate)) {
      const files = fs.readdirSync(candidate)
      if (files.some((f: string) => f.endsWith('.md'))) {
        return candidate
      }
    }
  }
  return null
}
