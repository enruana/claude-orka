import { useState, useEffect } from 'react'
import { X, ExternalLink, Circle, FolderOpen, FileText, Globe, Send, Check, Brain, BookMarked } from 'lucide-react'
import { api, type KBEntity } from '../../api/client'

type KBSchema = {
  statuses: Record<string, string[]>
  transitions: Record<string, Record<string, string[]>>
}

// Built-in mirror of the KB v2 schema (src/models/kb-registry.ts). Used as a
// fallback when the server predates the /api/kb/schema endpoint, so the status
// selector works without requiring a server restart. The live endpoint (when
// available) takes precedence and remains the single source of truth.
const FALLBACK_SCHEMA: KBSchema = {
  statuses: {
    goal: ['active', 'archived'],
    initiative: ['active', 'archived'],
    project: ['planning', 'active', 'in-progress', 'blocked', 'review', 'done', 'cancelled', 'archived'],
    task: ['todo', 'in-progress', 'done', 'blocked', 'cancelled'],
    spike: ['open', 'in-progress', 'concluded', 'cancelled'],
    bug: ['open', 'investigating', 'fixed', 'wontfix', 'duplicate'],
    decision: ['proposed', 'accepted', 'rejected', 'superseded'],
    question: ['open', 'active', 'answered', 'resolved', 'closed'],
    meeting: ['scheduled', 'held', 'archived'],
    milestone: ['active', 'reached', 'resolved', 'archived'],
    direction: ['active', 'archived'],
    person: ['active', 'archived', 'superseded'],
    repo: ['active', 'archived'],
    artifact: ['draft', 'active', 'archived', 'superseded'],
    context: ['active', 'archived'],
    activity: ['active'],
  },
  transitions: {
    decision: { proposed: ['accepted', 'rejected'], accepted: ['superseded'], rejected: [], superseded: [] },
    question: {
      open: ['active', 'answered', 'resolved', 'closed'],
      active: ['answered', 'resolved', 'closed'],
      answered: ['resolved', 'closed'],
      resolved: ['closed'],
      closed: [],
    },
    milestone: { active: ['reached', 'archived'], reached: ['archived'], resolved: ['archived'], archived: [] },
    bug: {
      open: ['investigating', 'wontfix', 'duplicate'],
      investigating: ['fixed', 'wontfix', 'duplicate', 'open'],
      fixed: [],
      wontfix: ['investigating'],
      duplicate: [],
    },
  },
}

// Fetched once per app session (the KB schema is static). Falls back to the
// built-in mirror if the endpoint is unavailable.
let schemaPromise: Promise<KBSchema> | null = null
function loadKBSchema(): Promise<KBSchema> {
  if (!schemaPromise) {
    schemaPromise = api.getKBSchema().catch(() => FALLBACK_SCHEMA)
  }
  return schemaPromise
}

const TYPE_COLORS: Record<string, string> = {
  // Knowledge tier
  decision: '#a6e3a1', question: '#f9e2af',
  meeting: '#cba6f7', milestone: '#f5c2e7', direction: '#fab387',
  // Work tier (v2)
  goal: '#f38ba8', initiative: '#eba0ac', project: '#f38ba8',
  task: '#94e2d5', spike: '#eed49f', bug: '#ed8796',
  // Reference tier
  person: '#89b4fa', repo: '#89dceb', artifact: '#a6adc8', context: '#6c7086',
  // Provenance tier
  activity: '#7f849c',
}

// Properties that are navigable file paths
const PATH_PROPERTIES = new Set(['master_doc', 'path', 'notes_path', 'profile_path', 'filePath', 'source_path', 'repo_path'])
// Properties that are external URLs
const URL_PROPERTIES = new Set(['linkedin', 'url', 'website', 'link'])
// Source relation types
const SOURCE_RELATIONS = new Set(['sourced-from', 'decided-at', 'raised-at', 'documented-in'])

interface KBDetailPanelProps {
  entity: KBEntity | null
  /** Full entity list for computing backlinks. Optional for backward compat. */
  allEntities?: KBEntity[]
  encodedPath: string
  projectPath: string
  sessionId?: string
  /** Currently-selected branch in the session ('main' or fork id) — used to
   *  route terminal commands to the correct tmux pane. */
  branch?: string
  /** Called after a command is successfully sent to the terminal so the host
   *  can switch the right panel back to the terminal tab. */
  onSwitchToTerminal?: () => void
  onClose: () => void
  onSelectNode: (id: string) => void
  /** Called after a status change persists so the host can update the graph,
   *  guide panel and selected entity without waiting for the next poll. */
  onEntityUpdated?: (updated: KBEntity) => void
}

function isExternalUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://') || value.includes('linkedin.com')
}

// Properties shown prominently (description, chips, MADR) — exclude from regular props
const PROMINENT_PROPERTIES = new Set([
  // Description-like
  'description', 'rationale', 'resolution', 'notes', 'body', 'summary',
  // MADR (rendered in their own block for decision type)
  'drivers', 'options', 'outcome', 'consequences',
  // Chips
  'role', 'owner', 'team', 'date', 'deadline', 'target', 'target_release',
  'confidence', 'attendees', 'location', 'stack', 'language',
  // Provenance / activity-internal
  'skill', 'session_id',
])

function getNavigableProps(entity: KBEntity): {
  fileLinks: Array<{ key: string; path: string }>
  urlLinks: Array<{ key: string; url: string }>
  regularProps: Array<{ key: string; value: string }>
} {
  const fileLinks: Array<{ key: string; path: string }> = []
  const urlLinks: Array<{ key: string; url: string }> = []
  const regularProps: Array<{ key: string; value: string }> = []

  for (const [key, value] of Object.entries(entity.properties)) {
    const strValue = String(value)

    if (PATH_PROPERTIES.has(key) && strValue) {
      fileLinks.push({ key, path: strValue })
    } else if (URL_PROPERTIES.has(key) && strValue) {
      urlLinks.push({ key, url: strValue.startsWith('http') ? strValue : `https://${strValue}` })
    } else if (isExternalUrl(strValue)) {
      urlLinks.push({ key, url: strValue.startsWith('http') ? strValue : `https://${strValue}` })
    } else if (!PROMINENT_PROPERTIES.has(key)) {
      regularProps.push({ key, value: strValue })
    }
  }

  // Sort file links: master_doc first
  fileLinks.sort((a, b) => {
    if (a.key === 'master_doc') return -1
    if (b.key === 'master_doc') return 1
    return 0
  })

  return { fileLinks, urlLinks, regularProps }
}

function formatPropKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
}

export function KBDetailPanel({ entity, allEntities, encodedPath, projectPath, sessionId, branch, onSwitchToTerminal, onClose, onSelectNode, onEntityUpdated }: KBDetailPanelProps) {
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [loadingContext, setLoadingContext] = useState(false)
  const [contextLoaded, setContextLoaded] = useState(false)
  const [generatingDoc, setGeneratingDoc] = useState(false)
  const [docGenerated, setDocGenerated] = useState(false)
  const [schema, setSchema] = useState<KBSchema | null>(null)
  const [savingStatus, setSavingStatus] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    loadKBSchema().then(s => { if (alive) setSchema(s) }).catch(() => {})
    return () => { alive = false }
  }, [])

  // Clear any transient status error when the selected entity changes.
  useEffect(() => { setStatusError(null) }, [entity?.id])

  const handleStatusChange = async (target: string) => {
    if (!entity || target === entity.status || savingStatus) return
    setSavingStatus(target)
    setStatusError(null)
    try {
      const updated = await api.updateKBEntity(projectPath, entity.id, { status: target })
      onEntityUpdated?.(updated)
    } catch (err: any) {
      setStatusError(err?.message || 'Failed to change status')
    } finally {
      setSavingStatus(null)
    }
  }

  if (!entity) return null

  const color = TYPE_COLORS[entity.type] || '#6c7086'
  const { fileLinks, urlLinks, regularProps } = getNavigableProps(entity)

  const handleSendToTerminal = async () => {
    if (!sessionId || sending) return
    setSending(true)
    setSent(false)

    const prompt = buildPromptForEntity(entity)

    try {
      await api.sendTextToSession(projectPath, sessionId, prompt, branch)
      setSent(true)
      // Switch to terminal tab so the user immediately sees Claude responding
      onSwitchToTerminal?.()
      setTimeout(() => setSent(false), 3000)
    } catch (err) {
      console.error('Failed to send to terminal:', err)
    } finally {
      setSending(false)
    }
  }

  const handleLoadProjectContext = async () => {
    if (!sessionId || loadingContext) return
    setLoadingContext(true)
    setContextLoaded(false)

    const prompt = `Run the following command and read all the source files listed in the output. Then summarize the current state of this project — what's been decided, what's open, what's blocked, and what the next steps are.

\`\`\`bash
orka kb context --project ${entity.id}
\`\`\`

After running the command, read each file listed in the "Source Files" section to build deep context. Then give me a clear summary.`

    try {
      await api.sendTextToSession(projectPath, sessionId, prompt, branch)
      setContextLoaded(true)
      // Switch to terminal tab so user sees the command run and Claude respond
      onSwitchToTerminal?.()
      setTimeout(() => setContextLoaded(false), 3000)
    } catch (err) {
      console.error('Failed to load project context:', err)
    } finally {
      setLoadingContext(false)
    }
  }

  const handleGenerateDoc = async () => {
    if (generatingDoc) return
    setGeneratingDoc(true)
    setDocGenerated(false)

    try {
      const encodedProject = btoa(projectPath)
      const res = await fetch(`/api/kb/project-doc/${entity.id}?project=${encodedProject}`, { method: 'POST' })
      if (res.ok) {
        setDocGenerated(true)
        setTimeout(() => { setDocGenerated(false); window.location.reload() }, 2000)
      }
    } catch (err) {
      console.error('Failed to generate project doc:', err)
    } finally {
      setGeneratingDoc(false)
    }
  }

  const handleOpenFile = (filePath: string) => {
    // Check if it looks like a file (has extension) or a directory
    const isFile = /\.\w+$/.test(filePath)
    if (isFile) {
      window.open(`/projects/${encodedPath}/files/view?path=${encodeURIComponent(filePath)}`, '_blank')
    } else {
      window.open(`/projects/${encodedPath}/files?path=${encodeURIComponent(filePath)}`, '_blank')
    }
  }

  const handleOpenUrl = (url: string) => {
    window.open(url, '_blank', 'noopener')
  }

  return (
    <div className="kb-detail-panel">
      <div className="kb-detail-header">
        <div className="kb-detail-title-row">
          <span className="kb-detail-type-badge" style={{ background: `${color}22`, color }}>
            {entity.type}
          </span>
          <span className="kb-detail-status">
            <Circle size={8} fill={color} stroke="none" />
            {entity.status}
          </span>
        </div>
        <button className="kb-detail-close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <h3 className="kb-detail-title">{entity.title}</h3>
      <div className="kb-detail-id">{entity.id}</div>
      <div className="kb-detail-dates">
        Created {entity.created.split('T')[0]} | Updated {entity.updated.split('T')[0]}
      </div>

      {/* Status selector — move the entity between states. Each click runs the
          same validated KB mutation as `orka kb update --status`, which logs
          an entity.updated event in the timeline. */}
      {(() => {
        const typeStatuses = schema?.statuses[entity.type] ?? []
        if (typeStatuses.length <= 1) return null
        const transMap = schema?.transitions[entity.type]
        // No transition map for a type (e.g. task) ⇒ lenient: any → any.
        const reachable = transMap
          ? new Set(transMap[entity.status] ?? [])
          : null
        return (
          <div className="kb-detail-status-selector">
            <span className="kb-detail-status-label">Status</span>
            <div className="kb-detail-status-options">
              {typeStatuses.map((s) => {
                const isCurrent = s === entity.status
                const allowed = isCurrent || (reachable ? reachable.has(s) : true)
                const isSaving = savingStatus === s
                return (
                  <button
                    key={s}
                    className={`kb-detail-status-pill${isCurrent ? ' current' : ''}${isSaving ? ' saving' : ''}`}
                    style={isCurrent ? { borderColor: color, color } : undefined}
                    disabled={isCurrent || !allowed || savingStatus !== null}
                    onClick={() => handleStatusChange(s)}
                    title={
                      isCurrent ? 'Current status'
                        : allowed ? `Move to "${s}"`
                        : `Not allowed from "${entity.status}"`
                    }
                  >
                    {isCurrent && <Circle size={7} fill={color} stroke="none" />}
                    {s}
                  </button>
                )
              })}
            </div>
            {statusError && <div className="kb-detail-status-error">{statusError}</div>}
          </div>
        )
      })()}

      {entity.tags.length > 0 && (
        <div className="kb-detail-tags">
          {entity.tags.map((tag) => (
            <span key={tag} className="kb-detail-tag">#{tag}</span>
          ))}
        </div>
      )}

      {/* Provenance badge — when entity was generated by a skill,
          show a small "Generated by skill: X" pill near the top. */}
      {(() => {
        const genEdge = entity.edges.find((e) => e.relation === 'generated-by')
        if (!genEdge) return null
        return (
          <div className="kb-detail-provenance">
            <Brain size={11} />
            <span>Generated by</span>
            <button className="kb-detail-provenance-link" onClick={() => onSelectNode(genEdge.target)}>
              {genEdge.target}
            </button>
            {genEdge.qualifiers?.confidence !== undefined && (
              <span className="kb-detail-provenance-conf">
                · confidence {Math.round((genEdge.qualifiers.confidence as number) * 100)}%
              </span>
            )}
          </div>
        )
      })()}

      {/* Description / summary — show prominently if exists */}
      {(() => {
        const desc = entity.properties.description || entity.properties.rationale
          || entity.properties.resolution || entity.properties.notes
          || entity.properties.body || entity.properties.summary
        if (!desc) return null
        const label = entity.properties.resolution ? 'Resolution'
          : entity.properties.rationale ? 'Rationale'
          : entity.properties.notes ? 'Notes'
          : 'Description'
        return (
          <div className="kb-detail-description">
            <span className="kb-detail-description-label">{label}</span>
            <p>{String(desc)}</p>
          </div>
        )
      })()}

      {/* MADR section — render decisions with their full structure
          (drivers, options, outcome, consequences) when present. */}
      {entity.type === 'decision' && (() => {
        const drivers = entity.properties.drivers as string | undefined
        const options = entity.properties.options as string | undefined
        const outcome = entity.properties.outcome as string | undefined
        const consequences = entity.properties.consequences as string | undefined
        if (!drivers && !options && !outcome && !consequences) return null
        return (
          <div className="kb-detail-madr">
            {outcome && (
              <div className="kb-detail-madr-block outcome">
                <span className="kb-detail-madr-label">Outcome</span>
                <p>{String(outcome)}</p>
              </div>
            )}
            {drivers && (
              <div className="kb-detail-madr-block">
                <span className="kb-detail-madr-label">Drivers</span>
                <p>{String(drivers)}</p>
              </div>
            )}
            {options && (
              <div className="kb-detail-madr-block">
                <span className="kb-detail-madr-label">Options considered</span>
                <p>{String(options)}</p>
              </div>
            )}
            {consequences && (
              <div className="kb-detail-madr-block">
                <span className="kb-detail-madr-label">Consequences</span>
                <p>{String(consequences)}</p>
              </div>
            )}
          </div>
        )
      })()}

      {/* Key info chips — role, owner, date, deadline, etc */}
      {(() => {
        const chips: Array<{ label: string; value: string; color?: string }> = []
        if (entity.properties.role) chips.push({ label: 'Role', value: String(entity.properties.role) })
        if (entity.properties.owner) chips.push({ label: 'Owner', value: String(entity.properties.owner) })
        if (entity.properties.team) chips.push({ label: 'Team', value: String(entity.properties.team) })
        if (entity.properties.date) chips.push({ label: 'Date', value: String(entity.properties.date) })
        if (entity.properties.deadline) chips.push({ label: 'Deadline', value: String(entity.properties.deadline), color: '#f38ba8' })
        if (entity.properties.target) chips.push({ label: 'Target', value: String(entity.properties.target) })
        if (entity.properties.target_release) chips.push({ label: 'Release', value: String(entity.properties.target_release) })
        if (entity.properties.confidence) chips.push({ label: 'Confidence', value: String(entity.properties.confidence) })
        if (entity.properties.attendees) chips.push({ label: 'Attendees', value: String(entity.properties.attendees) })
        if (entity.properties.location) chips.push({ label: 'Location', value: String(entity.properties.location) })
        if (entity.properties.stack) chips.push({ label: 'Stack', value: String(entity.properties.stack) })
        if (entity.properties.language) chips.push({ label: 'Language', value: String(entity.properties.language) })
        if (chips.length === 0) return null
        return (
          <div className="kb-detail-chips">
            {chips.map(c => (
              <span key={c.label} className="kb-detail-chip" style={c.color ? { borderColor: `${c.color}33`, color: c.color } : undefined}>
                <span className="kb-detail-chip-label">{c.label}</span> {c.value}
              </span>
            ))}
          </div>
        )
      })()}

      {/* Quick access — navigable links */}
      {(fileLinks.length > 0 || urlLinks.length > 0) && (
        <div className="kb-detail-section">
          <h4>Quick Access</h4>
          <div className="kb-detail-links">
            {fileLinks.map(({ key, path }) => (
              <button
                key={key}
                className="kb-detail-link-btn"
                onClick={() => handleOpenFile(path)}
              >
                {/\.\w+$/.test(path) ? <FileText size={13} /> : <FolderOpen size={13} />}
                <div className="kb-detail-link-info">
                  <span className="kb-detail-link-label">{formatPropKey(key)}</span>
                  <span className="kb-detail-link-path">{path}</span>
                </div>
                <ExternalLink size={11} className="kb-detail-link-arrow" />
              </button>
            ))}
            {urlLinks.map(({ key, url }) => (
              <button
                key={key}
                className="kb-detail-link-btn url"
                onClick={() => handleOpenUrl(url)}
              >
                <Globe size={13} />
                <div className="kb-detail-link-info">
                  <span className="kb-detail-link-label">{formatPropKey(key)}</span>
                  <span className="kb-detail-link-path">{url.replace(/^https?:\/\//, '')}</span>
                </div>
                <ExternalLink size={11} className="kb-detail-link-arrow" />
              </button>
            ))}
          </div>
        </div>
      )}

      {regularProps.length > 0 && (
        <div className="kb-detail-section">
          <h4>Properties</h4>
          <div className="kb-detail-props">
            {regularProps.map(({ key, value }) => (
              <div key={key} className="kb-detail-prop">
                <span className="kb-detail-prop-key">{formatPropKey(key)}</span>
                <span className="kb-detail-prop-value">{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Source references — separated from other relationships */}
      {(() => {
        const sourceEdges = entity.edges.filter(e => SOURCE_RELATIONS.has(e.relation))
        const otherEdges = entity.edges.filter(e => !SOURCE_RELATIONS.has(e.relation))
        const sourceText = entity.properties.source ? String(entity.properties.source) : null

        return (
          <>
            {(sourceEdges.length > 0 || sourceText) && (
              <div className="kb-detail-section">
                <h4>Sources</h4>
                <div className="kb-detail-sources">
                  {sourceText && (
                    <div className="kb-detail-source-text">
                      <FileText size={12} />
                      <span>{sourceText}</span>
                    </div>
                  )}
                  {sourceEdges.map((edge, i) => (
                    <button
                      key={i}
                      className="kb-detail-edge source"
                      onClick={() => onSelectNode(edge.target)}
                    >
                      <span className="kb-detail-edge-rel">{edge.relation}</span>
                      <span className="kb-detail-edge-target">{edge.target}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {otherEdges.length > 0 && (
              <div className="kb-detail-section">
                <h4>Relationships</h4>
                <div className="kb-detail-edges">
                  {otherEdges.map((edge, i) => (
                    <button
                      key={i}
                      className="kb-detail-edge"
                      onClick={() => onSelectNode(edge.target)}
                    >
                      <span className="kb-detail-edge-rel">{edge.relation}</span>
                      <span className="kb-detail-edge-target">{edge.target}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )
      })()}

      {/* Health panel — for projects/initiatives, show coverage stats over
          the related entities (sourcing, descriptions, stale questions). */}
      {(['project', 'initiative', 'goal'].includes(entity.type)) && allEntities && (() => {
        // Compute the related set via outgoing+incoming edges (1 hop)
        const directIds = new Set<string>([entity.id])
        for (const edge of entity.edges) directIds.add(edge.target)
        for (const e of allEntities) {
          for (const edge of e.edges) {
            if (edge.target === entity.id) directIds.add(e.id)
          }
        }
        const related = allEntities.filter((e) => directIds.has(e.id) && e.id !== entity.id)
        if (related.length === 0) return null

        // Compute health metrics
        const checkable = related.filter((e) => !['person', 'repo', 'activity'].includes(e.type))
        const withSource = checkable.filter((e) =>
          !!(e.properties.source_path || e.properties.source) ||
          e.edges.some((edge) => edge.relation === 'sourced-from' || edge.relation === 'generated-by' || edge.relation === 'derived-from')
        )
        const withDescription = checkable.filter((e) => !!e.properties.description)
        const openQuestions = related.filter((e) => e.type === 'question' && e.status !== 'resolved' && e.status !== 'answered' && e.status !== 'closed' && e.status !== 'archived')
        const staleQuestions = openQuestions.filter((e) => {
          const age = (Date.now() - new Date(e.updated).getTime()) / (1000 * 60 * 60 * 24)
          return age > 7
        })
        const sourcePct = checkable.length > 0 ? Math.round((withSource.length / checkable.length) * 100) : 100
        const descPct = checkable.length > 0 ? Math.round((withDescription.length / checkable.length) * 100) : 100

        const healthColor = (pct: number) => pct >= 80 ? '#a6e3a1' : pct >= 50 ? '#f9e2af' : '#f38ba8'

        return (
          <div className="kb-detail-section">
            <h4>Health</h4>
            <div className="kb-detail-health">
              <div className="kb-detail-health-row">
                <span className="kb-detail-health-label">Source coverage</span>
                <div className="kb-detail-health-bar">
                  <div className="kb-detail-health-fill" style={{ width: `${sourcePct}%`, background: healthColor(sourcePct) }} />
                </div>
                <span className="kb-detail-health-pct">{sourcePct}%</span>
              </div>
              <div className="kb-detail-health-row">
                <span className="kb-detail-health-label">Description coverage</span>
                <div className="kb-detail-health-bar">
                  <div className="kb-detail-health-fill" style={{ width: `${descPct}%`, background: healthColor(descPct) }} />
                </div>
                <span className="kb-detail-health-pct">{descPct}%</span>
              </div>
              <div className="kb-detail-health-stat">
                <span>{related.length} related entities</span>
                {openQuestions.length > 0 && (
                  <span>{openQuestions.length} open question{openQuestions.length !== 1 ? 's' : ''}{staleQuestions.length > 0 && (
                    <span style={{ color: '#f38ba8' }}> ({staleQuestions.length} stale &gt; 7d)</span>
                  )}</span>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Backlinks — entities that point to THIS one. Computed from the full
          entity list provided by the parent. Hidden if no parent supplied. */}
      {(() => {
        if (!allEntities || !entity) return null
        const incoming = allEntities
          .filter((e) => e.id !== entity.id)
          .flatMap((e) =>
            e.edges
              .filter((edge) => edge.target === entity.id)
              .map((edge) => ({ source: e.id, sourceTitle: e.title, sourceType: e.type, relation: edge.relation }))
          )
        if (incoming.length === 0) return null
        return (
          <div className="kb-detail-section">
            <h4>Backlinks <span className="kb-detail-section-count">({incoming.length})</span></h4>
            <div className="kb-detail-edges">
              {incoming.slice(0, 30).map((b, i) => (
                <button
                  key={i}
                  className="kb-detail-edge backlink"
                  onClick={() => onSelectNode(b.source)}
                  title={`${b.sourceType}: ${b.sourceTitle}`}
                >
                  <span className="kb-detail-edge-rel">←{b.relation}</span>
                  <span className="kb-detail-edge-target">
                    {b.sourceTitle.length > 36 ? b.sourceTitle.slice(0, 36) + '…' : b.sourceTitle}
                  </span>
                </button>
              ))}
              {incoming.length > 30 && (
                <span className="kb-detail-edge-more">+{incoming.length - 30} more</span>
              )}
            </div>
          </div>
        )
      })()}

      {entity.history.length > 0 && (
        <div className="kb-detail-section">
          <h4>History</h4>
          <div className="kb-detail-history">
            {entity.history.slice(-8).reverse().map((h, i) => (
              <div key={i} className="kb-detail-history-entry">
                <span className="kb-detail-history-date">{h.ts.split('T')[0]}</span>
                <span className="kb-detail-history-summary">{h.summary}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="kb-detail-actions">
        {entity.type === 'project' && (
          <button
            className={`kb-detail-doc-btn ${docGenerated ? 'sent' : ''}`}
            onClick={handleGenerateDoc}
            disabled={generatingDoc}
          >
            {docGenerated ? <Check size={14} /> : <BookMarked size={14} />}
            {generatingDoc ? 'Generating...' : docGenerated ? 'Index updated' : entity.properties.master_doc ? 'Update project index' : 'Generate project index'}
          </button>
        )}
        {sessionId && entity.type === 'project' && (
          <button
            className={`kb-detail-context-btn ${contextLoaded ? 'sent' : ''}`}
            onClick={handleLoadProjectContext}
            disabled={loadingContext}
          >
            {contextLoaded ? <Check size={14} /> : <Brain size={14} />}
            {loadingContext ? 'Loading...' : contextLoaded ? 'Context loaded' : 'Load project context'}
          </button>
        )}
        {sessionId && (
          <button
            className={`kb-detail-send-btn ${sent ? 'sent' : ''}`}
            onClick={handleSendToTerminal}
            disabled={sending}
          >
            {sent ? <Check size={14} /> : <Send size={14} />}
            {sending ? 'Sending...' : sent ? 'Sent to terminal' : 'Discuss in terminal'}
          </button>
        )}
      </div>
    </div>
  )
}

function buildPromptForEntity(entity: KBEntity): string {
  const typeLabels: Record<string, string> = {
    question: 'open question',
    decision: 'decision',
    milestone: 'milestone',
    meeting: 'meeting',
    direction: 'direction',
    person: 'person profile',
    artifact: 'artifact',
    repo: 'repository',
    context: 'context note',
  }

  const typeLabel = typeLabels[entity.type] || entity.type
  const props = Object.entries(entity.properties)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n')
  const tags = entity.tags.length > 0 ? `Tags: ${entity.tags.join(', ')}` : ''
  const edges = entity.edges.length > 0
    ? `Related: ${entity.edges.map(e => `${e.relation} → ${e.target}`).join(', ')}`
    : ''

  let instruction = ''
  if (entity.type === 'question') {
    instruction = `I want to answer or comment on this open question. Analyze what I tell you and then update the Knowledge Base accordingly using the /kb-track skill. If I resolve the question, mark it as resolved with: orka kb update ${entity.id} --status resolved`
  } else if (entity.type === 'decision') {
    instruction = `I want to discuss or update this decision. Analyze what I tell you and update the Knowledge Base using /kb-track. If this decision is superseded, update with: orka kb update ${entity.id} --status superseded`
  } else if (entity.type === 'milestone') {
    instruction = `I want to update progress on this milestone. Analyze what I tell you and update the KB using /kb-track. If completed, mark with: orka kb update ${entity.id} --status resolved`
  } else {
    instruction = `I want to discuss or update this ${typeLabel}. Analyze what I tell you and update the Knowledge Base using the /kb-track skill.`
  }

  return `I'm reviewing the following ${typeLabel} from the project Knowledge Base:

**${entity.title}** (${entity.id})
Status: ${entity.status}
${props ? '\nProperties:\n' + props : ''}
${tags}
${edges}

${instruction}

Go ahead, I'll provide my input now.`
}
