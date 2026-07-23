import { useState } from 'react'
import { Terminal, Kanban } from 'lucide-react'
import { api } from '../api/client'

/**
 * Unified "New Session" modal shared by ProjectDashboard and the launcher.
 *
 * Presents a picker with two kinds:
 *  - Classic — a plain Claude session on the project (the current default).
 *  - Board   — a Jira-integrated Kanban board with its own master terminal.
 *
 * The parent hands us `projectPath`; we handle the mutation (createSession
 * for classic, createBoard for board) and invoke `onCreated` with a
 * discriminated payload so the parent can navigate to the right route.
 */

export type NewSessionKind = 'classic' | 'board'

export type NewSessionCreated =
  | { kind: 'classic'; sessionId: string }
  | { kind: 'board'; boardId: string }

interface Props {
  projectPath: string
  projectName?: string
  onCreated: (result: NewSessionCreated) => void
  onCancel: () => void
}

export function NewSessionModal({ projectPath, projectName, onCreated, onCancel }: Props) {
  const [step, setStep] = useState<'pick' | 'classic' | 'board'>('pick')
  const [classicName, setClassicName] = useState('')
  const [boardName, setBoardName] = useState('')
  const [jiraUrl, setJiraUrl] = useState('')
  const [jql, setJql] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleClassic = async () => {
    setBusy(true)
    setError(null)
    try {
      const s = await api.createSession(projectPath, classicName || undefined)
      onCreated({ kind: 'classic', sessionId: s.id })
    } catch (e: any) {
      setError(e?.message || 'Failed to create session')
    } finally {
      setBusy(false)
    }
  }

  const handleBoard = async () => {
    if (!boardName.trim() || !jiraUrl.trim()) {
      setError('Board name and Jira URL are required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const cfg = await api.createBoard(projectPath, {
        name: boardName.trim(),
        jiraUrl: jiraUrl.trim(),
        jql: jql.trim() || undefined,
      })
      onCreated({ kind: 'board', boardId: cfg.id })
    } catch (e: any) {
      setError(e?.message || 'Failed to create board')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal new-session-modal" onClick={(e) => e.stopPropagation()}>
        {step === 'pick' && (
          <>
            <h3>New Session</h3>
            <p className="modal-subtitle">
              In <strong>{projectName || projectPath}</strong> — pick a session type.
            </p>
            <div className="ns-picker">
              <button className="ns-picker-card" onClick={() => setStep('classic')}>
                <span className="ns-picker-icon">
                  <Terminal size={28} />
                </span>
                <span className="ns-picker-title">Classic</span>
                <span className="ns-picker-desc">
                  A plain Claude session with terminal, code, files and knowledge.
                </span>
              </button>
              <button className="ns-picker-card" onClick={() => setStep('board')}>
                <span className="ns-picker-icon">
                  <Kanban size={28} />
                </span>
                <span className="ns-picker-title">Board</span>
                <span className="ns-picker-desc">
                  Jira-integrated Kanban — a master terminal syncs tickets, each
                  In Progress task spawns its own Claude session.
                </span>
              </button>
            </div>
            <div className="modal-buttons">
              <button className="button-secondary" onClick={onCancel}>Cancel</button>
            </div>
          </>
        )}

        {step === 'classic' && (
          <>
            <h3>New Classic Session</h3>
            <input
              type="text"
              value={classicName}
              onChange={(e) => setClassicName(e.target.value)}
              placeholder="Session name (optional)"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleClassic()}
            />
            {error && <div className="modal-error">{error}</div>}
            <div className="modal-buttons">
              <button className="button-secondary" onClick={() => setStep('pick')} disabled={busy}>
                Back
              </button>
              <button className="button-primary" onClick={handleClassic} disabled={busy}>
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </>
        )}

        {step === 'board' && (
          <>
            <h3>New Board</h3>
            <p className="modal-subtitle">
              A Board mirrors a Jira board locally. A master terminal will run
              on demand to sync tickets.
            </p>
            <label className="ns-label">Name</label>
            <input
              type="text"
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
              placeholder="Sprint 42, Bugs, Design system…"
              autoFocus
            />
            <label className="ns-label">Jira Board URL</label>
            <input
              type="text"
              value={jiraUrl}
              onChange={(e) => setJiraUrl(e.target.value)}
              placeholder="https://acme.atlassian.net/jira/software/projects/PROJ/boards/1"
            />
            <label className="ns-label">JQL (opcional)</label>
            <input
              type="text"
              value={jql}
              onChange={(e) => setJql(e.target.value)}
              placeholder="assignee = currentUser() AND sprint in openSprints() AND resolution = Unresolved"
            />
            <p className="ns-hint">
              Por defecto: sprint activo + asignados a ti. Déjalo vacío para
              usar ese default; escribe uno propio si quieres otro alcance
              (proyecto entero, sprint específico, etc.).
            </p>
            {error && <div className="modal-error">{error}</div>}
            <div className="modal-buttons">
              <button className="button-secondary" onClick={() => setStep('pick')} disabled={busy}>
                Back
              </button>
              <button className="button-primary" onClick={handleBoard} disabled={busy}>
                {busy ? 'Creating…' : 'Create board'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
