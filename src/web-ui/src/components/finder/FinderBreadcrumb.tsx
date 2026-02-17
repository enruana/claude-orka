import { ChevronRight } from 'lucide-react'

interface FinderBreadcrumbProps {
  projectName: string
  currentPath: string
  onNavigate: (path: string) => void
}

export function FinderBreadcrumb({ projectName, currentPath, onNavigate }: FinderBreadcrumbProps) {
  const segments = currentPath ? currentPath.split('/') : []

  return (
    <div className="finder-breadcrumb">
      <button
        className={`breadcrumb-segment ${segments.length === 0 ? 'current' : ''}`}
        onClick={() => onNavigate('')}
        disabled={segments.length === 0}
      >
        {projectName}
      </button>

      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1
        const segmentPath = segments.slice(0, i + 1).join('/')

        return (
          <span key={segmentPath} className="breadcrumb-part">
            <ChevronRight size={14} className="breadcrumb-separator" />
            <button
              className={`breadcrumb-segment ${isLast ? 'current' : ''}`}
              onClick={() => onNavigate(segmentPath)}
              disabled={isLast}
            >
              {segment}
            </button>
          </span>
        )
      })}
    </div>
  )
}
