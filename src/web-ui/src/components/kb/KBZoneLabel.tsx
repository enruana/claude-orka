import { memo } from 'react'
import {
  Target, Layers, FolderKanban, ListChecks, Lightbulb, Bug,
  CheckCircle, HelpCircle, Calendar, Flag, Compass,
  User, GitBranch, FileText, BookOpen, Activity,
  type LucideIcon,
} from 'lucide-react'

const TYPE_ICONS: Record<string, LucideIcon> = {
  goal: Target, initiative: Layers, project: FolderKanban,
  task: ListChecks, spike: Lightbulb, bug: Bug,
  decision: CheckCircle, question: HelpCircle, meeting: Calendar,
  milestone: Flag, direction: Compass,
  person: User, repo: GitBranch, artifact: FileText, context: BookOpen,
  activity: Activity,
}

const TYPE_COLORS: Record<string, string> = {
  goal: '#f38ba8', initiative: '#eba0ac', project: '#f38ba8',
  task: '#94e2d5', spike: '#eed49f', bug: '#ed8796',
  decision: '#a6e3a1', question: '#f9e2af', meeting: '#cba6f7',
  milestone: '#f5c2e7', direction: '#fab387',
  person: '#89b4fa', repo: '#89dceb', artifact: '#a6adc8', context: '#6c7086',
  activity: '#7f849c',
}

interface KBZoneLabelProps {
  data: {
    type: string
    label: string
    count: number
    radius: number
    pillOffset: number
    nucleus?: boolean
  }
}

/**
 * Cluster backdrop: a soft circular halo (radial gradient) with a floating
 * pill label hovering above it. Renders inside the ReactFlow canvas as a
 * non-interactive node — pointer-events:none in CSS lets clicks fall
 * through to entity nodes scattered inside the halo.
 *
 * When `nucleus` is true (the centermost cluster, typically Projects), the
 * halo gets a brighter glow + a pulsing inner ring so it visually anchors
 * the universe.
 */
function KBZoneLabelComponent({ data }: KBZoneLabelProps) {
  const Icon = TYPE_ICONS[data.type]
  const color = TYPE_COLORS[data.type] || '#6c7086'
  const diameter = data.radius * 2
  const isNucleus = !!data.nucleus

  // Brighter alpha + tighter inset shadow for the nucleus
  const haloBg = isNucleus
    ? `radial-gradient(circle at center, ${color}33 0%, ${color}1C 50%, ${color}0A 80%, transparent 100%)`
    : `radial-gradient(circle at center, ${color}1A 0%, ${color}0A 55%, transparent 85%)`

  return (
    <div
      className={`kb-zone ${isNucleus ? 'is-nucleus' : ''}`}
      style={{
        width: diameter,
        height: diameter + data.pillOffset,
        position: 'relative',
      }}
    >
      {/* Floating pill label, perched above the halo */}
      <div
        className="kb-zone-pill"
        style={{
          borderColor: isNucleus ? color : `${color}66`,
          color,
          background: `linear-gradient(180deg, rgba(17,17,27,0.94) 0%, rgba(17,17,27,0.78) 100%)`,
          boxShadow: isNucleus ? `0 0 14px ${color}55` : 'none',
        }}
      >
        {Icon && <Icon size={isNucleus ? 12 : 11} strokeWidth={2.4} />}
        <span className="kb-zone-pill-label">{data.label}</span>
        <span className="kb-zone-pill-count">{data.count}</span>
      </div>

      {/* Outer pulsing ring — only on nucleus, gives the "atom is alive" feel */}
      {isNucleus && (
        <div
          className="kb-zone-pulse"
          style={{
            width: diameter,
            height: diameter,
            top: data.pillOffset,
            border: `1px solid ${color}55`,
          }}
        />
      )}

      {/* Soft circular halo — radial gradient core */}
      <div
        className="kb-zone-halo"
        style={{
          width: diameter,
          height: diameter,
          top: data.pillOffset,
          background: haloBg,
          boxShadow: isNucleus
            ? `inset 0 0 ${data.radius}px ${color}25, 0 0 ${data.radius * 0.4}px ${color}1A`
            : `inset 0 0 ${data.radius * 0.6}px ${color}10`,
          border: `1px dashed ${color}${isNucleus ? '3F' : '1F'}`,
        }}
      />
    </div>
  )
}

export const KBZoneLabel = memo(KBZoneLabelComponent)
