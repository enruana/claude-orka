import { GitBranch, Upload, GitMerge, X } from 'lucide-react'

interface ActionPanelProps {
  selectedNode: string
  onCreateFork: () => void
  onExportFork: () => void
  onMergeFork: () => void
  onCloseFork: () => void
  isCreatingFork: boolean
  isExporting: boolean
  isMerging: boolean
  isClosing: boolean
  canCreateFork: boolean
}

export function ActionPanel({
  selectedNode,
  onCreateFork,
  onExportFork,
  onMergeFork,
  onCloseFork,
  isCreatingFork,
  isExporting,
  isMerging,
  isClosing,
  canCreateFork,
}: ActionPanelProps) {
  const isForkSelected = selectedNode !== 'main'
  const isAnyOperationInProgress = isCreatingFork || isExporting || isMerging || isClosing

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
          disabled={!canCreateFork || isAnyOperationInProgress}
          title={
            !canCreateFork
              ? 'Claude Code limitation: Only one active fork allowed per branch. Merge the existing fork or create from it.'
              : 'Create a new fork from the current branch'
          }
        >
          <GitBranch size={18} />
          <span>{isCreatingFork ? 'Creating...' : 'New Fork'}</span>
        </button>

        <button
          className="action-button"
          onClick={onExportFork}
          disabled={!isForkSelected || isAnyOperationInProgress}
          title="Export fork summary"
        >
          <Upload size={18} />
          <span>{isExporting ? 'Exporting...' : 'Export'}</span>
        </button>

        <button
          className="action-button"
          onClick={onMergeFork}
          disabled={!isForkSelected || isAnyOperationInProgress}
          title="Merge fork back to parent"
        >
          <GitMerge size={18} />
          <span>{isMerging ? 'Merging...' : 'Merge'}</span>
        </button>

        <button
          className="action-button danger"
          onClick={onCloseFork}
          disabled={!isForkSelected || isAnyOperationInProgress}
          title="Close fork (abandon experiment)"
        >
          <X size={18} />
          <span>{isClosing ? 'Closing...' : 'Close'}</span>
        </button>
      </div>
    </div>
  )
}
