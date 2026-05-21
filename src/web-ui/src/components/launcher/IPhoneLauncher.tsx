import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, GitBranch, Plus } from 'lucide-react'
import { api, type RegisteredProject, type Session } from '../../api/client'
import { encodeProjectPath } from '../ProjectDashboard'
import '../../styles/launcher.css'

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
  const navigate = useNavigate()
  const [projects, setProjects] = useState<ProjectWithSessions[]>([])
  const [loading, setLoading] = useState(true)
  const [openFolderPath, setOpenFolderPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Initial load + lightweight 5s poll so the waiting badge updates without
  // a manual refresh. Stops on unmount.
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
    const id = window.setInterval(load, 5000)
    return () => {
      alive = false
      window.clearInterval(id)
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

  const handleOpenSession = (projectPath: string, sessionId: string) => {
    setOpenFolderPath(null)
    navigate(`/projects/${encodeProjectPath(projectPath)}/sessions/${sessionId}`)
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
          onOpenSession={(sid) => handleOpenSession(openFolderProject.path, sid)}
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
  const activeCount = project.sessions.filter((s) => s.status === 'active').length
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
      {activeCount > 0 && (
        <span className="iphone-active-pill" title={`${activeCount} active`}>
          <span className="iphone-active-dot" />
          {activeCount}
        </span>
      )}
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
  onOpenSession: (sessionId: string) => void
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
              <SessionAppIcon key={s.id} session={s} onOpen={() => onOpenSession(s.id)} />
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
