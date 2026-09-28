import type { editor, languages, Position, CancellationToken } from 'monaco-editor'
import { api } from '../../api/client'

/**
 * Ghost-text autocomplete provider — Copilot/Cursor style, backed by
 * Haiku via /api/ai/inline-complete.
 *
 * Design notes worth keeping:
 *
 *  - Monaco calls provideInlineCompletions on every relevant keystroke.
 *    Each call schedules a fetch behind a 400ms debounce and cancels
 *    the pending timer for that call if Monaco cancels the token first.
 *    A stale response never overwrites a fresh one because Monaco
 *    already races the promise against the token — we just need to
 *    resolve promptly on cancellation, not race ourselves.
 *
 *  - Cache is a small LRU keyed on the tail of the prefix + head of
 *    the suffix + language. Same context twice within TTL is served
 *    for free — turns "typo / delete / retype" into a no-op.
 *
 *  - Cursor guards mirror Copilot: only suggest at end-of-line or when
 *    the rest of the line is whitespace. In the middle of code the
 *    ghost text is almost never useful and blocks the user's flow.
 *
 *  - Post-processing strips the leading duplicate of contextAfter (the
 *    model sometimes re-emits what already follows) and caps at
 *    maxLines. If nothing survives, return empty items so Monaco skips
 *    rendering entirely — no empty gray flicker.
 */

const DEBOUNCE_MS = 400
const CACHE_TTL_MS = 30_000
const CACHE_MAX = 40
const CONTEXT_LINES_BEFORE = 40
const CONTEXT_LINES_AFTER = 15
const MAX_LINES = 5

const DEBUG = false

interface CacheEntry { completion: string; at: number }
const cache = new Map<string, CacheEntry>()

function cacheGet(key: string): string | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null }
  cache.delete(key); cache.set(key, hit)
  return hit.completion
}

function cacheSet(key: string, completion: string) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, { completion, at: Date.now() })
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function shouldTrigger(model: editor.ITextModel, position: Position): boolean {
  const lineText = model.getLineContent(position.lineNumber)
  const after = lineText.substring(position.column - 1)
  if (after.trim().length > 0) return false
  const before = lineText.substring(0, position.column - 1)
  if (before.trim().length === 0 && position.lineNumber === 1) return false
  return true
}

function buildContext(
  model: editor.ITextModel,
  position: Position,
): { contextBefore: string; contextAfter: string } {
  const startLine = Math.max(1, position.lineNumber - CONTEXT_LINES_BEFORE)
  const endLine = Math.min(model.getLineCount(), position.lineNumber + CONTEXT_LINES_AFTER)

  const beforeLines: string[] = []
  for (let l = startLine; l < position.lineNumber; l++) beforeLines.push(model.getLineContent(l))
  beforeLines.push(model.getLineContent(position.lineNumber).substring(0, position.column - 1))
  const contextBefore = beforeLines.join('\n')

  const afterLines: string[] = []
  afterLines.push(model.getLineContent(position.lineNumber).substring(position.column - 1))
  for (let l = position.lineNumber + 1; l <= endLine; l++) afterLines.push(model.getLineContent(l))
  const contextAfter = afterLines.join('\n')

  return { contextBefore, contextAfter }
}

function postProcess(raw: string, contextAfter: string): string {
  let out = raw
  out = out.replace(/^\s*```[\w-]*\n/, '').replace(/\n?```\s*$/, '')
  const dup = commonPrefixLen(out, contextAfter)
  if (dup > 0 && dup < out.length) out = out.substring(dup)
  const lines = out.split('\n')
  if (lines.length > MAX_LINES) out = lines.slice(0, MAX_LINES).join('\n')
  out = out.replace(/[ \t]+$/gm, '')
  return out
}

function log(...args: unknown[]) {
  if (DEBUG) console.log('[orka-autocomplete]', ...args)
}

export interface InlineProviderOptions {
  filePath: () => string
  enabled: () => boolean
}

export function createInlineCompletionProvider(
  opts: InlineProviderOptions,
): languages.InlineCompletionsProvider {
  return {
    provideInlineCompletions: (
      model: editor.ITextModel,
      position: Position,
      _ctx: languages.InlineCompletionContext,
      token: CancellationToken,
    ): Promise<languages.InlineCompletions> => {
      return new Promise<languages.InlineCompletions>((resolve) => {
        const empty = () => resolve({ items: [] })

        if (!opts.enabled()) { log('gate: disabled'); empty(); return }
        if (!shouldTrigger(model, position)) { log('gate: cursor mid-line, skipping'); empty(); return }

        const { contextBefore, contextAfter } = buildContext(model, position)
        if (!contextBefore.trim() && !contextAfter.trim()) { log('gate: empty context'); empty(); return }

        const languageId = model.getLanguageId()
        const cacheKey =
          languageId + '|' + contextBefore.slice(-256) + '|' + contextAfter.slice(0, 128)
        const cached = cacheGet(cacheKey)
        if (cached !== null) {
          log('cache hit:', JSON.stringify(cached.slice(0, 40)))
          if (!cached) { empty(); return }
          resolve({
            items: [{
              insertText: cached,
              range: {
                startLineNumber: position.lineNumber,
                startColumn: position.column,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
              },
            }],
          })
          return
        }

        const abort = new AbortController()
        let settled = false
        const settle = (val: languages.InlineCompletions) => {
          if (settled) return
          settled = true
          resolve(val)
        }

        token.onCancellationRequested(() => {
          log('cancelled by monaco')
          abort.abort()
          settle({ items: [] })
        })

        const timer = window.setTimeout(async () => {
          if (abort.signal.aborted || token.isCancellationRequested) { settle({ items: [] }); return }
          log('fetching for lang=' + languageId + ' ctxBefore=' + contextBefore.length + 'ch ctxAfter=' + contextAfter.length + 'ch')
          try {
            const { completion } = await api.aiInlineComplete(
              {
                contextBefore, contextAfter,
                languageId, filePath: opts.filePath(),
                maxLines: MAX_LINES,
              },
              abort.signal,
            )
            const cleaned = postProcess(completion || '', contextAfter)
            cacheSet(cacheKey, cleaned)
            log('response:', JSON.stringify((cleaned || '').slice(0, 60)))
            if (abort.signal.aborted || token.isCancellationRequested) { settle({ items: [] }); return }
            if (!cleaned) { settle({ items: [] }); return }
            settle({
              items: [{
                insertText: cleaned,
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: position.column,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column,
                },
              }],
            })
          } catch (err: any) {
            if (err?.name === 'AbortError') { settle({ items: [] }); return }
            console.warn('[orka-autocomplete] fetch failed:', err?.message || err)
            settle({ items: [] })
          }
        }, DEBOUNCE_MS)

        // Kill the timer if Monaco cancels before it fires.
        token.onCancellationRequested(() => { window.clearTimeout(timer) })
      })
    },
    freeInlineCompletions: () => { /* nothing to free */ },
  }
}
