import { useMemo } from 'react'
import type { Session } from '../../../../../src/models/Session'
import {
  TimelineLayout,
  LayoutConfig,
  LayoutNode,
  Connection,
  BranchLane,
  DEFAULT_LAYOUT_CONFIG,
  sessionToTimelineEvents,
  buildBranchLanes,
} from './types'

/**
 * React hook that calculates timeline layout positions for nodes and connections
 * based on a Session object.
 *
 * @param session - The session to layout, or null
 * @param config - Partial layout configuration to override defaults
 * @returns TimelineLayout with calculated positions, or null if no session
 */
export function useTimelineLayout(
  session: Session | null,
  config: Partial<LayoutConfig> = {}
): TimelineLayout | null {
  return useMemo(() => {
    if (!session) {
      return null
    }

    // Merge config with defaults
    const mergedConfig: LayoutConfig = {
      ...DEFAULT_LAYOUT_CONFIG,
      ...config,
    }

    const { rowHeight, laneWidth, padding, nodeRadius } = mergedConfig

    // Convert session to timeline events
    const events = sessionToTimelineEvents(session)

    if (events.length === 0) {
      return null
    }

    // Build branch lanes
    const branches = buildBranchLanes(events, session)

    // Create a lookup map for branches by id
    const branchMap = new Map<string, BranchLane>()
    for (const branch of branches) {
      branchMap.set(branch.id, branch)
    }

    // Calculate LayoutNode positions
    const nodes: LayoutNode[] = events.map((event, eventIndex) => {
      const branch = branchMap.get(event.branchId)
      const lane = branch?.lane ?? 0

      return {
        event,
        x: padding + lane * laneWidth,
        y: padding + eventIndex * rowHeight,
        lane,
        branch: branch ?? branches[0], // Fallback to main if not found
      }
    })

    // Generate connections
    const connections: Connection[] = []

    // Group events by branch
    const eventsByBranch = new Map<string, LayoutNode[]>()
    for (const node of nodes) {
      const branchId = node.event.branchId
      if (!eventsByBranch.has(branchId)) {
        eventsByBranch.set(branchId, [])
      }
      eventsByBranch.get(branchId)!.push(node)
    }

    // Find the Y extent for the entire timeline
    const lastNodeY = nodes.length > 0 ? nodes[nodes.length - 1].y : padding

    // Identify which branches have children (need extended vertical lines)
    const branchesWithChildren = new Set<string>()
    branchesWithChildren.add('main')
    for (const branch of branches) {
      if (branch.parentId && branch.parentId !== 'main') {
        branchesWithChildren.add(branch.parentId)
      }
    }

    // Find children for each branch to determine line extension
    const childrenByParent = new Map<string, LayoutNode[]>()
    for (const node of nodes) {
      const parentId = node.event.parentBranchId
      if (parentId) {
        if (!childrenByParent.has(parentId)) {
          childrenByParent.set(parentId, [])
        }
        childrenByParent.get(parentId)!.push(node)
      }
    }

    // === STEP 1: Draw vertical backbone for EACH branch ===
    for (const branch of branches) {
      const branchNodes = eventsByBranch.get(branch.id) || []
      if (branchNodes.length === 0) continue

      const branchX = padding + branch.lane * laneWidth
      const sortedNodes = [...branchNodes].sort((a, b) => a.y - b.y)
      const firstNode = sortedNodes[0]
      const lastNode = sortedNodes[sortedNodes.length - 1]

      // Determine where this branch's line should end
      let endY = lastNode.y

      // If branch has children, extend line to cover all children's Y positions
      const children = childrenByParent.get(branch.id) || []
      if (children.length > 0) {
        const maxChildY = Math.max(...children.map(c => c.y))
        endY = Math.max(endY, maxChildY)
      }

      // If branch is active or saved, extend to bottom of timeline
      if (branch.status === 'active' || branch.status === 'saved') {
        endY = Math.max(endY, lastNodeY + rowHeight / 2)
      }

      // For main branch, always extend to bottom
      if (branch.id === 'main') {
        endY = lastNodeY + rowHeight / 2
      }

      // Draw vertical line for this branch (start after node, end at bottom)
      const lineStartY = firstNode.y + nodeRadius
      if (endY > lineStartY) {
        connections.push({
          id: `backbone-${branch.id}`,
          type: 'continuation',
          fromX: branchX,
          fromY: lineStartY,
          toX: branchX,
          toY: endY,
          color: branch.color,
          animated: branch.status === 'active',
        })
      }
    }

    // === STEP 2: Draw fork curves (from parent backbone to fork start) ===
    for (const node of nodes) {
      const { event } = node

      if (event.type === 'fork-create' && event.parentBranchId) {
        const parentBranch = branchMap.get(event.parentBranchId)
        if (parentBranch) {
          const parentX = padding + parentBranch.lane * laneWidth

          // Horizontal line from parent's vertical line to fork node's left edge
          connections.push({
            id: `fork-${event.id}`,
            type: 'fork',
            fromX: parentX,
            fromY: node.y,
            toX: node.x - nodeRadius,
            toY: node.y,
            color: node.branch.color,
            animated: node.branch.status === 'active',
          })
        }
      }

      // === STEP 3: Draw merge curves for merged forks ===
      // Draw merge curve from fork-create node if the branch is merged
      if (event.type === 'fork-create' && node.branch.status === 'merged' && event.parentBranchId) {
        const parentBranch = branchMap.get(event.parentBranchId)
        if (parentBranch) {
          const parentX = padding + parentBranch.lane * laneWidth

          // L-shape from fork node's bottom edge back to parent's vertical line
          connections.push({
            id: `merge-${event.id}`,
            type: 'merge',
            fromX: node.x,
            fromY: node.y + nodeRadius,
            toX: parentX,
            toY: node.y,
            color: node.branch.color,
            animated: false,
          })
        }
      }
    }

    // Calculate total dimensions
    const maxLane = Math.max(...branches.map((b) => b.lane))
    const totalWidth = padding * 2 + (maxLane + 1) * laneWidth
    const totalHeight = padding * 2 + events.length * rowHeight

    return {
      nodes,
      connections,
      branches,
      totalHeight,
      totalWidth,
    }
  }, [session, config])
}
