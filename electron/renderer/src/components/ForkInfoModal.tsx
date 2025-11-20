import { X, FileText } from 'lucide-react'
import type { Fork } from '../../../../src/models/Fork'

interface ForkInfoModalProps {
  fork: Fork
  onClose: () => void
  onOpenExport?: () => void
}

export function ForkInfoModal({ fork, onClose, onOpenExport }: ForkInfoModalProps) {
  const statusColor = {
    active: '#a6e3a1',
    saved: '#f9e2af',
    closed: '#f38ba8',
    merged: '#94e2d5',
  }[fork.status]

  const statusLabel = {
    active: 'Active',
    saved: 'Saved',
    closed: 'Closed',
    merged: 'Merged',
  }[fork.status]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal fork-info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Fork Details</h3>
          <button className="modal-close-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="fork-info-content">
          <div className="info-row">
            <span className="info-label">Name:</span>
            <span className="info-value">{fork.name}</span>
          </div>

          <div className="info-row">
            <span className="info-label">ID:</span>
            <span className="info-value fork-id">{fork.id}</span>
          </div>

          <div className="info-row">
            <span className="info-label">Claude Session ID:</span>
            <span className="info-value fork-id">{fork.claudeSessionId}</span>
          </div>

          <div className="info-row">
            <span className="info-label">Status:</span>
            <span className="info-value">
              <span className="status-badge" style={{ borderColor: statusColor, color: statusColor }}>
                {statusLabel}
              </span>
            </span>
          </div>

          <div className="info-row">
            <span className="info-label">Created:</span>
            <span className="info-value">{new Date(fork.createdAt).toLocaleString()}</span>
          </div>

          {fork.status === 'merged' && fork.mergedAt && (
            <div className="info-row">
              <span className="info-label">Merged:</span>
              <span className="info-value">{new Date(fork.mergedAt).toLocaleString()}</span>
            </div>
          )}

          {fork.contextPath && (
            <div className="info-row">
              <span className="info-label">Export Path:</span>
              <span className="info-value export-path">{fork.contextPath}</span>
            </div>
          )}
        </div>

        {fork.status === 'merged' && fork.contextPath && onOpenExport && (
          <div className="modal-actions">
            <button className="button-primary" onClick={onOpenExport}>
              <FileText size={16} />
              Open Export File
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
