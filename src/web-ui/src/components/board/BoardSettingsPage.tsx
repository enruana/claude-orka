import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Save, Trash2, Plus } from 'lucide-react'
import { api, type BoardPromptTemplate } from '../../api/client'
import '../../styles/board.css'

/**
 * `/projects/:encodedPath/boards/:boardId/settings` — global-scope settings
 * page reachable from a Board's header. Two sections:
 *
 *   1. Jira credentials (URL / email / token). Persisted globally via
 *      /api/board/-/jira. Token is write-only — server never returns it.
 *   2. Prompt templates — master / sync / task-init / task-close. Built-in
 *      templates are read-only unless the user overrides them (any change
 *      creates a user copy).
 */
export function BoardSettingsPage() {
  const navigate = useNavigate()
  const { encodedPath = '', boardId = '' } = useParams()

  const [jiraCfg, setJiraCfg] = useState<{ instanceUrl?: string; email?: string; apiTokenSet: boolean }>({
    apiTokenSet: false,
  })
  const [tokenInput, setTokenInput] = useState('')
  const [templates, setTemplates] = useState<BoardPromptTemplate[]>([])
  const [editing, setEditing] = useState<BoardPromptTemplate | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = async () => {
    const [j, ts] = await Promise.all([api.getJiraConfig(), api.listBoardTemplates()])
    setJiraCfg(j)
    setTemplates(ts)
  }
  useEffect(() => { void load() }, [])

  const saveJira = async () => {
    setBusy(true)
    try {
      await api.setJiraConfig({
        instanceUrl: jiraCfg.instanceUrl,
        email: jiraCfg.email,
        apiToken: tokenInput || undefined,
      })
      setTokenInput('')
      setNotice('Jira credentials saved.')
      await load()
    } catch (e: any) {
      setNotice(e?.message || 'Failed to save Jira config')
    } finally {
      setBusy(false)
    }
  }

  const saveTemplate = async (t: BoardPromptTemplate) => {
    setBusy(true)
    try {
      await api.upsertBoardTemplate(t)
      setNotice(`Template ${t.id} saved.`)
      setEditing(null)
      await load()
    } catch (e: any) {
      setNotice(e?.message || 'Failed to save template')
    } finally {
      setBusy(false)
    }
  }

  const deleteTemplate = async (id: string) => {
    if (!confirm(`Delete template "${id}"? Built-in defaults will re-appear.`)) return
    setBusy(true)
    try {
      await api.deleteBoardTemplate(id)
      setNotice(`Template ${id} deleted.`)
      await load()
    } catch (e: any) {
      setNotice(e?.message || 'Failed to delete template')
    } finally {
      setBusy(false)
    }
  }

  const grouped: Record<string, BoardPromptTemplate[]> = {
    master: [],
    sync: [],
    'task-init': [],
    'task-close': [],
  }
  for (const t of templates) {
    if (grouped[t.kind]) grouped[t.kind].push(t)
  }

  return (
    <div className="board-page">
      <header className="board-header">
        <button
          className="board-header-back"
          onClick={() => navigate(`/projects/${encodedPath}/boards/${boardId}`)}
        >
          <ArrowLeft size={16} />
        </button>
        <div className="board-header-title">
          <h1>Board Settings</h1>
          <span className="board-header-jira">Jira credentials + prompt templates (global)</span>
        </div>
      </header>

      {notice && (
        <div className="board-error-banner" style={{ background: 'rgba(166, 227, 161, 0.1)', color: '#a6e3a1', borderColor: 'rgba(166, 227, 161, 0.3)' }}>
          <span>{notice}</span>
          <button onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      <div className="board-settings-body">
        {/* -------- Jira -------- */}
        <section className="board-settings-section">
          <h2>Jira credentials</h2>
          <p className="board-settings-hint">
            Env vars (<code>JIRA_URL</code>, <code>JIRA_EMAIL</code>, <code>JIRA_API_TOKEN</code>) take
            precedence when set. The token is write-only — the server never returns it.
          </p>
          <label>Jira URL</label>
          <input
            type="text"
            value={jiraCfg.instanceUrl ?? ''}
            onChange={(e) => setJiraCfg({ ...jiraCfg, instanceUrl: e.target.value })}
            placeholder="https://acme.atlassian.net"
          />
          <label>Email</label>
          <input
            type="text"
            value={jiraCfg.email ?? ''}
            onChange={(e) => setJiraCfg({ ...jiraCfg, email: e.target.value })}
            placeholder="you@company.com"
          />
          <label>API Token {jiraCfg.apiTokenSet && <span style={{ color: '#a6e3a1' }}>(currently set)</span>}</label>
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={jiraCfg.apiTokenSet ? 'Leave empty to keep current' : 'Paste your API token'}
          />
          <div style={{ marginTop: 12 }}>
            <button className="board-header-btn" onClick={saveJira} disabled={busy}>
              <Save size={14} /> Save
            </button>
          </div>
        </section>

        {/* -------- Templates -------- */}
        {(['master', 'sync', 'task-init', 'task-close'] as const).map((kind) => (
          <section key={kind} className="board-settings-section">
            <h2>{titleFor(kind)}</h2>
            <p className="board-settings-hint">{descFor(kind)}</p>
            {grouped[kind].map((t) => (
              <div key={t.id} className="board-template-row">
                <div className="board-template-info">
                  <div className="board-template-name">
                    {t.name} {t.builtin && <span className="board-template-tag">built-in</span>}
                  </div>
                  {t.description && <div className="board-template-desc">{t.description}</div>}
                </div>
                <div className="board-template-actions">
                  <button className="board-header-btn" onClick={() => setEditing(t)}>Edit</button>
                  {!t.builtin && (
                    <button className="board-header-btn" onClick={() => deleteTemplate(t.id)}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            <button
              className="board-header-btn"
              onClick={() => setEditing({
                id: `${kind}-custom-${Date.now()}`,
                name: 'New template',
                kind,
                body: '',
              })}
            >
              <Plus size={12} /> New {kind}
            </button>
          </section>
        ))}
      </div>

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div
            className="modal"
            style={{ maxWidth: 720, width: '90vw' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{editing.builtin ? `Override ${editing.id}` : editing.id}</h3>
            <label className="ns-label">Id</label>
            <input
              type="text"
              value={editing.id}
              onChange={(e) => setEditing({ ...editing, id: e.target.value })}
              disabled={editing.builtin}
            />
            <label className="ns-label">Name</label>
            <input
              type="text"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
            <label className="ns-label">Description</label>
            <input
              type="text"
              value={editing.description ?? ''}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
            <label className="ns-label">Body (placeholders like {'{{taskKey}}'})</label>
            <textarea
              value={editing.body}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              rows={12}
              style={{ fontFamily: 'monospace', width: '100%', boxSizing: 'border-box' }}
            />
            {(editing.kind === 'task-init' || editing.kind === 'task-close') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={editing.kind === 'task-init' ? !!editing.requiresWorktree : !!editing.removesWorktree}
                  onChange={(e) =>
                    setEditing(
                      editing.kind === 'task-init'
                        ? { ...editing, requiresWorktree: e.target.checked }
                        : { ...editing, removesWorktree: e.target.checked }
                    )
                  }
                />
                {editing.kind === 'task-init' ? 'Requires worktree' : 'Removes worktree on close'}
              </label>
            )}
            <div className="modal-buttons">
              <button className="button-secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button className="button-primary" onClick={() => saveTemplate(editing)} disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function titleFor(kind: string): string {
  switch (kind) {
    case 'master': return 'Master boot prompt'
    case 'sync': return 'Sync prompt'
    case 'task-init': return 'Task init templates'
    case 'task-close': return 'Task close templates'
    default: return kind
  }
}

function descFor(kind: string): string {
  switch (kind) {
    case 'master': return 'Sent to a board master when it boots for the first time. Tells Claude the board is read-only against Jira.'
    case 'sync': return 'Sent to the master when the user hits Sync. Should tell Claude to load the board-sync skill and run the ritual.'
    case 'task-init': return 'Sent to a task terminal at boot. One template per flavor of task (full setup, spike, etc.).'
    case 'task-close': return 'Sent to a task terminal at close. Push, PR, Jira comment, KB update, cleanup.'
    default: return ''
  }
}
