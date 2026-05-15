import { useEffect, useRef, useState } from 'react'

/**
 * Read a JSON value previously written by `usePersistentState` (or any
 * JSON-serialized localStorage key). Returns `fallback` on miss, parse error,
 * or non-browser environment. Use this for one-shot reads inside async restore
 * effects where you can't depend on the hook's reactive value (e.g. you need
 * the value for the *current* storage key regardless of React effect ordering).
 */
export function readPersisted<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/**
 * `useState` whose value is mirrored to `localStorage`, so it survives a page
 * reload and a route navigation that remounts the component.
 *
 * The value is JSON-serialized under `key`. If `key` changes while the
 * component stays mounted (e.g. switching projects on the same route), the
 * stored value for the new key is loaded and the stale value is NOT written
 * back to the new key.
 */
export function usePersistentState<T>(
  key: string,
  defaultValue: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const defaultRef = useRef(defaultValue)
  const [state, setState] = useState<T>(() => readPersisted(key, defaultRef.current))

  // Tracks which key the current `state` belongs to. When `key` changes we
  // reload from storage and skip the immediately-following persist (which would
  // otherwise write the previous key's value into the new key).
  const hydratedKey = useRef(key)
  const skipPersist = useRef(false)

  useEffect(() => {
    if (hydratedKey.current === key) return
    hydratedKey.current = key
    skipPersist.current = true
    setState(readPersisted(key, defaultRef.current))
  }, [key])

  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false
      return
    }
    try {
      window.localStorage.setItem(key, JSON.stringify(state))
    } catch {
      /* quota exceeded / serialization failure — non-fatal, drop the write */
    }
  }, [key, state])

  return [state, setState]
}
