import React from 'react'

export type ViewMode = 'tree' | 'timeline'

interface ViewSwitcherProps {
  currentView: ViewMode
  onViewChange: (view: ViewMode) => void
}

/**
 * Toggle button to switch between Tree view and Timeline view
 */
export function ViewSwitcher({ currentView, onViewChange }: ViewSwitcherProps) {
  return (
    <div
      style={{
        display: 'flex',
        backgroundColor: '#313244',
        borderRadius: 6,
        padding: 2,
        gap: 2,
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <button
        onClick={() => onViewChange('timeline')}
        style={{
          padding: '4px 10px',
          fontSize: 11,
          fontWeight: 500,
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          backgroundColor: currentView === 'timeline' ? '#89b4fa' : 'transparent',
          color: currentView === 'timeline' ? '#1e1e2e' : '#a6adc8',
        }}
        title="Timeline View (GitKraken style)"
      >
        Timeline
      </button>
      <button
        onClick={() => onViewChange('tree')}
        style={{
          padding: '4px 10px',
          fontSize: 11,
          fontWeight: 500,
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          backgroundColor: currentView === 'tree' ? '#89b4fa' : 'transparent',
          color: currentView === 'tree' ? '#1e1e2e' : '#a6adc8',
        }}
        title="Tree View (ReactFlow)"
      >
        Tree
      </button>
    </div>
  )
}

export default ViewSwitcher
