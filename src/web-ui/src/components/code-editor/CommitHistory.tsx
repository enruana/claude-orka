import { useState, useEffect } from 'react'
import { GitCommit, Clock, User, ChevronLeft } from 'lucide-react'
import { api, GitCommitLog } from '../../api/client'

interface CommitHistoryProps {
  projectPath: string
  encodedPath: string
  onClose: () => void
}

export function CommitHistory({ encodedPath, onClose }: CommitHistoryProps) {
  const [commits, setCommits] = useState<GitCommitLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadCommits = async () => {
      if (!encodedPath) return

      try {
        setLoading(true)
        const result = await api.getGitLog(encodedPath, 50)
        setCommits(result)
      } catch (err: any) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    loadCommits()
  }, [encodedPath])

  if (loading) {
    return (
      <div className="commit-history-loading">
        <div className="spinner-small" />
        <span>Loading history...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="commit-history-error">
        <span>{error}</span>
        <button onClick={onClose}>Close</button>
      </div>
    )
  }

  return (
    <div className="commit-history">
      <div className="commit-history-header">
        <button className="back-btn" onClick={onClose}>
          <ChevronLeft size={16} />
        </button>
        <span>Commit History</span>
        <span className="commit-count">{commits.length}</span>
      </div>
      <div className="commit-history-list">
        {commits.length === 0 ? (
          <div className="commit-history-empty">
            <GitCommit size={24} />
            <p>No commits yet</p>
          </div>
        ) : (
          commits.map(commit => (
            <div key={commit.hash} className="commit-item">
              <div className="commit-graph">
                <div className="commit-dot" />
                <div className="commit-line" />
              </div>
              <div className="commit-content">
                <div className="commit-message">{commit.message}</div>
                <div className="commit-meta">
                  <span className="commit-hash">{commit.shortHash}</span>
                  <span className="commit-author">
                    <User size={12} />
                    {commit.author}
                  </span>
                  <span className="commit-date">
                    <Clock size={12} />
                    {commit.relativeDate}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
