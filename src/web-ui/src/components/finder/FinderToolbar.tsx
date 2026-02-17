import { ChevronLeft, ChevronRight, List, LayoutGrid, FilePlus, FolderPlus } from 'lucide-react'
import { FinderBreadcrumb } from './FinderBreadcrumb'

interface FinderToolbarProps {
  projectName: string
  currentPath: string
  canGoBack: boolean
  canGoForward: boolean
  viewMode: 'list' | 'grid'
  onNavigate: (path: string) => void
  onGoBack: () => void
  onGoForward: () => void
  onViewModeChange: (mode: 'list' | 'grid') => void
  onNewFile: () => void
  onNewFolder: () => void
}

export function FinderToolbar({
  projectName,
  currentPath,
  canGoBack,
  canGoForward,
  viewMode,
  onNavigate,
  onGoBack,
  onGoForward,
  onViewModeChange,
  onNewFile,
  onNewFolder,
}: FinderToolbarProps) {
  return (
    <div className="finder-toolbar">
      <div className="finder-toolbar-left">
        <button
          className="finder-nav-btn"
          onClick={onGoBack}
          disabled={!canGoBack}
          title="Go back"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          className="finder-nav-btn"
          onClick={onGoForward}
          disabled={!canGoForward}
          title="Go forward"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="finder-toolbar-center">
        <FinderBreadcrumb
          projectName={projectName}
          currentPath={currentPath}
          onNavigate={onNavigate}
        />
      </div>

      <div className="finder-toolbar-right">
        <button
          className={`finder-view-btn ${viewMode === 'list' ? 'active' : ''}`}
          onClick={() => onViewModeChange('list')}
          title="List view"
        >
          <List size={16} />
        </button>
        <button
          className={`finder-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
          onClick={() => onViewModeChange('grid')}
          title="Grid view"
        >
          <LayoutGrid size={16} />
        </button>
        <div className="finder-toolbar-divider" />
        <button className="finder-action-btn" onClick={onNewFile} title="New File">
          <FilePlus size={16} />
        </button>
        <button className="finder-action-btn" onClick={onNewFolder} title="New Folder">
          <FolderPlus size={16} />
        </button>
      </div>
    </div>
  )
}
