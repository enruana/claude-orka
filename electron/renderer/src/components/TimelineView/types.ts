import type { Fork } from '../../../../../src/models/Fork'
import type { Session } from '../../../../../src/models/Session'

// ============================================
// TIMELINE DATA MODEL
// ============================================

export type TimelineEventType =
  | 'session-start'
  | 'fork-create'
  | 'fork-merge'
  | 'fork-close'
  | 'fork-save'

export type BranchStatus = 'active' | 'saved' | 'closed' | 'merged'

export interface TimelineEvent {
  id: string
  type: TimelineEventType
  branchId: string          // 'main' or fork.id
  parentBranchId?: string   // For fork events, which branch it came from
  timestamp: string
  label: string
  description?: string
  status?: BranchStatus
}

export interface BranchLane {
  id: string                // 'main' or fork.id
  name: string
  color: string
  lane: number              // X position (0 = main, 1+ = forks)
  parentId: string          // 'main' for first-level forks
  status: BranchStatus
  startEventIndex: number   // First event index in timeline
  endEventIndex?: number    // Last event index (if closed/merged)
}

// ============================================
// LAYOUT TYPES
// ============================================

export interface LayoutConfig {
  rowHeight: number         // Height of each row
  laneWidth: number         // Width of each lane
  nodeRadius: number        // Radius of node circles
  padding: number           // Padding around the graph
  labelColumnWidth: number  // Width of labels column
  infoColumnWidth: number   // Width of info column
}

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  rowHeight: 44,
  laneWidth: 50,  // Distance between lanes (main to forks)
  nodeRadius: 9,
  padding: 40,    // Padding around the graph
  labelColumnWidth: 220,  // Width for branch names and badges
  infoColumnWidth: 300,
}

export interface LayoutNode {
  event: TimelineEvent
  x: number                 // Pixel X position
  y: number                 // Pixel Y position
  lane: number              // Lane index
  branch: BranchLane
  isSelected?: boolean
}

export interface Connection {
  id: string
  type: 'continuation' | 'fork' | 'merge'
  fromX: number
  fromY: number
  toX: number
  toY: number
  color: string
  animated?: boolean        // For active branches
}

export interface TimelineLayout {
  nodes: LayoutNode[]
  connections: Connection[]
  branches: BranchLane[]
  totalHeight: number
  totalWidth: number
}

// ============================================
// BRANCH COLORS (Catppuccin Mocha palette)
// ============================================

export const BRANCH_COLORS = [
  '#a6e3a1', // Green - main
  '#89b4fa', // Blue - fork 1
  '#f9e2af', // Yellow - fork 2
  '#cba6f7', // Purple - fork 3
  '#f38ba8', // Pink - fork 4
  '#94e2d5', // Teal - fork 5
  '#fab387', // Peach - fork 6
  '#74c7ec', // Sapphire - fork 7
]

export function getBranchColor(index: number): string {
  return BRANCH_COLORS[index % BRANCH_COLORS.length]
}

// ============================================
// CONVERSION UTILITIES
// ============================================

/**
 * Convert a Session to timeline events
 */
export function sessionToTimelineEvents(session: Session): TimelineEvent[] {
  const events: TimelineEvent[] = []

  // Session start event
  events.push({
    id: 'main-start',
    type: 'session-start',
    branchId: 'main',
    timestamp: session.createdAt,
    label: session.name,
    description: 'Session started',
    status: session.main?.status || session.status,
  })

  // Fork events
  const forks = session.forks || []
  for (const fork of forks) {
    // Fork creation
    events.push({
      id: `${fork.id}-create`,
      type: 'fork-create',
      branchId: fork.id,
      parentBranchId: fork.parentId,
      timestamp: fork.createdAt,
      label: fork.name,
      description: `Forked from ${fork.parentId === 'main' ? 'MAIN' : fork.parentId}`,
      status: fork.status,
    })

    // Fork end events
    if (fork.status === 'merged' && fork.closedAt) {
      events.push({
        id: `${fork.id}-merge`,
        type: 'fork-merge',
        branchId: fork.id,
        parentBranchId: fork.parentId,
        timestamp: fork.closedAt,
        label: `Merged: ${fork.name}`,
        description: `Merged back to ${fork.parentId === 'main' ? 'MAIN' : fork.parentId}`,
        status: 'merged',
      })
    } else if (fork.status === 'closed' && fork.closedAt) {
      events.push({
        id: `${fork.id}-close`,
        type: 'fork-close',
        branchId: fork.id,
        timestamp: fork.closedAt,
        label: `Closed: ${fork.name}`,
        description: 'Fork closed without merge',
        status: 'closed',
      })
    } else if (fork.status === 'saved') {
      // For saved forks, we don't add an end event
      // They're just paused
    }
  }

  // Sort by timestamp
  return events.sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )
}

/**
 * Build branch lanes from events
 *
 * Lane assignment rules:
 * - main = lane 0 (always has vertical line)
 * - forks that have children = get their own unique lane (need vertical line for children to connect)
 * - forks without children = placed at parent lane + 1
 *
 * This ensures parent forks have their own vertical line that children can connect to.
 */
export function buildBranchLanes(
  events: TimelineEvent[],
  session: Session
): BranchLane[] {
  const branches: BranchLane[] = []
  const forks = session.forks || []

  // First pass: identify which forks have children
  const forksWithChildren = new Set<string>()
  forksWithChildren.add('main') // main always "has children"

  for (const fork of forks) {
    if (fork.parentId && fork.parentId !== 'main') {
      forksWithChildren.add(fork.parentId)
    }
  }

  // Also mark active/saved forks as needing their own lane (they have ongoing vertical lines)
  for (const fork of forks) {
    if (fork.status === 'active' || fork.status === 'saved') {
      forksWithChildren.add(fork.id)
    }
  }

  // Assign lanes
  const laneMap = new Map<string, number>()
  laneMap.set('main', 0)

  // Sort forks by creation order
  const sortedForks = [...forks].sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )

  let nextLane = 1

  // First, assign lanes to forks that need their own vertical line
  for (const fork of sortedForks) {
    if (forksWithChildren.has(fork.id)) {
      laneMap.set(fork.id, nextLane)
      nextLane++
    }
  }

  // Then, assign lanes to remaining forks (leaf forks without children)
  for (const fork of sortedForks) {
    if (!laneMap.has(fork.id)) {
      const parentLane = laneMap.get(fork.parentId) ?? 0
      // Place at parent lane + 1, but use nextLane if parent has many children
      laneMap.set(fork.id, nextLane)
      nextLane++
    }
  }

  // Main branch is always lane 0
  branches.push({
    id: 'main',
    name: 'MAIN',
    color: getBranchColor(0),
    lane: 0,
    parentId: '',
    status: session.main?.status || session.status,
    startEventIndex: 0,
  })

  // Add fork branches with assigned lanes
  for (const fork of sortedForks) {
    const startIndex = events.findIndex(e => e.id === `${fork.id}-create`)
    const endIndex = events.findIndex(e =>
      e.id === `${fork.id}-merge` || e.id === `${fork.id}-close`
    )

    const lane = laneMap.get(fork.id) ?? 1

    branches.push({
      id: fork.id,
      name: fork.name,
      color: getBranchColor(lane),
      lane,
      parentId: fork.parentId,
      status: fork.status,
      startEventIndex: startIndex >= 0 ? startIndex : 0,
      endEventIndex: endIndex >= 0 ? endIndex : undefined,
    })
  }

  return branches
}
