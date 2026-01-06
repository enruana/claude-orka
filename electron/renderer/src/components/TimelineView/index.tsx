import React, { useRef, useCallback, useEffect } from 'react'
import type { Session } from '../../../../../src/models/Session'
import { useTimelineLayout } from './useTimelineLayout'
import { TimelineGraph } from './TimelineGraph'
import { TimelineRow } from './TimelineRow'
import { BranchLabel } from './BranchLabel'
import { DEFAULT_LAYOUT_CONFIG, LayoutConfig } from './types'

// Scrollbar styles
const scrollbarStyles = `
  .timeline-scroll-container::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  .timeline-scroll-container::-webkit-scrollbar-track {
    background: #181825;
    border-radius: 4px;
  }
  .timeline-scroll-container::-webkit-scrollbar-thumb {
    background: #45475a;
    border-radius: 4px;
  }
  .timeline-scroll-container::-webkit-scrollbar-thumb:hover {
    background: #585b70;
  }
  .timeline-scroll-container::-webkit-scrollbar-corner {
    background: #181825;
  }
`

interface TimelineViewProps {
  session: Session
  selectedNode: string
  onNodeClick: (nodeId: string) => void
  config?: Partial<LayoutConfig>
}

/**
 * Main TimelineView component - GitKraken-style visualization
 * Displays a synchronized graph and info panel
 */
export function TimelineView({
  session,
  selectedNode,
  onNodeClick,
  config = {},
}: TimelineViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const mergedConfig = { ...DEFAULT_LAYOUT_CONFIG, ...config }

  const layout = useTimelineLayout(session, mergedConfig)

  // Track which branches have their label visible (first occurrence)
  const getVisibleLabelNodes = useCallback(() => {
    if (!layout) return new Set<string>()
    const seen = new Set<string>()
    const visible = new Set<string>()

    for (const node of layout.nodes) {
      if (!seen.has(node.event.branchId)) {
        seen.add(node.event.branchId)
        visible.add(node.event.id)
      }
    }
    return visible
  }, [layout])

  const visibleLabels = getVisibleLabelNodes()

  if (!layout || layout.nodes.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: '#6c7086',
        }}
      >
        No timeline events
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: '#1e1e2e',
        overflow: 'hidden',
      }}
    >
      {/* Inject scrollbar styles */}
      <style>{scrollbarStyles}</style>

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '10px 14px',
          backgroundColor: '#181825',
          borderBottom: '1px solid #313244',
        }}
      >
        <span style={{ color: '#cdd6f4', fontSize: 12, fontWeight: 500 }}>
          Timeline
        </span>
        <span style={{ color: '#6c7086', fontSize: 11, marginLeft: 8 }}>
          {layout.nodes.length} events
        </span>
      </div>

      {/* Scrollable content */}
      <div
        ref={scrollContainerRef}
        className="timeline-scroll-container"
        style={{
          flex: 1,
          display: 'flex',
          overflow: 'auto',
          backgroundColor: '#11111b',
        }}
      >
        {/* Labels column */}
        <div
          style={{
            width: mergedConfig.labelColumnWidth,
            flexShrink: 0,
            position: 'relative',
            borderRight: '1px solid #313244',
            paddingTop: mergedConfig.padding,
          }}
        >
          {layout.nodes.map((node) => (
            visibleLabels.has(node.event.id) && (
              <BranchLabel
                key={`label-${node.event.id}`}
                branch={node.branch}
                y={node.y + mergedConfig.nodeRadius}
                isVisible={true}
                onClick={() => onNodeClick(node.event.branchId)}
              />
            )
          ))}
          {/* Spacer to match total height */}
          <div style={{ height: layout.totalHeight }} />
        </div>

        {/* Graph column */}
        <div
          style={{
            width: layout.totalWidth + 20,
            flexShrink: 0,
            borderRight: '1px solid #313244',
          }}
        >
          <TimelineGraph
            layout={layout}
            config={mergedConfig}
            selectedNodeId={selectedNode}
            onNodeClick={onNodeClick}
          />
        </div>

        {/* Info column */}
        <div
          style={{
            flex: 1,
            minWidth: mergedConfig.infoColumnWidth,
            paddingTop: mergedConfig.padding - mergedConfig.rowHeight / 2 + mergedConfig.nodeRadius,
            paddingRight: 16,
          }}
        >
          {layout.nodes.map((node) => (
            <TimelineRow
              key={`row-${node.event.id}`}
              node={node}
              rowHeight={mergedConfig.rowHeight}
              isSelected={node.event.branchId === selectedNode}
              onClick={() => onNodeClick(node.event.branchId)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export default TimelineView
