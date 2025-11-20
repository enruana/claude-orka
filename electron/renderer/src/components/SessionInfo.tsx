import { Clock, FolderOpen, GitBranch, Terminal } from 'lucide-react'
import type { Session } from '../../../../src/models/Session'

interface SessionInfoProps {
  session: Session
}

export function SessionInfo({ session }: SessionInfoProps) {
  const formatDate = (date: string) => {
    const d = new Date(date)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    const hours = Math.floor(diff / (1000 * 60 * 60))
    const days = Math.floor(hours / 24)

    if (days > 0) {
      return `${days} day${days > 1 ? 's' : ''} ago`
    } else if (hours > 0) {
      return `${hours} hour${hours > 1 ? 's' : ''} ago`
    } else {
      return 'Just now'
    }
  }

  const handleOpenFolder = async () => {
    try {
      await window.electronAPI.openProjectFolder()
    } catch (error) {
      console.error('Error opening project folder:', error)
    }
  }

  const handleFocusTerminal = async () => {
    try {
      await window.electronAPI.focusTerminal()
    } catch (error) {
      console.error('Error focusing terminal:', error)
    }
  }

  const activeForks = session.forks.filter((f) => f.status === 'active').length
  const savedForks = session.forks.filter((f) => f.status === 'saved').length

  return (
    <div className="session-info">
      <div className="session-info-header">
        <h2 className="session-name">{session.name || 'Unnamed Session'}</h2>
        <div className={`session-status-badge ${session.status}`}>
          {session.status}
        </div>
      </div>

      <div className="session-meta">
        <div className="session-meta-item">
          <Clock size={14} />
          <span>{formatDate(session.createdAt)}</span>
        </div>

        <button
          className="session-meta-item folder-button"
          onClick={handleOpenFolder}
          title="Open project folder (tries Cursor, VSCode, or Finder)"
        >
          <FolderOpen size={14} />
          <span>Code</span>
        </button>

        <button
          className="session-meta-item terminal-button"
          onClick={handleFocusTerminal}
          title="Focus terminal window"
        >
          <Terminal size={14} />
          <span>Terminal</span>
        </button>

        <div className="session-meta-item">
          <GitBranch size={14} />
          <span>
            {activeForks + savedForks} fork{activeForks + savedForks !== 1 ? 's' : ''}
          </span>
        </div>
      </div>
    </div>
  )
}
