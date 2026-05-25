import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, GitBranch, LayoutGrid, Plus, X } from 'lucide-react'
import { api, type RegisteredProject, type Session } from '../../api/client'
import { SessionView } from '../SessionView'
import { TaskWidget } from '../TaskWidget'
import { QuickAIDialogWrapper } from '../../App'
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

interface ProjectWithSessions extends RegisteredProject {
  sessions: Session[]
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
  const [projects, setProjects] = useState<ProjectWithSessions[]>([])
  const [loading, setLoading] = useState(true)
  const [openFolderPath, setOpenFolderPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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

  // Initial load + 2s poll so the waiting badge updates promptly. 5s was
  // missing notifications whose Notification→PreToolUse window was shorter
  // than the poll. Also refetch on `visibilitychange` because browsers
  // throttle background-tab setInterval to >=1min — a badge arriving while
  // the tab is hidden would otherwise be invisible until manual reload.
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const list = await api.listProjects()
        const withSessions = await Promise.all(
          list.map(async (p) => {
            try {
              const sessions = await api.listSessions(p.path)
              return { ...p, sessions } as ProjectWithSessions
            } catch {
              return { ...p, sessions: [] } as ProjectWithSessions
            }
          })
        )
        if (alive) {
          setProjects(withSessions)
          setLoading(false)
        }
      } catch (err: any) {
        if (alive) {
          setError(err?.message || 'Failed to load projects')
          setLoading(false)
        }
      }
    }
    void load()
    const id = window.setInterval(load, 2000)
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // Esc closes an open folder, matching the native iOS gesture-equivalent.
  useEffect(() => {
    if (!openFolderPath) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenFolderPath(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openFolderPath])

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

  const handleOpenSession = async (project: ProjectWithSessions, session: Session) => {
    setOpenFolderPath(null)
    const isMobile = isMobileViewport()

    // Open the modal immediately with whatever we know; the modal handles
    // a loading state while we (maybe) resume. Saved sessions need a
    // resume to get a fresh ttydPort before the terminal can render;
    // active sessions already have it and skip the round-trip.
    setSessionModal({ project, session, isMobile })

    const needsResume = session.status !== 'active' || !session.ttydPort
    if (needsResume) {
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
  }

  return (
    <div className="iphone-launcher">
      <div className="iphone-wallpaper" />

      <header className="iphone-header">
        <Link to="/dashboard" className="iphone-header-back">
          <ArrowLeft size={16} /> Dashboard
        </Link>
        <h1 className="iphone-header-title">Sessions</h1>
        <Link to="/dashboard" className="iphone-header-add" title="Add project">
          <Plus size={16} />
        </Link>
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
    </div>
  )
}

/* ----- Folder icon (one per project) ---------------------------------- */

function ProjectFolderIcon({
  project,
  onOpen,
}: {
  project: ProjectWithSessions
  onOpen: () => void
}) {
  const waitingCount = project.sessions.filter((s) => s.waitingForInput).length
  // Preview thumbnails — iOS folders show up to 9 small icons in a 3×3 grid.
  const preview = project.sessions.slice(0, 9)

  return (
    <button className="iphone-app" onClick={onOpen} aria-label={`Open ${project.name}`}>
      <div className="iphone-icon iphone-folder">
        <div className="iphone-folder-grid">
          {preview.map((s) => (
            <div
              key={s.id}
              className={`iphone-folder-thumb${s.waitingForInput ? ' waiting' : ''}`}
              style={{ background: colorFor(s.name || s.id) }}
            >
              <span>{initial(s.name || 'S')}</span>
            </div>
          ))}
          {preview.length === 0 && (
            <span className="iphone-folder-empty">empty</span>
          )}
        </div>
        {waitingCount > 0 && (
          <span className="iphone-badge" title={`${waitingCount} session(s) waiting for input`}>
            {waitingCount > 99 ? '99+' : waitingCount}
          </span>
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
}: {
  project: ProjectWithSessions
  onClose: () => void
  onOpenSession: (session: Session) => void
}) {
  return (
    <div
      className="iphone-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="iphone-overlay-card">
        <header className="iphone-overlay-header">
          <h2>{project.name}</h2>
          <button className="iphone-overlay-close" onClick={onClose} aria-label="Close">✕</button>
        </header>
        {project.sessions.length === 0 ? (
          <div className="iphone-overlay-empty">
            No sessions in this project yet.
            <Link to="/dashboard" className="iphone-cta">Open dashboard →</Link>
          </div>
        ) : (
          <div className="iphone-grid iphone-overlay-grid">
            {project.sessions.map((s) => (
              <SessionAppIcon key={s.id} session={s} onOpen={() => onOpenSession(s)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ----- Session app icon ----------------------------------------------- */

function SessionAppIcon({ session, onOpen }: { session: Session; onOpen: () => void }) {
  const color = colorFor(session.name || session.id)
  const isActive = session.status === 'active'
  const forks = session.forks?.length ?? 0
  return (
    <button className="iphone-app" onClick={onOpen} aria-label={`Open session ${session.name || 'Unnamed'}`}>
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
