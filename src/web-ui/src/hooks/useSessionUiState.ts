import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Per-session UI-shape memory. Persists which tab was active, which
 * files were open in the editor, which terminals had shells attached,
 * so navigating away and back to a session feels like switching desktop
 * apps rather than losing the workspace.
 *
 * Server-side artefacts (editor terminals keyed by cwd, file contents
 * on disk) already survive by design; this hook only remembers WHICH
 * of them the UI should re-mount.
 */

export type SessionRightTab = 'terminal' | 'code' | 'files' | 'kb'

export interface SessionUiState {
  v: 1
  tab?: SessionRightTab
  editor?: {
    openFilePaths?: string[]
    activeFilePath?: string | null
    showSidebar?: boolean
    sidebarMode?: 'files' | 'search'
    showGitPanel?: boolean
    terminalPanel?: {
      open?: boolean
      cwds?: string[]
      active?: string | null
    }
  }
  updatedAt?: string
}

const STORAGE_PREFIX = 'orka.session.ui:'
const INDEX_KEY = 'orka.session.ui.index'
const MAX_ENTRIES = 40
const WRITE_DEBOUNCE_MS = 200

// Cheap FNV-1a on the projectPath so the storage key stays short.
function hashProjectPath(p: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(36)
}

function storageKey(projectPath: string, sessionId: string): string {
  return STORAGE_PREFIX + hashProjectPath(projectPath) + ':' + sessionId
}

function readIndex(): string[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
  } catch { return [] }
}

// Bump a key to newest position and evict oldest beyond the cap. Keeps
// localStorage from growing unbounded when the user churns sessions.
function touchIndex(key: string) {
  try {
    const idx = readIndex().filter((k) => k !== key)
    idx.push(key)
    while (idx.length > MAX_ENTRIES) {
      const stale = idx.shift()
      if (stale) localStorage.removeItem(stale)
    }
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx))
  } catch { /* quota / private mode */ }
}

function readState(key: string): SessionUiState {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { v: 1 }
    const parsed = JSON.parse(raw)
    if (parsed && parsed.v === 1) return parsed as SessionUiState
    return { v: 1 }
  } catch { return { v: 1 } }
}

function writeState(key: string, state: SessionUiState) {
  try {
    localStorage.setItem(key, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }))
    touchIndex(key)
  } catch { /* quota / private mode — drop */ }
}

// Deep merge shallow one level; editor sub-object merges its own keys.
function mergeState(prev: SessionUiState, patch: Partial<SessionUiState>): SessionUiState {
  const next: SessionUiState = { ...prev, ...patch, v: 1 }
  if (patch.editor) {
    next.editor = {
      ...(prev.editor ?? {}),
      ...patch.editor,
      terminalPanel: patch.editor.terminalPanel
        ? { ...(prev.editor?.terminalPanel ?? {}), ...patch.editor.terminalPanel }
        : prev.editor?.terminalPanel,
    }
  }
  return next
}

export interface SessionUiStateApi {
  state: SessionUiState
  patch: (p: Partial<SessionUiState>) => void
  patchEditor: (p: Partial<NonNullable<SessionUiState['editor']>>) => void
  patchTerminalPanel: (
    p: Partial<NonNullable<NonNullable<SessionUiState['editor']>['terminalPanel']>>,
  ) => void
}

export function useSessionUiState(
  projectPath: string | null | undefined,
  sessionId: string | null | undefined,
): SessionUiStateApi {
  const key = projectPath && sessionId ? storageKey(projectPath, sessionId) : null

  const [state, setState] = useState<SessionUiState>(() =>
    key ? readState(key) : { v: 1 },
  )
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  // Re-hydrate whenever the identity changes (e.g. user opens a
  // different session inside the same modal without unmounting).
  useEffect(() => {
    setState(key ? readState(key) : { v: 1 })
  }, [key])

  const writeTimerRef = useRef<number | null>(null)
  const scheduleWrite = useCallback((next: SessionUiState) => {
    if (!key) return
    if (writeTimerRef.current !== null) window.clearTimeout(writeTimerRef.current)
    writeTimerRef.current = window.setTimeout(() => {
      writeState(key, next)
    }, WRITE_DEBOUNCE_MS)
  }, [key])

  // Flush pending write on unmount so the last change isn't lost when
  // the modal closes right after a mutation.
  useEffect(() => {
    return () => {
      if (writeTimerRef.current !== null && key) {
        window.clearTimeout(writeTimerRef.current)
        writeState(key, stateRef.current)
      }
    }
  }, [key])

  const patch = useCallback((p: Partial<SessionUiState>) => {
    setState((prev) => {
      const next = mergeState(prev, p)
      scheduleWrite(next)
      return next
    })
  }, [scheduleWrite])

  const patchEditor = useCallback<SessionUiStateApi['patchEditor']>((p) => {
    patch({ editor: p })
  }, [patch])

  const patchTerminalPanel = useCallback<SessionUiStateApi['patchTerminalPanel']>((p) => {
    patch({ editor: { terminalPanel: p } })
  }, [patch])

  return { state, patch, patchEditor, patchTerminalPanel }
}
