/**
 * Brand mark for the host operating system.
 *
 * Inline SVG rather than an icon-pack import or a remote asset: these
 * three are the whole set we'll ever need, they must inherit
 * `currentColor` to sit inside a badge, and the launcher already renders
 * offline against a local server.
 *
 * All three are monochrome silhouettes on purpose — a full-colour Tux
 * turns to mush at 13px, and a single ink colour keeps the mark
 * consistent with the rest of the widget's chrome.
 *
 * The penguin's eyes and beak are cut out with a `<mask>` rather than
 * painted in the background colour, so the logo stays correct on any
 * surface it's dropped onto.
 */

export type OsKind = 'macos' | 'linux' | 'windows' | 'unknown'

/** Map Node's `os.platform()` to the mark we draw. */
export function osKindFromPlatform(platform: string): OsKind {
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  if (platform === 'win32') return 'windows'
  return 'unknown'
}

/** Human-facing name — what the badge prints and the tooltip spells out. */
export function osLabel(kind: OsKind, platform: string): string {
  switch (kind) {
    case 'macos': return 'macOS'
    case 'linux': return 'Linux'
    case 'windows': return 'Windows'
    default: return platform || 'unknown'
  }
}

interface OsLogoProps {
  kind: OsKind
  size?: number
  /** Unique suffix for the penguin's mask id. Two OS logos on one page
   *  would otherwise share an id and the second would render unmasked. */
  idSuffix?: string
}

export function OsLogo({ kind, size = 13, idSuffix = 'os' }: OsLogoProps) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    'aria-hidden': true as const,
    focusable: 'false' as const,
  }

  if (kind === 'macos') {
    return (
      <svg {...common} fill="currentColor">
        <path d="M17.05 12.54c-.02-2.35 1.92-3.48 2.01-3.54-1.1-1.6-2.8-1.82-3.4-1.85-1.45-.15-2.83.85-3.56.85-.74 0-1.87-.83-3.07-.81-1.58.02-3.04.92-3.85 2.33-1.64 2.85-.42 7.07 1.18 9.38.78 1.13 1.71 2.4 2.93 2.35 1.18-.05 1.62-.76 3.05-.76 1.42 0 1.83.76 3.07.74 1.27-.02 2.07-1.15 2.85-2.29.9-1.31 1.27-2.58 1.29-2.65-.03-.01-2.47-.95-2.5-3.76zM14.7 5.6c.65-.79 1.09-1.89.97-2.98-.94.04-2.07.62-2.74 1.41-.6.7-1.13 1.82-.99 2.89 1.05.08 2.11-.53 2.76-1.32z" />
      </svg>
    )
  }

  if (kind === 'windows') {
    return (
      <svg {...common} fill="currentColor">
        <path d="M3 5.7l7.3-1v7.1H3zM11.3 4.5L21 3.1v8.7h-9.7zM3 12.8h7.3v7.1L3 18.9zM11.3 12.8H21v8.7l-9.7-1.4z" />
      </svg>
    )
  }

  if (kind === 'linux') {
    const maskId = `orka-tux-${idSuffix}`
    return (
      <svg {...common}>
        <defs>
          <mask id={maskId}>
            <rect width="24" height="24" fill="#fff" />
            <ellipse cx="10.4" cy="6.6" rx="1.02" ry="1.32" fill="#000" />
            <ellipse cx="13.6" cy="6.6" rx="1.02" ry="1.32" fill="#000" />
            <path d="M9.9 8.7h4.2c.3 0 .45.25.3.5l-.85 1.15c-.35.45-1.05.45-1.4 0l-.85-1.15c-.15-.25 0-.5.3-.5z" fill="#000" />
          </mask>
        </defs>
        <g fill="currentColor" mask={`url(#${maskId})`}>
          {/* Feet first so the body overlaps them, which is what gives
              the silhouette its splayed-foot read at small sizes. */}
          <ellipse cx="8.3" cy="21.4" rx="3.2" ry="1.5" transform="rotate(-18 8.3 21.4)" />
          <ellipse cx="15.7" cy="21.4" rx="3.2" ry="1.5" transform="rotate(18 15.7 21.4)" />
          <path d="M12 2.2c-2.6 0-4.35 2-4.35 4.6 0 1.3.35 2.2.35 2.9 0 1.1-2.9 2.9-2.9 7 0 3.5 3.1 5.4 6.9 5.4s6.9-1.9 6.9-5.4c0-4.1-2.9-5.9-2.9-7 0-.7.35-1.6.35-2.9 0-2.6-1.75-4.6-4.35-4.6z" />
        </g>
      </svg>
    )
  }

  // Unknown platform: a neutral monitor outline, so the badge keeps its
  // shape instead of collapsing.
  return (
    <svg {...common} fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M9 21h6" />
    </svg>
  )
}
