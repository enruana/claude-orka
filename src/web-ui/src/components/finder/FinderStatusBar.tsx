interface FinderStatusBarProps {
  itemCount: number
  selectedCount: number
  currentPath: string
}

export function FinderStatusBar({ itemCount, selectedCount, currentPath }: FinderStatusBarProps) {
  const label = selectedCount > 0
    ? `${itemCount} items, ${selectedCount} selected`
    : `${itemCount} items`

  return (
    <div className="finder-status-bar">
      <span className="finder-status-left">{label}</span>
      <span className="finder-status-right">{currentPath || '/'}</span>
    </div>
  )
}
