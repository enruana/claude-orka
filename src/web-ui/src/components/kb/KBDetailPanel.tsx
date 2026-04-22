import { useState } from 'react'
import { X, ExternalLink, Circle, FolderOpen, FileText, Globe, Send, Check, Brain } from 'lucide-react'
import { api, type KBEntity } from '../../api/client'

const TYPE_COLORS: Record<string, string> = {
  decision: '#a6e3a1', question: '#f9e2af', person: '#89b4fa',
  meeting: '#cba6f7', direction: '#fab387', repo: '#89dceb',
  artifact: '#a6adc8', milestone: '#f5c2e7', context: '#6c7086',
  project: '#f38ba8',
}

// Properties that are navigable file paths
const PATH_PROPERTIES = new Set(['path', 'notes_path', 'profile_path', 'filePath', 'source_path', 'repo_path'])
// Properties that are external URLs
const URL_PROPERTIES = new Set(['linkedin', 'url', 'website', 'link'])
// Source relation types
const SOURCE_RELATIONS = new Set(['sourced-from', 'decided-at', 'raised-at', 'documented-in'])

interface KBDetailPanelProps {
  entity: KBEntity | null
  encodedPath: string
  projectPath: string
  sessionId?: string
  onClose: () => void
  onSelectNode: (id: string) => void
}

function isExternalUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://') || value.includes('linkedin.com')
}

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
    } else {
      regularProps.push({ key, value: strValue })
    }
  }

  return { fileLinks, urlLinks, regularProps }
}

function formatPropKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
}

export function KBDetailPanel({ entity, encodedPath, projectPath, sessionId, onClose, onSelectNode }: KBDetailPanelProps) {
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [loadingContext, setLoadingContext] = useState(false)
  const [contextLoaded, setContextLoaded] = useState(false)

  if (!entity) return null

  const color = TYPE_COLORS[entity.type] || '#6c7086'
  const { fileLinks, urlLinks, regularProps } = getNavigableProps(entity)

  const handleSendToTerminal = async () => {
    if (!sessionId || sending) return
    setSending(true)
    setSent(false)

    const prompt = buildPromptForEntity(entity)

    try {
      await api.sendTextToSession(projectPath, sessionId, prompt)
      setSent(true)
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
      await api.sendTextToSession(projectPath, sessionId, prompt)
      setContextLoaded(true)
      setTimeout(() => setContextLoaded(false), 3000)
    } catch (err) {
      console.error('Failed to load project context:', err)
    } finally {
      setLoadingContext(false)
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

      {entity.tags.length > 0 && (
        <div className="kb-detail-tags">
          {entity.tags.map((tag) => (
            <span key={tag} className="kb-detail-tag">#{tag}</span>
          ))}
        </div>
      )}

      {/* Quick actions — navigable links at the top */}
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

      {sessionId && (
        <div className="kb-detail-actions">
          {entity.type === 'project' && (
            <button
              className={`kb-detail-context-btn ${contextLoaded ? 'sent' : ''}`}
              onClick={handleLoadProjectContext}
              disabled={loadingContext}
            >
              {contextLoaded ? <Check size={14} /> : <Brain size={14} />}
              {loadingContext ? 'Loading...' : contextLoaded ? 'Context loaded' : 'Load project context'}
            </button>
          )}
          <button
            className={`kb-detail-send-btn ${sent ? 'sent' : ''}`}
            onClick={handleSendToTerminal}
            disabled={sending}
          >
            {sent ? <Check size={14} /> : <Send size={14} />}
            {sending ? 'Sending...' : sent ? 'Sent to terminal' : 'Discuss in terminal'}
          </button>
        </div>
      )}
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
