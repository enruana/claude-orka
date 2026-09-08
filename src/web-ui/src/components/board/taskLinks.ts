import { encodeProjectPath } from '../ProjectDashboard'

/**
 * Shared "where does this task's work live" helpers.
 *
 * A board task points at a KB entity, and that entity carries the paths
 * that actually matter to a human: the folder the work lives in, the
 * overview doc, the notes. Both the task modal and the archive drawer
 * need to turn those into openable links, so the mapping lives here
 * rather than being copied — the two would drift the moment a new path
 * property is added.
 */

/** KB entity properties that hold a project-relative path, in the order
 *  they should be offered. */
export const PATH_PROPERTIES = [
  'master_doc',
  'path',
  'notes_path',
  'profile_path',
  'source_path',
  'repo_path',
  'filePath',
] as const

export interface TaskLink {
  key: string
  path: string
  isFile: boolean
}

export function labelForPathKey(key: string): string {
  switch (key) {
    case 'master_doc': return 'Documento principal'
    case 'path': return 'Carpeta'
    case 'notes_path': return 'Notas'
    case 'profile_path': return 'Perfil'
    case 'source_path': return 'Fuente'
    case 'repo_path': return 'Repositorio'
    case 'filePath': return 'Archivo'
    default: return key
  }
}

/** Pull the openable paths off a KB entity's properties bag. */
export function kbLinksFromEntity(
  entity: { properties?: Record<string, unknown> } | null | undefined,
): TaskLink[] {
  const props = entity?.properties
  if (!props) return []
  const out: TaskLink[] = []
  for (const key of PATH_PROPERTIES) {
    const raw = props[key]
    if (typeof raw !== 'string' || !raw.trim()) continue
    const clean = raw.trim().replace(/^\/+/, '')
    out.push({ key, path: clean, isFile: /\.\w+$/.test(clean) })
  }
  return out
}

/**
 * Open a project-relative path in the right viewer.
 *
 * HTML goes through the direct `/api/files/preview/:enc/*path` endpoint
 * so relative assets (<link>, <img>, <script>) resolve against the
 * file's own URL — needed for a self-contained overview.html that
 * references its neighbours. Other files stay on the FileViewer SPA
 * route, which wraps them in the app chrome; anything without an
 * extension is treated as a folder and opens in the finder.
 */
export function openTaskPath(projectPath: string, filePath: string): void {
  const encodedProject = encodeProjectPath(projectPath)
  const clean = filePath.replace(/^\/+/, '')
  const isFile = /\.\w+$/.test(clean)
  const isHtml = /\.html?$/i.test(clean)

  let target: string
  if (isHtml) {
    const pathSegments = clean.split('/').map((s) => encodeURIComponent(s)).join('/')
    // `?comments=1&voice=1` mounts the review-comment rail and the voice
    // widget — board artifacts are the docs users most often open on
    // mobile to talk about.
    target = `/api/files/preview/${encodedProject}/${pathSegments}?comments=1&voice=1`
  } else if (isFile) {
    target = `/projects/${encodedProject}/files/view?path=${encodeURIComponent(clean)}`
  } else {
    target = `/projects/${encodedProject}/files?path=${encodeURIComponent(clean)}`
  }
  window.open(target, '_blank')
}
