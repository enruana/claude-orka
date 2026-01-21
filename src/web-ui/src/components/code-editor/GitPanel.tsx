import { useState } from 'react'
import {
  GitBranch,
  Plus,
  Minus,
  RefreshCw,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  FilePlus,
  FileMinus,
  FileEdit,
  Eye,
  History,
} from 'lucide-react'
import { GitStatus, GitFileChange } from '../../api/client'
import { CommitHistory } from './CommitHistory'

interface GitPanelProps {
  status: GitStatus
  onStage: (paths: string[]) => Promise<void>
  onUnstage: (paths: string[]) => Promise<void>
  onCommit: (message: string) => Promise<void>
  onViewDiff: (path: string, staged: boolean) => void
  onRefresh: () => Promise<void>
}

interface ChangeItemProps {
  change: GitFileChange
  onStage: () => void
  onUnstage: () => void
  onViewDiff: () => void
}

function getStatusIcon(status: string) {
  switch (status) {
    case 'modified':
      return <FileEdit size={14} className="status-modified" />
    case 'added':
    case 'untracked':
      return <FilePlus size={14} className="status-added" />
    case 'deleted':
      return <FileMinus size={14} className="status-deleted" />
    default:
      return <FileCode size={14} />
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case 'modified':
      return 'M'
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'untracked':
      return 'U'
    default:
      return '?'
  }
}

function ChangeItem({ change, onStage, onUnstage, onViewDiff }: ChangeItemProps) {
  const filename = change.path.split('/').pop() || change.path

  return (
    <div className="git-change-item">
      <span className="change-icon">{getStatusIcon(change.status)}</span>
      <span className="change-filename" title={change.path}>{filename}</span>
      <span className={`change-status status-${change.status}`}>
        {getStatusLabel(change.status)}
      </span>
      <div className="change-actions">
        <button
          className="change-action-btn"
          onClick={onViewDiff}
          title="View diff"
        >
          <Eye size={14} />
        </button>
        {change.staged ? (
          <button
            className="change-action-btn"
            onClick={onUnstage}
            title="Unstage"
          >
            <Minus size={14} />
          </button>
        ) : (
          <button
            className="change-action-btn"
            onClick={onStage}
            title="Stage"
          >
            <Plus size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

export function GitPanel({
  status,
  onStage,
  onUnstage,
  onCommit,
  onViewDiff,
  onRefresh,
}: GitPanelProps) {
  const [commitMessage, setCommitMessage] = useState('')
  const [isCommitting, setIsCommitting] = useState(false)
  const [showStaged, setShowStaged] = useState(true)
  const [showUnstaged, setShowUnstaged] = useState(true)
  const [showHistory, setShowHistory] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const stagedChanges = status.changes.filter(c => c.staged)
  const unstagedChanges = status.changes.filter(c => !c.staged)

  const handleCommit = async () => {
    if (!commitMessage.trim() || stagedChanges.length === 0) return

    setIsCommitting(true)
    try {
      await onCommit(commitMessage)
      setCommitMessage('')
    } finally {
      setIsCommitting(false)
    }
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    await onRefresh()
    setRefreshing(false)
  }

  const handleStageAll = () => {
    const paths = unstagedChanges.map(c => c.path)
    if (paths.length > 0) {
      onStage(paths)
    }
  }

  const handleUnstageAll = () => {
    const paths = stagedChanges.map(c => c.path)
    if (paths.length > 0) {
      onUnstage(paths)
    }
  }

  return (
    <div className="git-panel-container">
      {/* Header */}
      <div className="git-panel-header">
        <div className="git-panel-title">
          <GitBranch size={16} />
          <span>{status.branch}</span>
        </div>
        <div className="git-panel-actions">
          <button
            className="icon-button-small"
            onClick={() => setShowHistory(!showHistory)}
            title="History"
          >
            <History size={14} />
          </button>
          <button
            className={`icon-button-small ${refreshing ? 'spinning' : ''}`}
            onClick={handleRefresh}
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {showHistory ? (
        <CommitHistory
          projectPath=""
          encodedPath=""
          onClose={() => setShowHistory(false)}
        />
      ) : (
        <>
          {/* Staged Changes */}
          <div className="git-section">
            <div
              className="git-section-header"
              onClick={() => setShowStaged(!showStaged)}
            >
              {showStaged ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>Staged Changes</span>
              <span className="git-section-count">{stagedChanges.length}</span>
              {stagedChanges.length > 0 && (
                <button
                  className="git-section-action"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleUnstageAll()
                  }}
                  title="Unstage all"
                >
                  <Minus size={12} />
                </button>
              )}
            </div>
            {showStaged && stagedChanges.length > 0 && (
              <div className="git-section-content">
                {stagedChanges.map(change => (
                  <ChangeItem
                    key={`staged-${change.path}`}
                    change={change}
                    onStage={() => {}}
                    onUnstage={() => onUnstage([change.path])}
                    onViewDiff={() => onViewDiff(change.path, true)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Changes (Unstaged) */}
          <div className="git-section">
            <div
              className="git-section-header"
              onClick={() => setShowUnstaged(!showUnstaged)}
            >
              {showUnstaged ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>Changes</span>
              <span className="git-section-count">{unstagedChanges.length}</span>
              {unstagedChanges.length > 0 && (
                <button
                  className="git-section-action"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleStageAll()
                  }}
                  title="Stage all"
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
            {showUnstaged && unstagedChanges.length > 0 && (
              <div className="git-section-content">
                {unstagedChanges.map(change => (
                  <ChangeItem
                    key={`unstaged-${change.path}`}
                    change={change}
                    onStage={() => onStage([change.path])}
                    onUnstage={() => {}}
                    onViewDiff={() => onViewDiff(change.path, false)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Commit Section */}
          <div className="git-commit-section">
            <textarea
              className="git-commit-input"
              placeholder="Commit message"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              rows={3}
            />
            <button
              className="git-commit-btn"
              onClick={handleCommit}
              disabled={!commitMessage.trim() || stagedChanges.length === 0 || isCommitting}
            >
              {isCommitting ? (
                <div className="spinner-small" />
              ) : (
                <>
                  <Check size={14} />
                  <span>Commit</span>
                </>
              )}
            </button>
          </div>

          {/* Status Summary */}
          {status.isClean && (
            <div className="git-clean-status">
              <Check size={16} />
              <span>Working tree clean</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
