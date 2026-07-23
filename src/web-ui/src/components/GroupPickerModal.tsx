import { useEffect, useMemo, useRef, useState } from 'react'
import { Tag, Plus, X, Check, Ban } from 'lucide-react'
import './group-picker.css'

/**
 * Reusable group / tag picker.
 *
 * Shared between ProjectDashboard and the launcher's FolderOverlay so both
 * surfaces look and behave identically. Each existing group is a colored
 * chip (deterministic color per name); a "None" chip removes the group;
 * a text input creates a new one. Applying closes the modal via the
 * `onApply` callback with the resolved value (`null` = ungroup).
 */
interface Props {
  projectName: string
  currentGroup: string | null
  existingGroups: string[]
  onApply: (value: string | null) => void | Promise<void>
  onClose: () => void
}

/** Deterministic pastel color per group name — same seed → same color across
 *  reloads, so users learn to recognize groups by their tint. */
const PALETTE = [
  '#89b4fa', // blue
  '#f38ba8', // pink
  '#a6e3a1', // green
  '#f9e2af', // yellow
  '#cba6f7', // mauve
  '#94e2d5', // teal
  '#fab387', // peach
  '#eba0ac', // maroon
]
function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export function GroupPickerModal({
  projectName,
  currentGroup,
  existingGroups,
  onApply,
  onClose,
}: Props) {
  const [value, setValue] = useState<string>(currentGroup ?? '')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Focus into the input only if there is no current group (creation
    // flow); if the project already has one, focus the chip row instead so
    // the user's first tap doesn't accidentally re-type over it.
    if (!currentGroup) inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentGroup, onClose])

  const trimmed = value.trim()
  const normalized: string | null = trimmed.length > 0 ? trimmed : null
  const hasChanged = normalized !== (currentGroup ?? null)

  const isExisting = trimmed.length > 0 && existingGroups.includes(trimmed)
  const willCreate = trimmed.length > 0 && !isExisting

  // Sort chips: currently-selected first, then alphabetical.
  const sortedGroups = useMemo(() => {
    return [...existingGroups].sort((a, b) => {
      if (a === currentGroup) return -1
      if (b === currentGroup) return 1
      return a.localeCompare(b)
    })
  }, [existingGroups, currentGroup])

  const handleApply = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onApply(normalized)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gp-overlay" onClick={onClose}>
      <div className="gp-card" onClick={(e) => e.stopPropagation()}>
        <header className="gp-header">
          <div className="gp-header-icon"><Tag size={16} /></div>
          <div className="gp-header-text">
            <h2>Project group</h2>
            <p>Organize <strong>{projectName}</strong> into a group</p>
          </div>
          <button className="gp-close" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </header>

        {/* New / edit input */}
        <div className="gp-input-row">
          <span className="gp-input-icon">
            {willCreate ? <Plus size={14} /> : <Tag size={14} />}
          </span>
          <input
            ref={inputRef}
            className="gp-input"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Group name — type to create or pick below"
            onKeyDown={(e) => { if (e.key === 'Enter') void handleApply() }}
          />
          {value.length > 0 && (
            <button className="gp-input-clear" onClick={() => setValue('')} aria-label="Clear">
              <X size={12} />
            </button>
          )}
        </div>

        {willCreate && (
          <div className="gp-hint">
            <Plus size={11} /> Will create new group “{trimmed}”
          </div>
        )}

        {/* Existing groups */}
        {sortedGroups.length > 0 && (
          <>
            <div className="gp-section-label">Existing groups</div>
            <div className="gp-chips">
              {sortedGroups.map((g) => {
                const selected = trimmed === g
                const color = colorFor(g)
                return (
                  <button
                    key={g}
                    className={`gp-chip ${selected ? 'selected' : ''}`}
                    onClick={() => setValue(g)}
                    style={{
                      // Chip color is the group's deterministic color.
                      // When selected, we fill; otherwise we only tint the
                      // border and dot.
                      '--chip-color': color,
                    } as React.CSSProperties}
                  >
                    <span className="gp-chip-dot" />
                    <span className="gp-chip-label">{g}</span>
                    {selected && <Check size={12} className="gp-chip-check" />}
                  </button>
                )
              })}
            </div>
          </>
        )}

        {/* Ungroup chip */}
        <div className="gp-section-label">Or</div>
        <div className="gp-chips">
          <button
            className={`gp-chip gp-chip-none ${trimmed.length === 0 ? 'selected' : ''}`}
            onClick={() => setValue('')}
          >
            <span className="gp-chip-dot none" />
            <span className="gp-chip-label"><Ban size={11} /> No group</span>
            {trimmed.length === 0 && <Check size={12} className="gp-chip-check" />}
          </button>
        </div>

        <footer className="gp-footer">
          <button className="gp-btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="gp-btn primary"
            onClick={handleApply}
            disabled={busy || !hasChanged}
          >
            {busy ? 'Saving…' : normalized ? 'Apply' : currentGroup ? 'Ungroup' : 'Apply'}
          </button>
        </footer>
      </div>
    </div>
  )
}
