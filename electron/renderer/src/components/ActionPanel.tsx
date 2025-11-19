import { GitBranch, Upload, GitMerge } from 'lucide-react'

interface ActionPanelProps {
  selectedNode: string
  onCreateFork: () => void
  onExportFork: () => void
  onMergeFork: () => void
}

export function ActionPanel({
  selectedNode,
  onCreateFork,
  onExportFork,
  onMergeFork,
}: ActionPanelProps) {
  const isForkSelected = selectedNode !== 'main'

  return (
    <div className="action-panel">
      <div className="action-panel-header">
        <span className="action-panel-title">
          Actions for: <strong>{selectedNode === 'main' ? 'MAIN' : selectedNode.slice(0, 8)}...</strong>
        </span>
      </div>

      <div className="action-buttons">
        <button
          className="action-button primary"
          onClick={onCreateFork}
          title="Create a new fork from the current branch"
        >
          <GitBranch size={18} />
          <span>New Fork</span>
        </button>

        <button
          className="action-button"
          onClick={onExportFork}
          disabled={!isForkSelected}
          title="Export fork summary"
        >
          <Upload size={18} />
          <span>Export</span>
        </button>

        <button
          className="action-button"
          onClick={onMergeFork}
          disabled={!isForkSelected}
          title="Merge fork back to main"
        >
          <GitMerge size={18} />
          <span>Merge</span>
        </button>
      </div>
    </div>
  )
}
