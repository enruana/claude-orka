import { useEffect, useRef } from 'react'

/**
 * Close-on-Escape that respects what's on top and what has focus.
 *
 * The launcher stacks layers — a session modal, the code editor inside
 * it, a context menu over that — and each used to register its own
 * `window` keydown listener. Every one fired on a single press, so
 * Escape anywhere inside a project collapsed the whole stack back to
 * the dashboard. Escape is also a working key inside an editor (dismiss
 * the suggest widget, leave the find box) and inside any text field,
 * and those presses were closing the session too.
 *
 * So: one listener, a stack of handlers, only the topmost runs, and
 * presses that belong to the focused control are left alone.
 */

type Handler = () => void

/** Each entry is a live box, so a caller's changing closure is picked
 *  up without reshuffling the stack. */
const stack: { run: Handler }[] = []
let listening = false

/** Does the focused element own the Escape key? */
function focusOwnsEscape(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null
  if (!el) return false

  // Monaco: Escape dismisses suggestions, leaves find, drops extra
  // cursors. Closing the surrounding modal instead loses work.
  if (el.closest('.monaco-editor')) return true

  // A focused cross-origin iframe (the ttyd terminal) swallows its own
  // keys; anything that does reach us was not meant for the modal.
  if (el.tagName === 'IFRAME') return true

  if (el.isContentEditable) return true

  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    // Unless the field opted in — a search box may want Escape to close
    // its own panel.
    return el.dataset.escapeCloses !== 'true'
  }
  return false
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (focusOwnsEscape(e.target)) return
  const top = stack[stack.length - 1]
  if (!top) return
  e.preventDefault()
  e.stopPropagation()
  top.run()
}

/**
 * Make `handler` the Escape target while `enabled`.
 *
 * The most recently mounted enabled handler wins, so a menu opened over
 * a modal closes the menu and leaves the modal standing.
 */
export function useEscapeClose(handler: Handler, enabled: boolean = true): void {
  const box = useRef<{ run: Handler }>({ run: handler })
  box.current.run = handler

  useEffect(() => {
    if (!enabled) return
    const entry = box.current
    stack.push(entry)
    if (!listening) {
      window.addEventListener('keydown', onKeyDown, true)
      listening = true
    }
    return () => {
      const i = stack.indexOf(entry)
      if (i >= 0) stack.splice(i, 1)
      if (stack.length === 0 && listening) {
        window.removeEventListener('keydown', onKeyDown, true)
        listening = false
      }
    }
  }, [enabled])
}
