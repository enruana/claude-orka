import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  GitBranch,
  Kanban,
  LayoutGrid,
  Plus,
  Terminal,
  X,
  Save,
  RefreshCw,
  RotateCw,
  Tag,
  Trash2,
} from 'lucide-react'
import { api, type RegisteredProject, type Session, type BoardIndexEntry } from '../../api/client'
import { SessionView } from '../SessionView'
import { TaskWidget } from '../TaskWidget'
import { SystemWidget } from './SystemWidget'
import { FolderBrowser } from '../FolderBrowser'
import { NewSessionModal } from '../NewSessionModal'
import { GroupPickerModal } from '../GroupPickerModal'
import { QuickAIDialogWrapper } from '../../App'
import { encodeProjectPath } from '../ProjectDashboard'
import type { AIQueryContext } from '../../api/client'
import '../../styles/launcher.css'

/** Touch / narrow-viewport check used to decide whether tapping a session
 *  opens a full-screen modal (app-like) vs. navigating to /projects/.../
 *  sessions/<id> (web). Re-evaluated at each tap, not memoized, so rotating
 *  the device or resizing the window always uses the latest decision. */
function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(max-width: 768px)').matches
}

/**
 * Long-press hook — invokes `onLongPress` after ~500ms of continuous
 * touch/mouse-down, and suppresses the following click so a long-press
 * doesn't open the folder/session as a side-effect. Right-click on
 * desktop also triggers it, matching iOS's "haptic touch" mental model.
 */
function useLongPress(onLongPress: (target: HTMLElement) => void, ms = 500) {
  const timerRef = useRef<number | null>(null)
  const firedRef = useRef(false)
  const targetRef = useRef<HTMLElement | null>(null)

  const start = useCallback((el: HTMLElement) => {
    firedRef.current = false
    targetRef.current = el
    timerRef.current = window.setTimeout(() => {
      firedRef.current = true
      if (targetRef.current) onLongPress(targetRef.current)
    }, ms)
  }, [onLongPress, ms])

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => () => cancel(), [cancel])

  return {
    // Spread onto the target element. `onClick` is optional — the wrapper
    // suppresses the click when a long-press fired, then delegates.
    bind: (onClick?: () => void) => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        // Ignore modifier/right-click here — the browser fires
        // `contextmenu` for right-click which we handle separately.
        if (e.button && e.button !== 0) return
        start(e.currentTarget)
      },
      onPointerUp: () => cancel(),
      onPointerLeave: () => cancel(),
      onPointerCancel: () => cancel(),
      onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
        // Desktop right-click and iOS's contextmenu event both fire here.
        e.preventDefault()
        firedRef.current = true
        onLongPress(e.currentTarget)
      },
      onClick: () => {
        if (firedRef.current) {
          firedRef.current = false
          return
        }
        onClick?.()
      },
    }),
  }
}

/**
 * Anchored context menu — positioned near the long-pressed icon. Click
 * outside or Esc dismisses. Rendered at the root so it can escape any
 * `overflow: hidden` container.
 */
interface ContextMenuItem {
  label: string
  icon: React.ReactNode
  onClick: () => void
  destructive?: boolean
  disabled?: boolean
}

function IPhoneContextMenu({
  anchor,
  items,
  onClose,
  header,
}: {
  anchor: DOMRect
  items: ContextMenuItem[]
  onClose: () => void
  header?: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Menu position: anchor's bottom-left, clamped inside viewport with an
  // 8px margin so it never clips off-screen. If it would overflow the
  // bottom, flip above the anchor.
  const style = useMemo<React.CSSProperties>(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const menuW = 240
    const menuH = 40 + items.length * 44 + (header ? 40 : 0)
    let left = anchor.left
    if (left + menuW > vw - 8) left = vw - menuW - 8
    if (left < 8) left = 8
    let top = anchor.bottom + 8
    if (top + menuH > vh - 8) top = Math.max(8, anchor.top - menuH - 8)
    return { position: 'fixed', left, top, width: menuW }
  }, [anchor, items.length, header])

  return (
    <div className="iphone-ctx-backdrop" onClick={onClose}>
      <div
        className="iphone-ctx-menu"
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        {header && <div className="iphone-ctx-header">{header}</div>}
        {items.map((item, i) => (
          <button
            key={i}
            className={`iphone-ctx-item${item.destructive ? ' destructive' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onClick()
            }}
          >
            <span className="iphone-ctx-icon">{item.icon}</span>
            <span className="iphone-ctx-label">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

interface VersionInfo {
  isOutdated: boolean
  currentVersion: string
  projectVersion: string
}

interface ProjectWithSessions extends RegisteredProject {
  sessions: Session[]
  versionInfo: VersionInfo | null
  boards: BoardIndexEntry[]
}

/**
 * iPhone-style home-screen launcher.
 *
 * One folder per project, one app icon per session inside the folder.
 * A waiting-for-input session shows a red badge — the folder also surfaces
 * the count so it's visible without opening anything. Polls the same
 * endpoints the regular dashboard uses (every 5s) so the badge updates
 * automatically as session-watcher hooks fire on the server.
 *
 * Routes to existing session URL on tap, so this is purely a presentation
 * layer over the existing data + navigation.
 */
export function IPhoneLauncher() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<ProjectWithSessions[]>([])
  const [loading, setLoading] = useState(true)
  const [openFolderPath, setOpenFolderPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Header-level bulk state — Add Project modal, Save-All progress + toast,
  // and the manual Refresh button's spin state.
  const [showAddProject, setShowAddProject] = useState(false)
  const [isSavingAll, setIsSavingAll] = useState(false)
  const [saveAllToast, setSaveAllToast] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  // Layer 2/3: context menu + secondary modals (group, new-session).
  const [projectMenu, setProjectMenu] = useState<
    { project: ProjectWithSessions; anchor: DOMRect } | null
  >(null)
  const [sessionMenu, setSessionMenu] = useState<
    { project: ProjectWithSessions; session: Session; anchor: DOMRect } | null
  >(null)
  const [groupModal, setGroupModal] = useState<
    { project: ProjectWithSessions; value: string } | null
  >(null)
  const [newSessionModal, setNewSessionModal] = useState<
    { project: ProjectWithSessions; name: string } | null
  >(null)
  const [reinitializing, setReinitializing] = useState<string | null>(null)
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  // Tapping a session opens it inside a full-screen modal in this same
  // view (app-like) instead of routing away. `isMobile` is captured at
  // open time so rotating the device mid-session doesn't switch the modal
  // shape under the user.
  const [sessionModal, setSessionModal] = useState<{
    project: ProjectWithSessions
    session: Session
    isMobile: boolean
  } | null>(null)
  const [resumingSession, setResumingSession] = useState(false)
  // System terminal — Orka's project-agnostic tmux pane exposed by the
  // dashboard. We fetch its ttyd port once; a `null` port means the
  // terminal isn't running on the server, in which case we hide the icon.
  const [systemTerminalPort, setSystemTerminalPort] = useState<number | null>(null)
  // When set, a fullscreen modal iframes the system terminal — same shape
  // as `sessionModal` but with no project/session context.
  const [terminalModal, setTerminalModal] = useState<{ isMobile: boolean } | null>(null)

  // Aliveness ref lets the manual Refresh handler and the polling loop
  // share the same `loadAll` without a stale-closure risk on unmount.
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const loadAll = useCallback(async () => {
    try {
      const list = await api.listProjects()
      const withSessions = await Promise.all(
        list.map(async (p) => {
          let sessions: Session[] = []
          let versionInfo: VersionInfo | null = null
          let boards: BoardIndexEntry[] = []
          try { sessions = await api.listSessions(p.path) } catch {}
          try { versionInfo = await api.checkProjectVersion(p.path) } catch {}
          // Boards are optional — a project without any board just returns
          // an empty list. Any error (endpoint missing on old servers,
          // etc.) is swallowed so a Classic-only project still loads.
          try { boards = await api.listBoards(p.path) } catch {}
          return { ...p, sessions, versionInfo, boards } as ProjectWithSessions
        })
      )
      if (aliveRef.current) {
        setProjects(withSessions)
        setLoading(false)
      }
    } catch (err: any) {
      if (aliveRef.current) {
        setError(err?.message || 'Failed to load projects')
        setLoading(false)
      }
    }
  }, [])

  // Initial load + 2s poll so the waiting badge updates promptly. 5s was
  // missing notifications whose Notification→PreToolUse window was shorter
  // than the poll. Also refetch on `visibilitychange` because browsers
  // throttle background-tab setInterval to >=1min — a badge arriving while
  // the tab is hidden would otherwise be invisible until manual reload.
  useEffect(() => {
    void loadAll()
    const id = window.setInterval(() => { void loadAll() }, 2000)
    const onVisible = () => { if (document.visibilityState === 'visible') void loadAll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadAll])

  // Esc closes an open folder, matching the native iOS gesture-equivalent.
  useEffect(() => {
    if (!openFolderPath) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenFolderPath(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openFolderPath])

  // Grab the system terminal ttyd port once. A missing / erroring endpoint
  // (dashboard hasn't spun up the terminal yet) leaves the port `null`,
  // which hides the icon — same behavior the mobile FAB on the dashboard
  // uses. Cheap enough that we don't bother polling.
  useEffect(() => {
    api.getSystemTerminal()
      .then(({ port }) => setSystemTerminalPort(port))
      .catch(() => setSystemTerminalPort(null))
  }, [])

  // While a session modal is open, lock the launcher page: no overflow and
  // no overscroll. Otherwise a swipe inside the embedded terminal can
  // bubble to this document and trigger the browser's pull-to-refresh
  // instead of scrolling the terminal. Pairs with `overscroll-behavior`
  // inside terminal-mobile.html for full coverage.
  useEffect(() => {
    if (!sessionModal) return
    const html = document.documentElement
    const body = document.body
    const prev = {
      htmlOverscroll: html.style.overscrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyOverscroll: body.style.overscrollBehavior,
    }
    html.style.overscrollBehavior = 'none'
    body.style.overflow = 'hidden'
    body.style.overscrollBehavior = 'none'
    return () => {
      html.style.overscrollBehavior = prev.htmlOverscroll
      body.style.overflow = prev.bodyOverflow
      body.style.overscrollBehavior = prev.bodyOverscroll
    }
  }, [sessionModal])

  // Same page-lock while the system-terminal modal is open — pull-to-refresh
  // would eat swipes meant for the embedded terminal otherwise.
  useEffect(() => {
    if (!terminalModal) return
    const html = document.documentElement
    const body = document.body
    const prev = {
      htmlOverscroll: html.style.overscrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyOverscroll: body.style.overscrollBehavior,
    }
    html.style.overscrollBehavior = 'none'
    body.style.overflow = 'hidden'
    body.style.overscrollBehavior = 'none'
    return () => {
      html.style.overscrollBehavior = prev.htmlOverscroll
      body.style.overflow = prev.bodyOverflow
      body.style.overscrollBehavior = prev.bodyOverscroll
    }
  }, [terminalModal])

  // Group projects by their `group` string (same model the regular dashboard
  // uses). Projects without a group land in a single "Other" section.
  const sections = useMemo(() => {
    const map = new Map<string, ProjectWithSessions[]>()
    for (const p of projects) {
      const k = p.group || ''
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(p)
    }
    const list = Array.from(map.entries()).map(([key, items]) => ({
      key,
      label: key || 'Other',
      projects: items,
    }))
    list.sort((a, b) => {
      // Pinned ordering: real groups alphabetically, "Other" always last.
      if (a.key === '') return 1
      if (b.key === '') return -1
      return a.label.localeCompare(b.label)
    })
    return list
  }, [projects])

  const openFolderProject = openFolderPath
    ? projects.find((p) => p.path === openFolderPath) ?? null
    : null

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try { await loadAll() } finally { setIsRefreshing(false) }
  }

  const handleAddProject = async (projectPath: string) => {
    if (!projectPath.trim()) return
    try {
      await api.registerProject(projectPath)
      setShowAddProject(false)
      await loadAll()
    } catch (err: any) {
      setError(err.message || 'Failed to add project')
    }
  }

  /**
   * Fan-out `saveAllSessions` per project. Same shape ProjectDashboard uses:
   * per-project errors don't stop the run, and the aggregate toast lists
   * counts + how many projects errored. Cheap safety net for reboots.
   */
  const handleSaveAll = async () => {
    if (isSavingAll || projects.length === 0) return
    setIsSavingAll(true)
    setSaveAllToast(null)
    let totalSaved = 0
    let totalFailed = 0
    let totalBranches = 0
    const projectErrors: string[] = []
    try {
      await Promise.all(
        projects.map(async (p) => {
          try {
            const r = await api.saveAllSessions(p.path)
            totalSaved += r.saved
            totalFailed += r.failed
            totalBranches += r.results.reduce((n, s) => n + s.branchesSaved, 0)
          } catch (err: any) {
            projectErrors.push(`${p.name}: ${err?.message || err}`)
          }
        })
      )
      const parts = [`Saved ${totalSaved} session${totalSaved === 1 ? '' : 's'}`]
      if (totalBranches) parts.push(`${totalBranches} branches`)
      if (totalFailed) parts.push(`${totalFailed} failed`)
      const msg = parts.join(' · ')
      setSaveAllToast(projectErrors.length
        ? `${msg} · ${projectErrors.length} project error(s)`
        : msg)
      await loadAll()
    } catch (err: any) {
      setError(err?.message || 'Failed to save all sessions')
    } finally {
      setIsSavingAll(false)
      setTimeout(() => setSaveAllToast(null), 5000)
    }
  }

  const handleRemoveProject = async (project: ProjectWithSessions) => {
    if (!confirm(`Remove "${project.name}" from Orka? (Files will not be deleted)`)) return
    try {
      await api.unregisterProject(project.path)
      await loadAll()
    } catch (err: any) {
      setError(err.message || 'Failed to remove project')
    }
  }

  const handleSetGroup = async (projectPath: string, group: string | null) => {
    try {
      await api.updateProject(projectPath, { group })
      setGroupModal(null)
      await loadAll()
    } catch (err: any) {
      setError(err.message || 'Failed to update group')
    }
  }

  const handleReinitialize = async (projectPath: string) => {
    setReinitializing(projectPath)
    try {
      await api.reinitializeProject(projectPath)
      await loadAll()
    } catch (err: any) {
      setError(err.message || 'Failed to sync project')
    } finally {
      setReinitializing(null)
    }
  }

  const outdatedCount = projects.filter((p) => p.versionInfo?.isOutdated).length

  const handleSyncAllOutdated = async () => {
    // Sequential — reinitialize hits disk (tmux config + skills install)
    // and we don't want race conditions across projects. Fast enough
    // even for many projects.
    for (const p of projects.filter((p) => p.versionInfo?.isOutdated)) {
      setReinitializing(p.path)
      try { await api.reinitializeProject(p.path) } catch (err: any) {
        setError(`${p.name}: ${err?.message || err}`)
      }
    }
    setReinitializing(null)
    await loadAll()
  }

  const handleCreateSession = async (project: ProjectWithSessions, name: string) => {
    setIsCreatingSession(true)
    try {
      const session = await api.createSession(project.path, name || undefined)
      setNewSessionModal(null)
      await loadAll()
      // Route to the freshly-created session so the user lands directly
      // in its terminal — matches ProjectDashboard's behavior.
      const encoded = encodeProjectPath(project.path)
      navigate(`/projects/${encoded}/sessions/${session.id}`)
    } catch (err: any) {
      setError(err.message || 'Failed to create session')
    } finally {
      setIsCreatingSession(false)
    }
  }

  const handleDeleteSession = async (project: ProjectWithSessions, session: Session) => {
    if (!confirm(`Delete session "${session.name || 'Unnamed'}"? This cannot be undone.`)) return
    try {
      await api.deleteSession(project.path, session.id)
      await loadAll()
    } catch (err: any) {
      setError(err.message || 'Failed to delete session')
    }
  }

  // Existing group names — feeds the group-modal's suggestion chips.
  const existingGroups = useMemo(() => {
    const s = new Set<string>()
    for (const p of projects) if (p.group) s.add(p.group)
    return [...s].sort()
  }, [projects])

  const handleOpenSession = async (project: ProjectWithSessions, session: Session) => {
    setOpenFolderPath(null)
    const isMobile = isMobileViewport()

    // Open the modal immediately with whatever we know; the modal handles
    // a loading state while we resume.
    setSessionModal({ project, session, isMobile })

    // Always call resume — it's idempotent on the server side. If the tmux
    // session is alive it just reconnects (and revives a dead ttyd if
    // needed); if the tmux session was killed externally — by a reboot, a
    // manual `tmux kill-server`, etc. — it recreates it from the stored
    // claude session id. Skipping the resume on `status === active` is
    // unsafe because the in-memory status drifts from the actual process
    // state, which lands the user on a broken terminal with no terminal.
    setResumingSession(true)
    try {
      const resumed = await api.resumeSession(project.path, session.id)
      setSessionModal({ project, session: resumed, isMobile })
    } catch (err) {
      console.error('Failed to resume session for launcher modal:', err)
    } finally {
      setResumingSession(false)
    }
  }

  const handleOpenSystemTerminal = () => {
    // Nothing to resume — the system terminal is a long-lived tmux pane
    // owned by the dashboard, always running when the port is present.
    setTerminalModal({ isMobile: isMobileViewport() })
  }

  return (
    <div className="iphone-launcher">
      <div className="iphone-wallpaper" />

      <header className="iphone-header">
        <Link to="/dashboard" className="iphone-header-back">
          <ArrowLeft size={16} /> Dashboard
        </Link>
        <h1 className="iphone-header-title">Sessions</h1>
        {/* Right-side action cluster. Buttons stay icon-only so the header
            keeps its compact iOS feel; `title` covers tooltip-on-desktop
            and screen-reader intent on mobile. */}
        <div className="iphone-header-actions">
          <button
            className="iphone-header-add"
            onClick={handleRefresh}
            title="Refresh"
            aria-label="Refresh"
            disabled={isRefreshing}
          >
            <RefreshCw size={16} className={isRefreshing ? 'spinning' : ''} />
          </button>
          {/* Bulk "Sync outdated" — only shown when at least one project
              is on an older Orka version. The badge on the button is the
              count of outdated projects, so the user knows at a glance
              how much would be touched. */}
          {outdatedCount > 0 && (
            <button
              className="iphone-header-add outdated"
              onClick={handleSyncAllOutdated}
              title={`Sync ${outdatedCount} outdated project${outdatedCount === 1 ? '' : 's'}`}
              aria-label={`Sync ${outdatedCount} outdated`}
              disabled={reinitializing !== null}
            >
              <RotateCw size={16} className={reinitializing ? 'spinning' : ''} />
              <span className="iphone-header-count">{outdatedCount}</span>
            </button>
          )}
          <button
            className="iphone-header-add"
            onClick={handleSaveAll}
            title={
              projects.length === 0
                ? 'No projects to save'
                : 'Save all sessions in all projects'
            }
            aria-label="Save all sessions"
            disabled={isSavingAll || projects.length === 0}
          >
            <Save size={16} className={isSavingAll ? 'spinning' : ''} />
          </button>
          <button
            className="iphone-header-add"
            onClick={() => setShowAddProject(true)}
            title="Add project"
            aria-label="Add project"
          >
            <Plus size={16} />
          </button>
        </div>
      </header>

      <main className="iphone-screen">
        {loading && <div className="iphone-loading">Loading…</div>}

        {!loading && error && (
          <div className="iphone-error">
            {error}
          </div>
        )}

        {!loading && !error && projects.length === 0 && (
          <div className="iphone-empty">
            <p>No projects yet.</p>
            <Link to="/dashboard" className="iphone-cta">Add one in Dashboard →</Link>
          </div>
        )}

        {/* iOS-style widgets — rendered above the project grid. Only the
            system status widget for now; more can slot in the same
            container without touching the grid layout below. */}
        {!loading && !error && (
          <div className="iphone-widgets">
            <SystemWidget />
          </div>
        )}

        {/* System section — a single icon for the general terminal, shown
            at the top so it's a one-tap target regardless of how many
            project folders live below. Hidden entirely when the server
            has no ttyd port for the system terminal. */}
        {!loading && !error && systemTerminalPort && (
          <section className="iphone-section">
            <div className="iphone-grid">
              <SystemTerminalAppIcon onOpen={handleOpenSystemTerminal} />
            </div>
          </section>
        )}

        {sections.map((section) => (
          <section key={section.key || '__nogroup__'} className="iphone-section">
            {sections.length > 1 && (
              <h2 className="iphone-section-label">{section.label}</h2>
            )}
            <div className="iphone-grid">
              {section.projects.map((project) => (
                <ProjectFolderIcon
                  key={project.path}
                  project={project}
                  onOpen={() => setOpenFolderPath(project.path)}
                  onLongPress={(anchor) => setProjectMenu({ project, anchor })}
                />
              ))}
            </div>
          </section>
        ))}
      </main>

      {openFolderProject && (
        <FolderOverlay
          project={openFolderProject}
          onClose={() => setOpenFolderPath(null)}
          onOpenSession={(s) => handleOpenSession(openFolderProject, s)}
          onLongPressSession={(session, anchor) =>
            setSessionMenu({ project: openFolderProject, session, anchor })
          }
          onNewSession={() => {
            setOpenFolderPath(null)
            setNewSessionModal({ project: openFolderProject, name: '' })
          }}
          onOpenBoard={(b) => {
            setOpenFolderPath(null)
            const encoded = encodeProjectPath(openFolderProject.path)
            navigate(`/projects/${encoded}/boards/${b.id}`)
          }}
          onSetGroup={() => {
            setGroupModal({ project: openFolderProject, value: openFolderProject.group || '' })
          }}
          onSync={() => {
            void handleReinitialize(openFolderProject.path)
          }}
          onRemove={() => {
            void handleRemoveProject(openFolderProject).then(() => setOpenFolderPath(null))
          }}
          reinitializing={reinitializing === openFolderProject.path}
        />
      )}

      {sessionModal && sessionModal.isMobile && (
        <MobileSessionModal
          project={sessionModal.project}
          session={sessionModal.session}
          resuming={resumingSession}
          onClose={() => setSessionModal(null)}
        />
      )}

      {sessionModal && !sessionModal.isMobile && (
        <DesktopSessionModal
          project={sessionModal.project}
          session={sessionModal.session}
          resuming={resumingSession}
          onClose={() => setSessionModal(null)}
        />
      )}

      {terminalModal && systemTerminalPort && (
        <SystemTerminalModal
          port={systemTerminalPort}
          isMobile={terminalModal.isMobile}
          onClose={() => setTerminalModal(null)}
        />
      )}

      {/* Add Project modal — reuses the same FolderBrowser the dashboard
          uses, so `orka init` runs against whatever path the user picks. */}
      {showAddProject && (
        <div className="modal-overlay" onClick={() => setShowAddProject(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <FolderBrowser
              onSelect={handleAddProject}
              onCancel={() => setShowAddProject(false)}
            />
          </div>
        </div>
      )}

      {/* Save-All aggregated toast — hidden after 5s. */}
      {saveAllToast && (
        <div className="iphone-toast">
          <Save size={14} /> {saveAllToast}
        </div>
      )}

      {/* Error banner — same lifecycle as the dashboard: user-dismissible,
          shown until they click Dismiss. */}
      {error && (
        <div className="iphone-error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Project context menu (long-press on a folder icon). */}
      {projectMenu && (
        <IPhoneContextMenu
          anchor={projectMenu.anchor}
          onClose={() => setProjectMenu(null)}
          header={
            <div>
              <div className="iphone-ctx-title">{projectMenu.project.name}</div>
              <div className="iphone-ctx-sub">
                {projectMenu.project.versionInfo
                  ? `v${projectMenu.project.versionInfo.projectVersion}${
                      projectMenu.project.versionInfo.isOutdated
                        ? ` → v${projectMenu.project.versionInfo.currentVersion}`
                        : ''
                    }`
                  : projectMenu.project.path}
              </div>
            </div>
          }
          items={[
            {
              label: 'New Session',
              icon: <Plus size={16} />,
              onClick: () => setNewSessionModal({ project: projectMenu.project, name: '' }),
            },
            ...(projectMenu.project.versionInfo?.isOutdated
              ? [{
                  label: reinitializing === projectMenu.project.path ? 'Syncing…' : 'Sync Version',
                  icon: <RotateCw size={16} className={reinitializing === projectMenu.project.path ? 'spinning' : ''} />,
                  onClick: () => handleReinitialize(projectMenu.project.path),
                  disabled: reinitializing === projectMenu.project.path,
                }]
              : []),
            {
              label: projectMenu.project.group ? `Group: ${projectMenu.project.group}` : 'Set Group',
              icon: <Tag size={16} />,
              onClick: () =>
                setGroupModal({ project: projectMenu.project, value: projectMenu.project.group || '' }),
            },
            {
              label: 'Remove Project',
              icon: <Trash2 size={16} />,
              onClick: () => handleRemoveProject(projectMenu.project),
              destructive: true,
            },
          ]}
        />
      )}

      {/* Session context menu (long-press on a session icon). */}
      {sessionMenu && (
        <IPhoneContextMenu
          anchor={sessionMenu.anchor}
          onClose={() => setSessionMenu(null)}
          header={
            <div>
              <div className="iphone-ctx-title">{sessionMenu.session.name || 'Unnamed'}</div>
              <div className="iphone-ctx-sub">
                {sessionMenu.session.status === 'active' ? 'Active' : 'Saved'}
                {sessionMenu.session.lastActivity && ` · ${new Date(sessionMenu.session.lastActivity).toLocaleString()}`}
              </div>
            </div>
          }
          items={[
            {
              label: 'Delete Session',
              icon: <Trash2 size={16} />,
              onClick: () => handleDeleteSession(sessionMenu.project, sessionMenu.session),
              destructive: true,
            },
          ]}
        />
      )}

      {/* Group / tag picker — shared component used from both the dashboard
          and the launcher folder overlay for consistency. */}
      {groupModal && (
        <GroupPickerModal
          projectName={groupModal.project.name}
          currentGroup={groupModal.project.group || null}
          existingGroups={existingGroups}
          onClose={() => setGroupModal(null)}
          onApply={(value) => handleSetGroup(groupModal.project.path, value)}
        />
      )}

      {/* New Session modal — unified picker (Classic | Board). */}
      {newSessionModal && (
        <NewSessionModal
          projectPath={newSessionModal.project.path}
          projectName={newSessionModal.project.name}
          onCancel={() => setNewSessionModal(null)}
          onCreated={(result) => {
            const project = newSessionModal.project
            setNewSessionModal(null)
            const encoded = encodeProjectPath(project.path)
            if (result.kind === 'classic') {
              navigate(`/projects/${encoded}/sessions/${result.sessionId}`)
            } else {
              navigate(`/projects/${encoded}/boards/${result.boardId}`)
            }
            void loadAll()
          }}
        />
      )}
    </div>
  )
}

/* ----- Folder icon (one per project) ---------------------------------- */

function ProjectFolderIcon({
  project,
  onOpen,
  onLongPress,
}: {
  project: ProjectWithSessions
  onOpen: () => void
  onLongPress: (anchor: DOMRect) => void
}) {
  const waitingCount = project.sessions.filter((s) => s.waitingForInput).length
  const outdated = project.versionInfo?.isOutdated

  // Preview thumbnails — iOS folders show up to 9 small icons in a 3×3
  // grid. Boards get slotted in first (they're first-class citizens in
  // the folder, not corner decorations) then sessions fill the rest. Each
  // thumb is discriminated by kind so the render can style them
  // differently (board = purple gradient + Kanban glyph, session = the
  // seed-colored letter tile).
  type Thumb =
    | { kind: 'board'; id: string; label: string }
    | { kind: 'session'; id: string; label: string; waiting: boolean }
  const thumbs: Thumb[] = [
    ...project.boards.map((b) => ({ kind: 'board' as const, id: b.id, label: b.name })),
    ...project.sessions.map((s) => ({
      kind: 'session' as const,
      id: s.id,
      label: s.name || s.id,
      waiting: !!s.waitingForInput,
    })),
  ]
  const preview = thumbs.slice(0, 9)

  const long = useLongPress((el) => onLongPress(el.getBoundingClientRect()))

  return (
    <button
      className="iphone-app"
      aria-label={`Open ${project.name}`}
      {...long.bind(onOpen)}
    >
      <div className="iphone-icon iphone-folder">
        <div className="iphone-folder-grid">
          {preview.map((t) =>
            t.kind === 'board' ? (
              <div
                key={`b-${t.id}`}
                className="iphone-folder-thumb board"
                title={`Board: ${t.label}`}
              >
                <Kanban size={9} />
              </div>
            ) : (
              <div
                key={`s-${t.id}`}
                className={`iphone-folder-thumb${t.waiting ? ' waiting' : ''}`}
                style={{ background: colorFor(t.label) }}
                title={t.label}
              >
                <span>{initial(t.label || 'S')}</span>
              </div>
            )
          )}
          {preview.length === 0 && (
            <span className="iphone-folder-empty">empty</span>
          )}
        </div>
        {waitingCount > 0 && (
          <span className="iphone-badge" title={`${waitingCount} session(s) waiting for input`}>
            {waitingCount > 99 ? '99+' : waitingCount}
          </span>
        )}
        {/* Small amber dot when the project's tmux/CLI config is on an
            older Orka version — same signal the dashboard's Sync button
            exposes, but as a passive indicator. Long-press to Sync. */}
        {outdated && (
          <span
            className="iphone-badge outdated-dot"
            title={`Outdated (v${project.versionInfo?.projectVersion}) — open folder to sync`}
          />
        )}
      </div>
      <span className="iphone-app-label">{project.name}</span>
    </button>
  )
}

/* ----- Folder overlay (sessions inside) ------------------------------- */

function FolderOverlay({
  project,
  onClose,
  onOpenSession,
  onLongPressSession,
  onNewSession,
  onOpenBoard,
  onSetGroup,
  onSync,
  onRemove,
  reinitializing,
}: {
  project: ProjectWithSessions
  onClose: () => void
  onOpenSession: (session: Session) => void
  onLongPressSession: (session: Session, anchor: DOMRect) => void
  onNewSession: () => void
  onOpenBoard: (board: BoardIndexEntry) => void
  onSetGroup: () => void
  onSync: () => void
  onRemove: () => void
  reinitializing: boolean
}) {
  const outdated = project.versionInfo?.isOutdated
  const versionLabel = project.versionInfo
    ? outdated
      ? `v${project.versionInfo.projectVersion} → v${project.versionInfo.currentVersion}`
      : `v${project.versionInfo.projectVersion}`
    : null

  return (
    <div
      className="iphone-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="iphone-overlay-card">
        <header className="iphone-overlay-header">
          <div className="iphone-overlay-title-block">
            <h2>{project.name}</h2>
            <div className="iphone-overlay-subline">
              {/* Group tag chip — always visible, tap to change. */}
              <button
                className={`iphone-overlay-tag ${project.group ? 'set' : 'unset'}`}
                onClick={onSetGroup}
                title="Set / change group"
              >
                <Tag size={11} />
                {project.group || 'Set group'}
              </button>
              {versionLabel && (
                <span className={`iphone-overlay-version ${outdated ? 'outdated' : ''}`}>
                  {versionLabel}
                </span>
              )}
            </div>
          </div>
          <div className="iphone-overlay-header-actions">
            {/* Sync button — always visible. Colored amber when the
                project's on an older Orka version, subtle otherwise. Both
                states run the same reinitialize path so the user never
                has to bump the Orka version just to pull fresh skills. */}
            <button
              className={`iphone-overlay-sync ${outdated ? '' : 'passive'}`}
              onClick={onSync}
              disabled={reinitializing}
              title={
                outdated
                  ? `Sync project to Orka v${project.versionInfo?.currentVersion} (installs latest skills + tmux theme)`
                  : 'Refresh skills and re-run project init (no version change)'
              }
              aria-label={outdated ? 'Sync outdated' : 'Refresh skills'}
            >
              <RotateCw size={14} className={reinitializing ? 'spinning' : ''} />
              {reinitializing ? 'Syncing…' : outdated ? 'Sync' : 'Refresh'}
            </button>
            <button
              className="iphone-overlay-new"
              onClick={onNewSession}
              title="New session"
              aria-label="New session"
            >
              <Plus size={14} /> New
            </button>
            <button
              className="iphone-overlay-remove"
              onClick={onRemove}
              title="Remove project from Orka"
              aria-label="Remove"
            >
              <Trash2 size={14} />
            </button>
            <button className="iphone-overlay-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </header>
        {/* Boards live at the top of the folder — they are the entry
            point to a whole Kanban + master terminal, so they deserve
            visibility over individual sessions. */}
        {project.boards.length > 0 && (
          <>
            <div className="iphone-overlay-section-label">Boards</div>
            <div className="iphone-grid iphone-overlay-grid iphone-overlay-boards">
              {project.boards.map((b) => (
                <BoardAppIcon key={b.id} board={b} onOpen={() => onOpenBoard(b)} />
              ))}
            </div>
          </>
        )}

        {project.sessions.length === 0 && project.boards.length === 0 ? (
          <div className="iphone-overlay-empty">
            No sessions or boards in this project yet.
            <button className="iphone-cta" onClick={onNewSession}>Create the first one →</button>
          </div>
        ) : (
          <>
            {project.sessions.length > 0 && (
              <div className="iphone-overlay-section-label">Sessions</div>
            )}
            {project.sessions.length > 0 && (
              <div className="iphone-grid iphone-overlay-grid">
                {project.sessions.map((s) => (
                  <SessionAppIcon
                    key={s.id}
                    session={s}
                    onOpen={() => onOpenSession(s)}
                    onLongPress={(anchor) => onLongPressSession(s, anchor)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * App icon for a Board. Distinct from `SessionAppIcon` — uses a Kanban
 * glyph and a fixed teal gradient so boards are visually separate from
 * per-session icons in the folder overlay.
 */
function BoardAppIcon({ board, onOpen }: { board: BoardIndexEntry; onOpen: () => void }) {
  return (
    <button className="iphone-app" onClick={onOpen} aria-label={`Open board ${board.name}`}>
      <div className="iphone-icon iphone-app-icon iphone-board-icon">
        <Kanban size={28} strokeWidth={2.2} />
      </div>
      <span className="iphone-app-label">{board.name}</span>
    </button>
  )
}

/* ----- Session app icon ----------------------------------------------- */

function SessionAppIcon({
  session,
  onOpen,
  onLongPress,
}: {
  session: Session
  onOpen: () => void
  onLongPress: (anchor: DOMRect) => void
}) {
  const color = colorFor(session.name || session.id)
  const isActive = session.status === 'active'
  const forks = session.forks?.length ?? 0
  const long = useLongPress((el) => onLongPress(el.getBoundingClientRect()))
  return (
    <button
      className="iphone-app"
      aria-label={`Open session ${session.name || 'Unnamed'}`}
      {...long.bind(onOpen)}
    >
      <div
        className={`iphone-icon iphone-app-icon${session.waitingForInput ? ' waiting' : ''}${isActive ? '' : ' saved'}`}
        style={{ background: gradientFor(color) }}
      >
        <span className="iphone-app-letter">{initial(session.name || 'S')}</span>
        {forks > 0 && (
          <span className="iphone-app-forks" title={`${forks} fork(s)`}>
            <GitBranch size={10} /> {forks}
          </span>
        )}
        {session.waitingForInput && (
          <span
            className="iphone-badge dot"
            title={session.waitingMessage || 'Waiting for input'}
          />
        )}
      </div>
      <span className="iphone-app-label">{session.name || 'Unnamed'}</span>
    </button>
  )
}

/* ----- System-terminal app icon --------------------------------------- */

/**
 * Single home-screen icon for the general (project-agnostic) terminal.
 * Same footprint as `SessionAppIcon` so it sits naturally in the iOS-style
 * grid, but with a Terminal glyph and a fixed gradient so it reads as a
 * "system" icon rather than a session.
 */
function SystemTerminalAppIcon({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      className="iphone-app"
      onClick={onOpen}
      aria-label="Open System Terminal"
    >
      <div className="iphone-icon iphone-app-icon iphone-terminal-icon">
        <Terminal size={28} strokeWidth={2.2} />
      </div>
      <span className="iphone-app-label">Terminal</span>
    </button>
  )
}

/* ----- System-terminal modal ------------------------------------------ */

/**
 * Fullscreen modal that embeds the ttyd iframe for the system terminal.
 * Mirrors `MobileSessionModal` / `DesktopSessionModal`'s shape but skips
 * project/session bookkeeping — the terminal is stateless from the
 * launcher's point of view (owned by the dashboard). On mobile we
 * intentionally use the compact `/terminal/:port` mobile page; on
 * desktop we pass `?desktop=1` so xterm gets the desktop layout (same
 * flag ProjectDashboard uses).
 */
function SystemTerminalModal({
  port,
  isMobile,
  onClose,
}: {
  port: number
  isMobile: boolean
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const url = `/terminal/${port}${isMobile ? '' : '?desktop=1'}`

  if (isMobile) {
    return (
      <div className="iphone-session-modal" role="dialog" aria-modal="true">
        <header className="iphone-session-modal-header">
          <button
            className="iphone-session-modal-close"
            onClick={onClose}
            aria-label="Close terminal"
          >
            <X size={18} />
          </button>
          <div className="iphone-session-modal-titles">
            <div className="iphone-session-modal-project">System</div>
            <div className="iphone-session-modal-session">Terminal</div>
          </div>
          {/* Placeholder to balance the header's flex layout — same trick
              MobileSessionModal uses for its "more options" button. */}
          <span style={{ width: 34 }} aria-hidden="true" />
        </header>
        <div className="iphone-session-modal-body">
          <iframe
            src={url}
            title="System Terminal"
            className="iphone-session-modal-iframe"
            allow="clipboard-read; clipboard-write; microphone"
          />
        </div>
      </div>
    )
  }

  return (
    <div className="iphone-desktop-session-modal" role="dialog" aria-modal="true">
      <button
        className="iphone-desktop-session-modal-close"
        onClick={onClose}
        aria-label="Close terminal"
        title="Close (Esc)"
      >
        <X size={16} />
      </button>
      <iframe
        src={url}
        title="System Terminal"
        className="iphone-session-modal-iframe"
        allow="clipboard-read; clipboard-write; microphone"
        style={{ width: '100%', height: '100%', border: 0 }}
      />
    </div>
  )
}

/* ----- Mobile session modal (app-like full-screen) -------------------- */

/**
 * Slides up from the bottom and fills the viewport with the embedded mobile
 * terminal page (the same one SessionView uses on phones). Tapping the X
 * (or pressing Esc on devices with a keyboard) returns to the launcher
 * without changing the URL — so the experience feels like opening / closing
 * an iOS app rather than navigating between pages.
 *
 * Iframe permissions mirror the SessionView iframe (microphone + clipboard)
 * so STT and copy/paste continue to work from inside the launcher modal.
 */
function MobileSessionModal({
  project,
  session,
  resuming,
  onClose,
}: {
  project: ProjectWithSessions
  session: Session
  resuming: boolean
  onClose: () => void
}) {
  // The modal opens directly into the custom mobile terminal iframe (the
  // primary use case). The header's LayoutGrid button toggles to the
  // full `<SessionView>` mobile rendering — the same cards page the
  // routed `/projects/:p/sessions/:id` shows on phones — so the user can
  // reach the Code / Files / Knowledge tabs without leaving the launcher.
  const [view, setView] = useState<'terminal' | 'tabs'>('terminal')

  // Esc closes — convenient when testing on desktop in mobile viewport mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Manual ack of the waiting flag the moment the user "enters the app",
  // matching SessionPage's behavior on web routes.
  useEffect(() => {
    if (session.waitingForInput) {
      void api.acknowledgeWaiting(project.path, session.id)
    }
    // We want this to fire once per opened session id, not on every poll
    // update of the parent state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  const terminalUrl = session.ttydPort
    ? `/terminal/${session.ttydPort}?project=${btoa(project.path)}&session=${session.id}`
    : null

  return (
    <div className="iphone-session-modal" role="dialog" aria-modal="true">
      {/* Header is hidden in 'tabs' view because SessionView brings its
          own mobile header — having two stacked would feel cluttered. */}
      {view === 'terminal' && (
        <header className="iphone-session-modal-header">
          <button
            className="iphone-session-modal-close"
            onClick={onClose}
            aria-label="Close session"
          >
            <X size={18} />
          </button>
          <div className="iphone-session-modal-titles">
            <div className="iphone-session-modal-project">{project.name}</div>
            <div className="iphone-session-modal-session">{session.name || 'Unnamed'}</div>
          </div>
          <button
            className="iphone-session-modal-close"
            onClick={() => setView('tabs')}
            aria-label="Open Code / Files / Knowledge tabs"
            title="More options"
          >
            <LayoutGrid size={16} />
          </button>
        </header>
      )}

      <div className="iphone-session-modal-body">
        {resuming || !terminalUrl ? (
          <div className="iphone-session-modal-loading">
            <div className="iphone-session-modal-spinner" />
            <p>{resuming ? 'Resuming session…' : 'Preparing terminal…'}</p>
          </div>
        ) : view === 'terminal' ? (
          <iframe
            src={terminalUrl}
            title={session.name || 'Terminal'}
            className="iphone-session-modal-iframe"
            allow="clipboard-read; clipboard-write; microphone"
          />
        ) : (
          // SessionView on phones renders its mobile-cards layout
          // (Terminal / Code / Files / Knowledge action cards). Its back
          // button returns us to the direct terminal iframe; "home"
          // closes the whole modal.
          <SessionView
            project={project}
            session={session}
            onBack={() => setView('terminal')}
            onGoHome={onClose}
          />
        )}
      </div>
    </div>
  )
}

/* ----- Desktop session modal (full SessionView in a popup) ----------- */

/**
 * Full-screen popup containing the regular `<SessionView>` — same component
 * the routed `/projects/:p/sessions/:id` page uses, including its Terminal /
 * Code / Files / Knowledge tabs. We wire `onBack` / `onGoHome` to close
 * the modal so the existing back button feels natural without changing
 * the URL.
 *
 * SessionView falls back to internal `localTab` state when no `onTabChange`
 * is provided, so tab switches stay local to the modal and don't pollute
 * `/launcher` with search params.
 */
function DesktopSessionModal({
  project,
  session,
  resuming,
  onClose,
}: {
  project: ProjectWithSessions
  session: Session
  resuming: boolean
  onClose: () => void
}) {
  // Esc closes — keeps the keyboard escape hatch even when SessionView's
  // header back button is not yet rendered (loading state).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (session.waitingForInput) {
      void api.acknowledgeWaiting(project.path, session.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  // The `GlobalProjectWidgets` in App.tsx (TaskWidget + Cmd+K dialog +
  // copy-from-terminal Cmd+L) only mount on `/projects/...` routes — so on
  // `/launcher` they're absent. Mount them locally inside the modal so the
  // same shortcuts and the floating speed-dial keep working when a session
  // is opened from the launcher. contextType is fixed to 'terminal'
  // because SessionView starts on the terminal tab and the modal doesn't
  // mirror its internal tab state into URL params.
  const getContext = useCallback(async (): Promise<Omit<AIQueryContext, 'type'>> => {
    const base: Omit<AIQueryContext, 'type'> = { projectPath: project.path }
    if (session.main?.tmuxPaneId) {
      return { ...base, terminalPaneId: session.main.tmuxPaneId }
    }
    return base
  }, [project.path, session.main?.tmuxPaneId])

  return (
    <div className="iphone-desktop-session-modal" role="dialog" aria-modal="true">
      {/* Floating close affordance — SessionView already has its own back
          button (wired to onClose below), but on the loading state there's
          no UI yet, so the floating X guarantees a way out at any time. */}
      <button
        className="iphone-desktop-session-modal-close"
        onClick={onClose}
        aria-label="Close session"
        title="Close (Esc)"
      >
        <X size={16} />
      </button>

      {resuming ? (
        <div className="iphone-session-modal-loading">
          <div className="iphone-session-modal-spinner" />
          <p>Resuming session…</p>
        </div>
      ) : (
        <SessionView
          project={project}
          session={session}
          onBack={onClose}
          onGoHome={onClose}
        />
      )}

      {/* Per-project widgets (speed-dial, Cmd+L copy-from-terminal,
          Cmd+K quick AI). Unmounted automatically when modal closes.
          `sessionId` is passed explicitly because the URL stays on
          /launcher — getSessionIdFromUrl() would return null here. */}
      <TaskWidget projectPath={project.path} sessionId={session.id} />
      <QuickAIDialogWrapper
        contextType="terminal"
        contextLabel="Terminal"
        getContext={getContext}
      />
    </div>
  )
}

/* ----- Helpers -------------------------------------------------------- */

function initial(name: string): string {
  const trimmed = (name || '').trim()
  if (!trimmed) return '·'
  // Prefer the first character of the first word (after stripping
  // session-* prefixes some sessions get from the CLI).
  const clean = trimmed.replace(/^session[-_]?/i, '').trim() || trimmed
  return clean.slice(0, 1).toUpperCase()
}

/** Deterministic palette pick from a string so each project / session keeps
 *  the same color across reloads without state. */
const PALETTE = ['#89b4fa', '#f38ba8', '#a6e3a1', '#f9e2af', '#cba6f7', '#94e2d5', '#fab387', '#eba0ac']
function colorFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function gradientFor(color: string): string {
  // Lighter top-left → original bottom-right for a glossy app-icon feel.
  return `linear-gradient(135deg, ${shade(color, 1.15)} 0%, ${color} 55%, ${shade(color, 0.78)} 100%)`
}

/** Multiply each RGB channel by `f`, clamped — light/dark of a hex color
 *  without pulling in a color library. */
function shade(hex: string, f: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return hex
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
  const r = clamp(parseInt(m[1], 16) * f)
  const g = clamp(parseInt(m[2], 16) * f)
  const b = clamp(parseInt(m[3], 16) * f)
  return `rgb(${r}, ${g}, ${b})`
}
