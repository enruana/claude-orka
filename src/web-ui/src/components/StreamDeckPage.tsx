import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ChevronLeft, ChevronRight,
  Smartphone, Tablet, Monitor, HardDrive, HelpCircle,
  LayoutGrid, Terminal, Mic, Home, Activity, History,
  Send, Zap, Newspaper, RefreshCw, Play, X,
  Kanban, Code, FolderOpen, Network, Pencil,
} from 'lucide-react'
import {
  api,
  type DeckClientPublic, type DeckDevice,
  type RegisteredProject, type Session, type BoardIndexEntry, type BoardTask,
} from '../api/client'
import { useDeck, setPersistentClientName } from '../utils/deckClient'
import { AgentActivityDot, type AgentActivitySignals } from './AgentActivityDot'
import { encodeProjectPath } from './ProjectDashboard'
import '../styles/stream-deck.css'

const TILES_PER_PAGE_FALLBACK = 12
const FAVORITES_KEY = 'orka-deck-favorites'
const RECENTS_MAX = 8

type NavPath = string

interface DeckFavorite {
  id: string
  label: string
  subtitle?: string
  tint: string
  iconName: string
  path: NavPath
  count: number
  lastUsedAt: number
}

function loadFavorites(): DeckFavorite[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((f) => typeof f?.id === 'string' && typeof f?.path === 'string')
  } catch { return [] }
}

function saveFavorites(list: DeckFavorite[]): void {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(list)) } catch { /* drop */ }
}

/**
 * Stream Deck: drive navigation and actions on another Orka tab (Linux
 * desktop, iPad, iPhone) from this one. Roster comes from the same
 * `/api/deck/live` WS the ambient DeckClient uses.
 */
export function StreamDeckPage() {
  const navigate = useNavigate()

  const deck = useDeck()
  const selfId = deck.clientId
  const [restRoster, setRestRoster] = useState<DeckClientPublic[] | null>(null)
  // Merge WS + REST — WS is source of truth when we have it, REST fills
  // in the gap right after mount and covers cross-tab broadcasts that
  // arrived before this tab's WS connected.
  const roster = useMemo(() => {
    const wsList = deck.roster
    const restList = restRoster || []
    if (wsList.length >= restList.length) return wsList
    const merged = new Map<string, DeckClientPublic>()
    for (const c of restList) merged.set(c.clientId, c)
    for (const c of wsList) merged.set(c.clientId, c)
    return [...merged.values()]
  }, [deck.roster, restRoster])

  useEffect(() => {
    let stopped = false
    const pull = async () => {
      try {
        const res = await api.getDeckClients()
        if (!stopped) setRestRoster(res.clients)
      } catch { /* drop */ }
    }
    void pull()
    const iv = window.setInterval(pull, 4000)
    return () => { stopped = true; window.clearInterval(iv) }
  }, [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [projects, setProjects] = useState<RegisteredProject[]>([])
  const [projectDetail, setProjectDetail] = useState<
    { project: RegisteredProject; sessions: Session[]; boards: BoardIndexEntry[] } | null
  >(null)
  const [boardDetail, setBoardDetail] = useState<
    { project: RegisteredProject; board: BoardIndexEntry; tasks: BoardTask[] } | null
  >(null)
  const [page, setPage] = useState(0)
  const [tilesPerPage, setTilesPerPage] = useState(TILES_PER_PAGE_FALLBACK)
  const [favorites, setFavorites] = useState<DeckFavorite[]>(() => loadFavorites())
  const [quickText, setQuickText] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [renamingClient, setRenamingClient] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')

  useEffect(() => {
    api.listProjects().then(setProjects).catch(() => setProjects([]))
  }, [])

  const controllable = useMemo(() => roster.filter((c) => c.clientId !== selfId), [roster, selfId])
  const selected = useMemo(
    () => controllable.find((c) => c.clientId === selectedId) || null,
    [controllable, selectedId],
  )

  useEffect(() => {
    if (!selectedId && controllable.length > 0) setSelectedId(controllable[0].clientId)
    if (selectedId && !controllable.some((c) => c.clientId === selectedId)) setSelectedId(null)
  }, [controllable, selectedId])

  useEffect(() => {
    if (!projectDetail) return
    api.getProject(projectDetail.project.path)
      .then((p) => api.listBoards(p.path).then((boards) => ({ p, boards })))
      .then(({ p, boards }) => {
        setProjectDetail({ project: p, sessions: p.sessions || [], boards })
      })
      .catch(() => { /* keep old */ })
  }, [projectDetail?.project.path])

  useEffect(() => {
    if (!boardDetail) return
    api.listBoardTasks(boardDetail.project.path, boardDetail.board.id)
      .then((tasks) => setBoardDetail((prev) => prev ? { ...prev, tasks } : prev))
      .catch(() => { /* keep old */ })
  }, [boardDetail?.board.id])

  async function relay(cmd: Parameters<typeof api.sendDeckCommand>[1], label: string) {
    if (!selected) return
    setBusyAction(label)
    try { await api.sendDeckCommand(selected.clientId, cmd) }
    catch (err) { console.warn('[deck] command failed', err) }
    finally { setBusyAction(null) }
  }

  const recordFavorite = (fav: Omit<DeckFavorite, 'count' | 'lastUsedAt'>) => {
    setFavorites((prev) => {
      const now = Date.now()
      const hit = prev.find((f) => f.id === fav.id)
      const next = hit
        ? prev.map((f) => f.id === fav.id ? { ...f, ...fav, count: f.count + 1, lastUsedAt: now } : f)
        : [...prev, { ...fav, count: 1, lastUsedAt: now }]
      saveFavorites(next)
      return next
    })
  }

  const removeFavorite = (id: string) => {
    setFavorites((prev) => {
      const next = prev.filter((f) => f.id !== id)
      saveFavorites(next)
      return next
    })
  }

  const clearFavorites = () => { setFavorites([]); saveFavorites([]) }

  const nav = (fav: Omit<DeckFavorite, 'count' | 'lastUsedAt'>, label: string) => {
    recordFavorite(fav)
    void relay({ type: 'navigate', path: fav.path }, label)
  }

  const backToRoot = () => { setProjectDetail(null); setBoardDetail(null); setPage(0) }

  const rootTiles: DeckTile[] = useMemo(() => {
    const system: DeckTile[] = [
      { key: 'home', label: 'Home', icon: <Home />, tint: 'gray',
        onTap: backToRoot },
      { key: 'launcher', label: 'Launcher', icon: <LayoutGrid />, tint: 'blue',
        onTap: () => nav({ id: 'sys:launcher', label: 'Launcher', tint: 'blue',
          iconName: 'LayoutGrid', path: '/launcher' }, 'launcher') },
      { key: 'status', label: 'Status', icon: <Activity />, tint: 'green',
        onTap: () => nav({ id: 'sys:status', label: 'Status', tint: 'green',
          iconName: 'Activity', path: '/status' }, 'status') },
      { key: 'voice', label: 'Voice', icon: <Mic />, tint: 'purple',
        onTap: () => nav({ id: 'sys:voice', label: 'Voice', tint: 'purple',
          iconName: 'Mic', path: '/voice-agent' }, 'voice') },
      { key: 'poke', label: 'Poke', icon: <Zap />, tint: 'amber',
        onTap: () => relay({ type: 'flash' }, 'poke') },
    ]
    const projTiles: DeckTile[] = projects.map((p) => ({
      key: `p-${p.path}`,
      label: p.name || p.path.split('/').pop() || 'project',
      icon: <FolderOpen />,
      tint: colorForString(p.path),
      onTap: async () => {
        setPage(0)
        try {
          const full = await api.getProject(p.path)
          const boards = await api.listBoards(p.path).catch(() => [])
          setProjectDetail({ project: full, sessions: full.sessions || [], boards })
        } catch { setProjectDetail({ project: p, sessions: [], boards: [] }) }
      },
    }))
    return [...system, ...projTiles]
  }, [projects, selected])

  const projectTiles: DeckTile[] = useMemo(() => {
    if (!projectDetail) return []
    const { project, sessions, boards } = projectDetail
    const enc = encodeProjectPath(project.path)
    const base: DeckTile[] = [
      { key: 'p-home', label: 'Home', icon: <Home />, tint: 'gray', onTap: backToRoot },
      { key: 'p-code', label: 'Code', icon: <Code />, tint: 'blue',
        onTap: () => nav({ id: `proj-code:${project.path}`, label: `${projShort(project)} · Code`,
          tint: 'blue', iconName: 'Code', path: `/projects/${enc}/code` }, 'code') },
      { key: 'p-files', label: 'Files', icon: <FolderOpen />, tint: 'amber',
        onTap: () => nav({ id: `proj-files:${project.path}`, label: `${projShort(project)} · Files`,
          tint: 'amber', iconName: 'FolderOpen', path: `/projects/${enc}/files` }, 'files') },
      { key: 'p-kb', label: 'KB', icon: <Network />, tint: 'purple',
        onTap: () => nav({ id: `proj-kb:${project.path}`, label: `${projShort(project)} · KB`,
          tint: 'purple', iconName: 'Network', path: `/projects/${enc}/kb` }, 'kb') },
    ]
    const boardTiles: DeckTile[] = boards.map((b) => ({
      key: `b-${b.id}`,
      label: b.name,
      icon: <Kanban />,
      tint: 'purple',
      onTap: () => {
        setPage(0)
        setBoardDetail({ project, board: b, tasks: [] })
      },
    }))
    const sessionTiles: DeckTile[] = sessions.map((s) => {
      const label = s.name || s.id.slice(0, 6)
      return {
        key: `s-${s.id}`,
        label,
        icon: <Terminal />,
        tint: s.waitingForInput ? 'amber' : 'green',
        badge: s.waitingForInput ? '!' : undefined,
        activitySignals: s as AgentActivitySignals,
        onTap: () => nav({
          id: `session:${s.id}`,
          label: `${projShort(project)} · ${label}`,
          tint: s.waitingForInput ? 'amber' : 'green',
          iconName: 'Terminal',
          path: `/projects/${enc}/sessions/${s.id}`,
        }, `session ${label}`),
      }
    })
    return [...base, ...boardTiles, ...sessionTiles]
  }, [projectDetail, selected])

  const boardTiles: DeckTile[] = useMemo(() => {
    if (!boardDetail) return []
    const { project, board, tasks } = boardDetail
    const enc = encodeProjectPath(project.path)
    const home: DeckTile = {
      key: 'b-home', label: 'Home', icon: <Home />, tint: 'gray', onTap: backToRoot,
    }
    const openBoard: DeckTile = {
      key: 'b-open',
      label: 'Open board',
      icon: <Kanban />,
      tint: 'purple',
      onTap: () => nav({
        id: `board:${project.path}:${board.id}`,
        label: `${projShort(project)} · ${board.name}`,
        tint: 'purple',
        iconName: 'Kanban',
        path: `/projects/${enc}/boards/${board.id}`,
      }, 'board'),
    }
    const sync: DeckTile = {
      key: 'b-sync', label: 'Sync', icon: <RefreshCw />, tint: 'blue',
      onTap: async () => {
        setBusyAction('sync')
        try { await api.syncBoardMaster(project.path, board.id) } catch { /* drop */ }
        finally { setBusyAction(null) }
      },
    }
    const standup: DeckTile = {
      key: 'b-standup', label: 'Standup', icon: <Newspaper />, tint: 'amber',
      onTap: async () => {
        setBusyAction('standup')
        try { await api.runBoardStandup(project.path, board.id) } catch { /* drop */ }
        finally { setBusyAction(null) }
      },
    }
    const rank = (t: BoardTask): number => {
      const live = !!t.terminalTmuxSessionId && !!t.ttydPort
      if (live) return 0
      const hasHistory = !!t.claudeSessionId || !!t.terminalTmuxSessionId
      if (hasHistory) return 1
      return 2
    }
    const ordered = [...tasks].sort((a, b) => {
      const d = rank(a) - rank(b)
      if (d !== 0) return d
      return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')
    })
    const taskTiles: DeckTile[] = ordered.map((t) => {
      const live = !!t.terminalTmuxSessionId && !!t.ttydPort
      const hasHistory = !live && (!!t.claudeSessionId || !!t.terminalTmuxSessionId)
      const iconName: FavIcon = live ? 'Terminal' : hasHistory ? 'History' : 'Play'
      const tint = statusTint(t.status)
      const path = `/projects/${enc}/boards/${board.id}?task=${encodeURIComponent(t.key)}`
      return {
        key: `t-${t.key}`,
        label: t.key,
        subtitle: t.title,
        icon: live ? <Terminal /> : hasHistory ? <History /> : <Play />,
        tint,
        statusBadge: shortStatus(t.status),
        activitySignals: t as AgentActivitySignals,
        onTap: () => nav({
          id: `task:${project.path}:${board.id}:${t.key}`,
          label: t.key,
          subtitle: t.title,
          tint,
          iconName,
          path,
        }, `task ${t.key}`),
      }
    })
    return [home, openBoard, sync, standup, ...taskTiles]
  }, [boardDetail, selected])

  const recents = useMemo(() => {
    if (favorites.length === 0) return []
    const now = Date.now()
    return [...favorites]
      .sort((a, b) => {
        const dayAgoA = (now - a.lastUsedAt) / (1000 * 60 * 60 * 24)
        const dayAgoB = (now - b.lastUsedAt) / (1000 * 60 * 60 * 24)
        const scoreA = a.count * 3 - dayAgoA
        const scoreB = b.count * 3 - dayAgoB
        return scoreB - scoreA
      })
      .slice(0, RECENTS_MAX)
  }, [favorites])

  const showRecents = !projectDetail && !boardDetail && recents.length > 0

  const tiles = boardDetail ? boardTiles : projectDetail ? projectTiles : rootTiles
  const totalPages = Math.max(1, Math.ceil(tiles.length / tilesPerPage))
  const clampedPage = Math.min(page, totalPages - 1)
  const pageTiles = tiles.slice(clampedPage * tilesPerPage, (clampedPage + 1) * tilesPerPage)

  useEffect(() => { setPage(0) }, [projectDetail?.project.path, boardDetail?.board.id])

  const swipeStateRef = useRef<{ x: number; y: number; time: number; active: boolean } | null>(null)
  const [swipeDelta, setSwipeDelta] = useState(0)
  const gridRef = useRef<HTMLElement | null>(null)

  const gridWidth = gridRef.current?.getBoundingClientRect().width || 0

  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const measure = () => {
      const cs = getComputedStyle(el)
      const gap = parseFloat(cs.rowGap || cs.gap || '10') || 10
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      const rect = el.getBoundingClientRect()
      const innerW = Math.max(0, rect.width - padX)
      const innerH = Math.max(0, rect.height - padY)
      const cols = Math.max(1, el.children.length > 0 && (el.children[0] as HTMLElement).offsetWidth > 0
        ? Math.round((innerW + gap) / ((el.children[0] as HTMLElement).offsetWidth + gap))
        : cs.gridTemplateColumns.split(' ').filter((s) => s.trim().length > 0).length)
      const firstTile = el.querySelector('.stream-deck-tile') as HTMLElement | null
      const tileH = firstTile?.offsetHeight
        || (innerW / cols)
      const rows = Math.max(1, Math.floor((innerH + gap) / (tileH + gap)))
      const next = Math.max(cols, cols * rows)
      setTilesPerPage((prev) => prev === next ? prev : next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [tiles.length])
  const isSwipeIntent = (dx: number, dy: number) => Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4

  const onTouchStart = (e: React.TouchEvent) => {
    if (totalPages <= 1) return
    const t = e.touches[0]
    swipeStateRef.current = { x: t.clientX, y: t.clientY, time: Date.now(), active: false }
    setSwipeDelta(0)
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const s = swipeStateRef.current
    if (!s) return
    const t = e.touches[0]
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (!s.active) {
      if (!isSwipeIntent(dx, dy)) return
      s.active = true
    }
    const limit = gridWidth || window.innerWidth
    const atFirst = clampedPage === 0
    const atLast = clampedPage >= totalPages - 1
    let bounded = dx
    if ((atFirst && dx > 0) || (atLast && dx < 0)) bounded = dx * 0.25
    bounded = Math.max(-limit, Math.min(limit, bounded))
    setSwipeDelta(bounded)
  }
  const onTouchEnd = () => {
    const s = swipeStateRef.current
    swipeStateRef.current = null
    if (!s || !s.active) { setSwipeDelta(0); return }
    const width = gridWidth || window.innerWidth
    const threshold = Math.min(90, width * 0.22)
    const dx = swipeDelta
    setSwipeDelta(0)
    if (dx <= -threshold) setPage((p) => Math.min(totalPages - 1, p + 1))
    else if (dx >= threshold) setPage((p) => Math.max(0, p - 1))
  }

  async function sendQuickText() {
    const text = quickText.trim()
    if (!text || !selected) return
    if (!projectDetail || !boardDetail) {
      const activeSessionMatch = selected.currentRoute.match(/\/sessions\/([^/?#]+)/)
      const projMatch = selected.currentRoute.match(/\/projects\/([^/]+)/)
      if (!activeSessionMatch || !projMatch) return
      const projectPath = decodeBase64Path(projMatch[1])
      await relay(
        { type: 'sendText', sessionId: activeSessionMatch[1], projectPath, text, pressEnter: true },
        'send',
      )
      setQuickText('')
    }
  }

  return (
    <div className="stream-deck-page">
      <header className="stream-deck-header">
        <button className="stream-deck-back" onClick={() => navigate(-1)} aria-label="Back">
          <ArrowLeft size={16} />
        </button>
        <div>
          <h1>Stream Deck</h1>
          <p className="stream-deck-subtle">Drive another Orka tab from here.</p>
        </div>
        <span
          className={`stream-deck-conn stream-deck-conn-${deck.status}`}
          title={`Connection: ${deck.status}${deck.active ? ' · this tab is Live' : ''}`}
        >
          <span className="stream-deck-conn-dot" />
          {deck.status === 'open' ? 'Live' : deck.status === 'connecting' || deck.status === 'reconnecting' ? 'Connecting…' : 'Offline'}
        </span>
      </header>

      <section className="stream-deck-clients" aria-label="Connected clients">
        {controllable.length === 0 && (
          <div className="stream-deck-empty">
            No tabs are registered as controllable right now. Open Orka on the
            device you want to drive, tap <strong>Register</strong> in the launcher, and it will show up here.
          </div>
        )}
        {controllable.map((c) => {
          const isSelected = c.clientId === selectedId
          const isRenaming = renamingClient === c.clientId
          return (
            <div
              key={c.clientId}
              className={`stream-deck-client-chip ${isSelected ? 'selected' : ''}`}
              onClick={() => !isRenaming && setSelectedId(c.clientId)}
            >
              <DeviceGlyph device={c.device} />
              {isRenaming ? (
                <input
                  className="stream-deck-rename-input"
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename()
                    if (e.key === 'Escape') { setRenamingClient(null); setNameDraft('') }
                  }}
                  onBlur={() => void commitRename()}
                />
              ) : (
                <div className="stream-deck-client-body">
                  <div className="stream-deck-client-name">
                    {c.name}
                    <button
                      className="stream-deck-rename-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        setRenamingClient(c.clientId); setNameDraft(c.name)
                      }}
                      aria-label="Rename"
                    >
                      <Pencil size={11} />
                    </button>
                  </div>
                  <div className="stream-deck-client-route" title={c.currentRoute}>{c.currentRoute}</div>
                </div>
              )}
            </div>
          )

          async function commitRename() {
            const clean = nameDraft.trim().slice(0, 40)
            if (clean && clean !== c.name) {
              setPersistentClientName(clean)
              try { await api.renameDeckClient(c.clientId, clean) } catch { /* drop */ }
            }
            setRenamingClient(null); setNameDraft('')
          }
        })}
      </section>

      <nav className="stream-deck-breadcrumbs" aria-label="Deck level">
        <button
          className={`stream-deck-crumb ${!projectDetail && !boardDetail ? 'active' : ''}`}
          onClick={backToRoot}
        >
          Root
        </button>
        {projectDetail && (
          <>
            <span className="stream-deck-crumb-sep">›</span>
            <button
              className={`stream-deck-crumb ${projectDetail && !boardDetail ? 'active' : ''}`}
              onClick={() => setBoardDetail(null)}
            >
              {projectDetail.project.name || projectDetail.project.path.split('/').pop()}
            </button>
          </>
        )}
        {boardDetail && (
          <>
            <span className="stream-deck-crumb-sep">›</span>
            <span className="stream-deck-crumb active">{boardDetail.board.name}</span>
          </>
        )}
      </nav>

      {showRecents && (
        <section className="stream-deck-recents" aria-label="Recents">
          <div className="stream-deck-recents-header">
            <span className="stream-deck-recents-title">Recents</span>
            <button
              className="stream-deck-recents-clear"
              onClick={clearFavorites}
              title="Clear all recents"
            >
              Clear all
            </button>
          </div>
          <div className="stream-deck-recents-row">
            {recents.map((f) => (
              <div key={`r-${f.id}`} className="stream-deck-recent-wrap">
                <button
                  className={`stream-deck-tile stream-deck-tint-${f.tint}`}
                  onClick={() => void relay({ type: 'navigate', path: f.path }, `recent ${f.label}`)
                    .then(() => recordFavorite({
                      id: f.id, label: f.label, subtitle: f.subtitle,
                      tint: f.tint, iconName: f.iconName, path: f.path,
                    }))}
                  disabled={!selected || busyAction !== null}
                  title={f.subtitle || f.label}
                >
                  <span className="stream-deck-tile-icon">{iconFromName(f.iconName)}</span>
                  <span className="stream-deck-tile-label">{f.label}</span>
                  {f.subtitle && (
                    <span className="stream-deck-tile-subtitle">{f.subtitle}</span>
                  )}
                </button>
                <button
                  className="stream-deck-recent-remove"
                  onClick={() => removeFavorite(f.id)}
                  title={`Remove ${f.label} from recents`}
                  aria-label="Remove from recents"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section
        ref={gridRef}
        className={`stream-deck-grid ${selected ? '' : 'stream-deck-grid-disabled'}`}
        aria-label="Deck tiles"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{
          transform: `translate3d(${swipeDelta}px, 0, 0)`,
          transition: swipeStateRef.current?.active ? 'none' : 'transform 180ms ease',
        }}
      >
        {pageTiles.length === 0 && (
          <div className="stream-deck-grid-empty">Nothing here yet.</div>
        )}
        {pageTiles.map((t) => (
          <button
            key={t.key}
            className={`stream-deck-tile stream-deck-tint-${t.tint}`}
            onClick={t.onTap}
            disabled={!selected || busyAction !== null}
            title={t.subtitle || t.label}
          >
            <span className="stream-deck-tile-icon">{t.icon}</span>
            <span className="stream-deck-tile-label">{t.label}</span>
            {t.subtitle && (
              <span className="stream-deck-tile-subtitle">{t.subtitle}</span>
            )}
            {t.badge && <span className="stream-deck-tile-badge">{t.badge}</span>}
            {t.statusBadge && (
              <span className={`stream-deck-tile-status stream-deck-status-${t.tint}`}>
                {t.statusBadge}
              </span>
            )}
            {t.activitySignals && (
              <span className="stream-deck-tile-activity">
                <AgentActivityDot signals={t.activitySignals} size={9} />
              </span>
            )}
          </button>
        ))}
      </section>

      {totalPages > 1 && (
        <nav className="stream-deck-pager" aria-label="Deck pages">
          <button
            className="stream-deck-page-btn"
            disabled={clampedPage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft size={16} />
          </button>
          <div className="stream-deck-dots">
            {Array.from({ length: totalPages }).map((_, i) => (
              <button
                key={i}
                className={`stream-deck-dot ${i === clampedPage ? 'active' : ''}`}
                onClick={() => setPage(i)}
                aria-label={`Page ${i + 1}`}
              />
            ))}
          </div>
          <button
            className="stream-deck-page-btn"
            disabled={clampedPage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            <ChevronRight size={16} />
          </button>
        </nav>
      )}

      <footer className="stream-deck-footer">
        <input
          className="stream-deck-quick-input"
          placeholder={selected
            ? 'Quick command → active session on selected tab (Enter to send)'
            : 'Select a tab above to unlock'}
          value={quickText}
          onChange={(e) => setQuickText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void sendQuickText() }}
          disabled={!selected}
        />
        <button
          className="stream-deck-quick-send"
          onClick={sendQuickText}
          disabled={!selected || !quickText.trim()}
          aria-label="Send"
        >
          <Send size={14} />
        </button>
      </footer>
    </div>
  )
}

interface DeckTile {
  key: string
  label: string
  subtitle?: string
  icon: React.ReactNode
  tint: string
  badge?: string
  statusBadge?: string
  activitySignals?: AgentActivitySignals
  onTap: () => void | Promise<void>
}

function DeviceGlyph({ device }: { device: DeckDevice }) {
  const map: Record<DeckDevice, React.ReactNode> = {
    iphone: <Smartphone size={16} />,
    ipad: <Tablet size={16} />,
    android: <Smartphone size={16} />,
    mac: <Monitor size={16} />,
    linux: <HardDrive size={16} />,
    windows: <Monitor size={16} />,
    unknown: <HelpCircle size={16} />,
  }
  return <span className={`stream-deck-glyph device-${device}`}>{map[device]}</span>
}

/** Same seed → same tint so the eye can tell projects apart at a glance. */
function colorForString(s: string): string {
  const palette = ['blue', 'purple', 'green', 'amber', 'pink', 'teal']
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return palette[Math.abs(h) % palette.length]
}

type FavIcon =
  | 'LayoutGrid' | 'Activity' | 'Mic' | 'Terminal' | 'History' | 'Play'
  | 'Kanban' | 'Code' | 'FolderOpen' | 'Network'

function iconFromName(name: string): React.ReactNode {
  switch (name as FavIcon) {
    case 'LayoutGrid': return <LayoutGrid />
    case 'Activity': return <Activity />
    case 'Mic': return <Mic />
    case 'Terminal': return <Terminal />
    case 'History': return <History />
    case 'Play': return <Play />
    case 'Kanban': return <Kanban />
    case 'Code': return <Code />
    case 'FolderOpen': return <FolderOpen />
    case 'Network': return <Network />
    default: return <Play />
  }
}

function projShort(p: RegisteredProject): string {
  return p.name || p.path.split('/').pop() || 'project'
}

function statusTint(status: string): string {
  const s = status.toLowerCase()
  if (s.includes('progress') || s === 'doing') return 'green'
  if (s.includes('review')) return 'amber'
  if (s.includes('done') || s === 'closed') return 'gray'
  if (s.includes('block')) return 'pink'
  return 'blue'
}

function shortStatus(status: string): string {
  const s = status.trim().toLowerCase()
  if (!s) return ''
  if (s === 'in-progress' || s === 'in progress' || s === 'inprogress' || s === 'doing') return 'WIP'
  if (s === 'in-review' || s === 'in review' || s === 'review' || s === 'inreview') return 'REV'
  if (s === 'done' || s === 'closed' || s === 'completed') return 'DONE'
  if (s === 'todo' || s === 'to-do' || s === 'to do' || s === 'open' || s === 'backlog') return 'TODO'
  if (s.includes('block')) return 'BLOCK'
  return s.slice(0, 4).toUpperCase()
}

function decodeBase64Path(enc: string): string {
  try {
    const b64 = enc.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    return atob(b64 + pad)
  } catch { return '' }
}
