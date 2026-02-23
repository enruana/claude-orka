import { useEffect } from 'react'

/**
 * Sets the browser tab title and restores it on unmount.
 * @param parts - Title segments joined with " / ", suffixed with " - Orka"
 *                Pass null/undefined/empty segments to skip them.
 *                Example: usePageTitle('my-project', 'Files') → "my-project / Files - Orka"
 */
export function usePageTitle(...parts: (string | null | undefined)[]) {
  const filtered = parts.filter(Boolean) as string[]
  const title = filtered.length > 0
    ? `${filtered.join(' / ')} - Orka`
    : 'Claude Orka'

  useEffect(() => {
    document.title = title
    return () => { document.title = 'Claude Orka' }
  }, [title])
}
