import { Router } from 'express'
import fs from 'fs-extra'
import path from 'path'
import multer from 'multer'
import execa from 'execa'

export const filesRouter = Router()

// MIME types for images
const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
}

interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
}

// Patterns to ignore when building file tree (minimal - only system files)
const IGNORE_PATTERNS = [
  '.DS_Store',
  'Thumbs.db',
]

function decodeProjectPath(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

function isPathSafe(projectPath: string, filePath: string): boolean {
  const resolvedProject = path.resolve(projectPath)
  const resolvedFile = path.resolve(projectPath, filePath)
  return resolvedFile.startsWith(resolvedProject)
}

/**
 * Escape a string for safe embedding inside a JavaScript single-quoted
 * string literal. Handles backslashes, quotes, newlines, closing tags
 * (to avoid `</script>` breaking out) and line/paragraph separators.
 */
function escapeForJsString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/<\/(script)/gi, '<\\/$1')
}

/**
 * Build the HTML/JS/CSS overlay that turns an HTML preview into a full
 * review surface with a persistent side rail (GitHub-PR-style):
 *
 *  ┌──────────────────────────────────┬───────────────────────┐
 *  │  Document (unchanged, ~65% wide) │  Rail (35% wide):     │
 *  │                                  │   header + "Apply"    │
 *  │  Selection → floating "+" btn    │   card 1              │
 *  │                                  │   card 2              │
 *  │  Selected phrases stay marked    │   …                   │
 *  │  and click-linked to their card. │                       │
 *  └──────────────────────────────────┴───────────────────────┘
 *
 * On save, the new comment appears as a card in the rail with a slide-
 * in animation; the source phrase in the doc gets a subtle yellow
 * highlight linked back to the card.
 *
 * "Apply with Claude" composes a Spanish prompt (doc path + all
 * pending comments + instructions to edit the file AND append an entry
 * to the doc's `.changelog` — using a short note referencing the
 * INTENT of the comment, not the full body) and copies it to the
 * clipboard, ready to paste in a Claude session.
 *
 * Everything self-contained — same-origin fetch to Orka's own API only.
 */
/**
 * Voice overlay for `?voice=1`. Replaces the earlier vanilla-JS widget
 * (kept at /api/voice/widget.js for legacy references) with an iframe
 * embed of the React-based VoiceAgentPage — same UI/UX as the
 * standalone /voice-agent route + the launcher-modal wrapper, so all
 * three entry points share one implementation. The doc-in-preview
 * gets passed through as the initial attachment so Claude sees it
 * without the user needing to re-attach.
 *
 * Chrome: a floating, translucent, draggable card in the top-right
 * corner with minimize (collapses to a pill sticking out from the
 * right edge) and close controls. The iframe stays MOUNTED even when
 * minimized so the mic + WS + AudioContext lifecycles don't churn.
 *
 * Coexists with the comments overlay: distinct DOM subtrees, no z-
 * index or event conflicts.
 *
 * `projectB64` here is url-safe base64 (RFC 4648 §5) so it drops
 * cleanly into a query string alongside a raw filePath.
 */
function buildVoiceOverlay(opts: { projectB64: string; filePath: string }): string {
  const projectSafe = opts.projectB64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const projectJs = escapeForJsString(projectSafe)
  const filePathJs = escapeForJsString(opts.filePath)
  return `
<style id="orka-voice-style">
  .orka-voice-shell {
    position: fixed;
    top: 16px;
    right: 16px;
    width: min(400px, 92vw);
    height: min(560px, calc(100vh - 32px));
    border-radius: 20px;
    background: rgba(17, 17, 27, 0.72);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55), 0 4px 12px rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(20px) saturate(140%);
    -webkit-backdrop-filter: blur(20px) saturate(140%);
    z-index: 2147483645;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: #ecf0fe;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    transition: width 0.18s ease, height 0.18s ease, border-radius 0.18s ease;
  }
  .orka-voice-shell.minimized {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    padding: 0;
    cursor: pointer;
  }
  .orka-voice-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    cursor: grab;
    user-select: none;
    touch-action: none;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.75);
    flex-shrink: 0;
  }
  .orka-voice-header:active { cursor: grabbing; }
  .orka-voice-shell.minimized .orka-voice-header { display: none; }
  .orka-voice-grip {
    opacity: 0.4;
    flex-shrink: 0;
    width: 16px; height: 16px;
  }
  .orka-voice-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .orka-voice-actions { display: flex; gap: 2px; }
  .orka-voice-btn {
    width: 26px; height: 26px;
    border-radius: 6px; border: none;
    background: transparent;
    color: rgba(255, 255, 255, 0.55);
    cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    transition: background 0.15s, color 0.15s;
    font: inherit;
  }
  .orka-voice-btn:hover { background: rgba(255, 255, 255, 0.1); color: #ecf0fe; }
  .orka-voice-btn svg { width: 14px; height: 14px; stroke-width: 2; }
  .orka-voice-iframe {
    flex: 1;
    width: 100%;
    border: 0;
    background: transparent;
    min-height: 0;
  }
  .orka-voice-shell.minimized .orka-voice-iframe {
    /* Iframe stays mounted so the mic session survives minimize.
       We tuck it off-screen while keeping it in the layout so its
       AudioContext + WS don't hit an unmount path. */
    position: absolute;
    left: -99999px;
    width: 400px; height: 560px;
  }
  .orka-voice-bubble {
    /* The minimized pill shows a mic glyph as an affordance. It
       overlays the tucked iframe. */
    display: none;
    width: 100%; height: 100%;
    align-items: center; justify-content: center;
    color: #cdd6f4;
    pointer-events: none;
  }
  .orka-voice-shell.minimized .orka-voice-bubble {
    display: flex;
  }
  .orka-voice-bubble svg { width: 24px; height: 24px; stroke-width: 2; }
</style>
<div id="orka-voice-shell" class="orka-voice-shell" role="dialog" aria-label="Voice Agent">
  <div class="orka-voice-header" id="orka-voice-header">
    <svg class="orka-voice-grip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
    <span class="orka-voice-title">Voice Agent</span>
    <div class="orka-voice-actions">
      <button class="orka-voice-btn" id="orka-voice-min" title="Minimize" aria-label="Minimize voice agent">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <button class="orka-voice-btn" id="orka-voice-close" title="Close" aria-label="Close voice agent">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  </div>
  <iframe id="orka-voice-iframe" class="orka-voice-iframe" title="Voice Agent" allow="microphone; clipboard-read; clipboard-write"></iframe>
  <div class="orka-voice-bubble">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
  </div>
</div>
<script id="orka-voice-controller">
(function() {
  var PROJECT_B64 = '${projectJs}';
  var FILE_PATH = '${filePathJs}';

  var shell = document.getElementById('orka-voice-shell');
  var header = document.getElementById('orka-voice-header');
  var iframe = document.getElementById('orka-voice-iframe');
  var minBtn = document.getElementById('orka-voice-min');
  var closeBtn = document.getElementById('orka-voice-close');
  if (!shell || !header || !iframe || !minBtn || !closeBtn) return;

  // Iframe URL — the SPA route with embedded=1 chrome + this file
  // pre-attached. Same-origin so the mic permission granted for the
  // parent frame carries over.
  iframe.src = '/voice-agent?embedded=1&project=' + encodeURIComponent(PROJECT_B64)
             + '&path=' + encodeURIComponent(FILE_PATH);

  // ---- Minimize / restore ----
  function setMinimized(v) {
    if (v) shell.classList.add('minimized');
    else shell.classList.remove('minimized');
    minBtn.title = v ? 'Expand' : 'Minimize';
    minBtn.setAttribute('aria-label', v ? 'Expand voice agent' : 'Minimize voice agent');
  }
  minBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    setMinimized(!shell.classList.contains('minimized'));
  });
  // Clicking the pill body (when minimized) also restores.
  shell.addEventListener('click', function(e) {
    if (!shell.classList.contains('minimized')) return;
    if (e.target === minBtn || e.target === closeBtn) return;
    setMinimized(false);
  });

  // ---- Close ----
  closeBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    // Kill the iframe first so the WS + mic close cleanly, then
    // remove the shell from the DOM. The parent page keeps its
    // scroll position and doc state untouched.
    try { iframe.src = 'about:blank'; } catch (_) {}
    shell.remove();
  });

  // ---- Drag ----
  var drag = null;
  header.addEventListener('pointerdown', function(e) {
    if (e.target.closest('button')) return; // let button clicks through
    var rect = shell.getBoundingClientRect();
    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      shellW: rect.width,
      shellH: rect.height,
    };
    header.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  header.addEventListener('pointermove', function(e) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    var dx = e.clientX - drag.startX;
    var dy = e.clientY - drag.startY;
    var vw = window.innerWidth, vh = window.innerHeight;
    var m = 8;
    var x = Math.min(Math.max(m, drag.startLeft + dx), vw - drag.shellW - m);
    var y = Math.min(Math.max(m, drag.startTop + dy), vh - drag.shellH - m);
    // Absolute positioning via left/top; clear the default right/bottom.
    shell.style.left = x + 'px';
    shell.style.top  = y + 'px';
    shell.style.right = 'auto';
    shell.style.bottom = 'auto';
  });
  header.addEventListener('pointerup', function(e) {
    if (!drag) return;
    try { header.releasePointerCapture(e.pointerId); } catch (_) {}
    drag = null;
  });
})();
</script>
`
}

function buildCommentsOverlay(opts: { projectB64: string; filePath: string }): string {
  const projectJs = escapeForJsString(opts.projectB64)
  const filePathJs = escapeForJsString(opts.filePath)
  const filePathQs = escapeForJsString(encodeURIComponent(opts.filePath))
  return `
<style id="orka-comments-style">
  /* ---- Rail as a FIXED overlay — the document's own layout is left
          completely untouched. The rail lives on the right edge; by
          default it's translated off-screen with just a small handle
          poking in. Click the handle (or a highlighted phrase in the
          doc) to open it. ---- */
  #orka-review-rail {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: 380px;
    max-width: 90vw;
    background: linear-gradient(180deg, rgba(17, 18, 42, 0.96), rgba(10, 11, 31, 0.96));
    backdrop-filter: blur(20px) saturate(140%);
    -webkit-backdrop-filter: blur(20px) saturate(140%);
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #cdd6f4;
    z-index: 2147483645;
    transform: translateX(100%);
    transition: transform 0.22s ease-out;
    box-shadow: -12px 0 40px rgba(0, 0, 0, 0.35);
  }
  body.orka-rail-open #orka-review-rail { transform: translateX(0); }

  .orka-rail-header {
    padding: 16px 18px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(255, 255, 255, 0.02);
    display: flex; flex-direction: column; gap: 12px;
    position: sticky; top: 0; z-index: 5;
  }
  .orka-rail-title {
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; font-weight: 600;
    letter-spacing: 0.2px;
    color: #ecf0fe;
  }
  .orka-rail-count {
    background: rgba(255, 255, 255, 0.08);
    color: #a6adc8;
    padding: 2px 9px; border-radius: 999px;
    font-family: ui-monospace, monospace; font-size: 11px;
    border: 1px solid rgba(255, 255, 255, 0.06);
  }
  .orka-rail-apply {
    flex: 1;
    padding: 9px 14px;
    border-radius: 10px;
    border: 1px solid rgba(250, 179, 135, 0.35);
    background: linear-gradient(180deg, rgba(250, 179, 135, 0.22), rgba(250, 179, 135, 0.12));
    color: #fab387;
    font-weight: 600;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    transition: background 0.15s, border-color 0.15s;
  }
  .orka-rail-apply:hover { background: rgba(250, 179, 135, 0.3); border-color: rgba(250, 179, 135, 0.55); }
  .orka-rail-apply:disabled { opacity: 0.4; cursor: not-allowed; }
  .orka-rail-clear {
    background: rgba(243, 139, 168, 0.16);
    color: #f38ba8;
    border: 1px solid rgba(243, 139, 168, 0.35);
    border-radius: 999px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: background 0.15s, border-color 0.15s;
  }
  .orka-rail-clear:hover { background: rgba(243, 139, 168, 0.28); border-color: rgba(243, 139, 168, 0.55); }
  .orka-rail-clear:disabled { opacity: 0.35; cursor: not-allowed; }
  .orka-rail-apply.flash-ok {
    background: rgba(166, 227, 161, 0.25);
    border-color: rgba(166, 227, 161, 0.55);
    color: #a6e3a1;
  }
  .orka-rail-actions { display: flex; gap: 8px; align-items: center; }
  .orka-rail-toggle {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: #cdd6f4;
    border-radius: 10px;
    padding: 9px 11px;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .orka-rail-toggle:hover { background: rgba(255, 255, 255, 0.1); }

  .orka-rail-body {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
    display: flex; flex-direction: column; gap: 10px;
  }

  .orka-rail-empty {
    text-align: center;
    color: #6c7086;
    font-style: italic;
    font-size: 13px;
    padding: 48px 20px;
    line-height: 1.6;
  }

  /* ---- Comment card ---- */
  .orka-comment-card {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 12px 14px;
    animation: orka-card-in 0.22s ease-out;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s, transform 0.15s;
  }
  .orka-comment-card:hover {
    background: rgba(255, 255, 255, 0.07);
    border-color: rgba(250, 179, 135, 0.4);
  }
  .orka-comment-card.active {
    border-color: rgba(250, 179, 135, 0.7);
    background: rgba(250, 179, 135, 0.08);
    box-shadow: 0 0 0 2px rgba(250, 179, 135, 0.18);
  }
  .orka-comment-card.resolved { opacity: 0.5; border-style: dashed; }
  .orka-card-snippet {
    background: rgba(250, 179, 135, 0.08);
    border-left: 3px solid rgba(250, 179, 135, 0.6);
    padding: 8px 10px;
    font-size: 12px;
    color: #a6adc8;
    font-family: ui-monospace, monospace;
    border-radius: 6px;
    max-height: 70px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre-wrap;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    margin-bottom: 8px;
  }
  .orka-card-body {
    font-size: 13px;
    color: #ecf0fe;
    line-height: 1.55;
    white-space: pre-wrap;
    margin-bottom: 6px;
  }
  .orka-card-meta {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 11px;
    color: #6c7086;
    padding-top: 8px;
    border-top: 1px dashed rgba(255, 255, 255, 0.06);
  }
  .orka-card-actions { display: flex; gap: 4px; }
  .orka-card-btn {
    background: transparent; border: 0;
    color: #a6adc8;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-family: inherit;
    transition: color 0.12s, background 0.12s;
  }
  .orka-card-btn:hover { background: rgba(255, 255, 255, 0.08); color: #ecf0fe; }
  .orka-card-btn.danger:hover { background: rgba(243, 139, 168, 0.14); color: #f38ba8; }

  @keyframes orka-card-in {
    from { opacity: 0; transform: translateX(20px); }
    to { opacity: 1; transform: translateX(0); }
  }

  /* ---- Highlighted phrase in the doc ----
     Kept minimal on purpose: just a soft yellow background so it works
     over any host document. !important because many host docs set their
     own 'mark' styles that would otherwise win. box-decoration-break
     keeps the background visually contiguous when a mark wraps across
     several lines within the same block. Marks NEVER contain block
     elements — the JS splits big selections into one <mark> per text
     node, so this style always paints only inline text. */
  mark.orka-comment-mark,
  .orka-comment-mark {
    background: rgba(250, 179, 135, 0.28) !important;
    color: inherit !important;
    padding: 0 2px !important;
    border-radius: 3px !important;
    cursor: pointer !important;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
    transition: background 0.15s;
  }
  mark.orka-comment-mark:hover,
  .orka-comment-mark:hover {
    background: rgba(250, 179, 135, 0.45) !important;
  }
  mark.orka-comment-mark.active,
  .orka-comment-mark.active {
    background: rgba(250, 179, 135, 0.55) !important;
    outline: 1px solid rgba(250, 179, 135, 0.85) !important;
    outline-offset: 0;
  }

  /* ---- Floating selection toolbar (Comment + Ask) ---- */
  .orka-selection-toolbar {
    position: absolute;
    z-index: 2147483646;
    display: none;
    gap: 2px;
    padding: 4px;
    border-radius: 999px;
    background: rgba(17, 18, 42, 0.94);
    backdrop-filter: blur(16px) saturate(140%);
    -webkit-backdrop-filter: blur(16px) saturate(140%);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    user-select: none;
    animation: orka-tool-in 0.14s ease-out;
  }
  @keyframes orka-tool-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .orka-selection-toolbar-btn {
    padding: 7px 13px;
    border-radius: 999px;
    border: 0;
    color: #cdd6f4;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    line-height: 1;
    background: transparent;
    display: inline-flex; align-items: center; gap: 6px;
    transition: background 0.12s, color 0.12s;
    font-family: inherit;
  }
  .orka-selection-toolbar-btn svg { flex-shrink: 0; }
  .orka-selection-toolbar-btn.comment:hover {
    background: rgba(250, 179, 135, 0.18);
    color: #fab387;
  }
  .orka-selection-toolbar-btn.ask:hover {
    background: rgba(137, 180, 250, 0.18);
    color: #89b4fa;
  }
  .orka-selection-toolbar-divider {
    width: 1px;
    background: rgba(255, 255, 255, 0.08);
    margin: 4px 0;
  }

  /* ---- Ask input (mini prompt anchored to selection) ---- */
  .orka-ask-inline {
    position: absolute;
    z-index: 2147483646;
    display: none;
    gap: 8px;
    padding: 10px;
    border-radius: 14px;
    background: linear-gradient(180deg, rgba(24, 25, 54, 0.98), rgba(15, 16, 36, 0.98));
    backdrop-filter: blur(20px) saturate(140%);
    -webkit-backdrop-filter: blur(20px) saturate(140%);
    color: #ecf0fe;
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.02) inset;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    align-items: flex-start;
    width: min(400px, 92vw);
    box-sizing: border-box;
    animation: orka-modal-rise 0.16s ease-out;
  }
  .orka-ask-inline textarea {
    flex: 1;
    min-height: 44px; max-height: 140px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    padding: 10px 12px;
    font: inherit;
    font-size: 13px;
    resize: none;
    outline: none;
    color: #ecf0fe;
    background: rgba(255, 255, 255, 0.04);
    box-sizing: border-box;
    transition: border-color 0.15s, background 0.15s;
  }
  .orka-ask-inline textarea::placeholder { color: #6c7086; }
  .orka-ask-inline textarea:focus {
    border-color: rgba(137, 180, 250, 0.55);
    background: rgba(255, 255, 255, 0.06);
    box-shadow: 0 0 0 2px rgba(137, 180, 250, 0.18);
  }
  .orka-ask-inline button {
    padding: 8px 14px;
    border-radius: 10px;
    border: 1px solid rgba(137, 180, 250, 0.45);
    background: linear-gradient(180deg, rgba(137, 180, 250, 0.28), rgba(137, 180, 250, 0.16));
    color: #89b4fa;
    font: inherit; font-size: 13px; font-weight: 600;
    cursor: pointer;
    align-self: stretch;
    display: inline-flex; align-items: center; gap: 6px;
    transition: background 0.15s, border-color 0.15s;
  }
  .orka-ask-inline button:hover {
    background: rgba(137, 180, 250, 0.32);
    border-color: rgba(137, 180, 250, 0.65);
  }
  .orka-ask-inline button:disabled { opacity: 0.4; cursor: default; }

  /* ---- Ask answer modal (draggable + minimizable) ---- */
  .orka-ask-modal {
    position: fixed;
    z-index: 2147483645;
    width: min(480px, 92vw);
    max-height: 70vh;
    background: linear-gradient(180deg, rgba(24, 25, 54, 0.98), rgba(15, 16, 36, 0.98));
    backdrop-filter: blur(24px) saturate(140%);
    -webkit-backdrop-filter: blur(24px) saturate(140%);
    color: #ecf0fe;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    box-shadow: 0 32px 72px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.02) inset;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    display: flex; flex-direction: column;
    overflow: hidden;
    animation: orka-modal-rise 0.2s ease-out;
  }
  .orka-ask-modal-header {
    display: flex; align-items: center; gap: 8px;
    padding: 11px 14px;
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    cursor: move;
    user-select: none;
  }
  .orka-ask-modal-header::before {
    content: '';
    width: 6px; height: 6px; border-radius: 999px;
    background: #89b4fa;
    box-shadow: 0 0 8px rgba(137, 180, 250, 0.7);
    flex-shrink: 0;
  }
  .orka-ask-modal-title {
    flex: 1;
    font-size: 12px; font-weight: 600;
    color: #cdd6f4;
    letter-spacing: 0.1px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .orka-ask-modal-icon-btn {
    width: 26px; height: 26px;
    border: 1px solid transparent;
    background: transparent;
    color: #a6adc8;
    cursor: pointer;
    border-radius: 8px;
    font-size: 14px; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center;
    transition: background 0.12s, color 0.12s;
  }
  .orka-ask-modal-icon-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #ecf0fe;
  }
  .orka-ask-modal-body {
    padding: 16px 18px;
    overflow-y: auto;
    display: flex; flex-direction: column; gap: 12px;
    font-size: 14px; line-height: 1.6;
  }
  .orka-ask-question {
    font-size: 13px; font-weight: 600;
    color: #ecf0fe;
    padding-bottom: 4px;
  }
  .orka-ask-excerpt {
    font-size: 12px; color: #a6adc8;
    background: rgba(137, 180, 250, 0.08);
    border-left: 3px solid rgba(137, 180, 250, 0.6);
    border-radius: 8px;
    padding: 10px 12px;
    max-height: 220px; overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
    font-family: ui-monospace, monospace;
    line-height: 1.5;
  }
  .orka-ask-excerpt-toggle {
    display: inline-block;
    margin-top: -4px;
    font-size: 11px; color: #89b4fa; cursor: pointer;
    user-select: none;
    padding: 3px 0;
    transition: color 0.12s;
  }
  .orka-ask-excerpt-toggle:hover { color: #b6d0fa; }
  .orka-ask-answer {
    white-space: pre-wrap;
    color: #ecf0fe;
    font-size: 13.5px;
    line-height: 1.65;
  }
  .orka-ask-loading {
    display: inline-flex; align-items: center; gap: 10px;
    color: #a6adc8;
    font-size: 13px;
  }
  .orka-ask-loading::before {
    content: '';
    width: 13px; height: 13px;
    border: 2px solid rgba(137, 180, 250, 0.85);
    border-top-color: transparent;
    border-radius: 50%;
    animation: orka-ask-spin 0.8s linear infinite;
  }
  @keyframes orka-ask-spin { to { transform: rotate(360deg); } }
  .orka-ask-error {
    padding: 10px 12px; border-radius: 8px;
    background: rgba(243, 139, 168, 0.1);
    border-left: 3px solid #f38ba8;
    color: #f38ba8;
    font-size: 13px;
  }

  /* ---- Minimized-modal tray (bottom-right stack of pills) ---- */
  .orka-ask-tray {
    position: fixed;
    bottom: 20px; right: 20px;
    z-index: 2147483646;
    display: flex; flex-direction: column; gap: 6px;
    max-width: 260px;
  }
  .orka-ask-pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 8px 8px 14px;
    border-radius: 999px;
    background: rgba(30, 30, 46, 0.94);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    color: #89b4fa;
    border: 1px solid rgba(137, 180, 250, 0.35);
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 12px; font-weight: 600;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
    cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 260px;
    transition: background 0.15s, border-color 0.15s, transform 0.15s;
    animation: orka-toast-in 0.2s ease-out;
  }
  .orka-ask-pill:hover {
    background: rgba(137, 180, 250, 0.16);
    border-color: rgba(137, 180, 250, 0.55);
    transform: translateY(-1px);
  }
  .orka-ask-pill-close {
    background: rgba(255, 255, 255, 0.08);
    border: 0;
    color: #cdd6f4;
    width: 20px; height: 20px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 12px; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0;
    flex-shrink: 0;
    transition: background 0.12s;
  }
  .orka-ask-pill-close:hover { background: rgba(243, 139, 168, 0.3); color: #f38ba8; }

  /* ---- Write dialog (modal for typing) ---- */
  .orka-comment-dialog-overlay {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    animation: orka-fade-in 0.14s ease-out;
  }
  @keyframes orka-fade-in { from { opacity: 0; } to { opacity: 1; } }
  .orka-comment-dialog {
    background: linear-gradient(180deg, rgba(24, 25, 54, 0.98), rgba(15, 16, 36, 0.98));
    backdrop-filter: blur(24px) saturate(140%);
    -webkit-backdrop-filter: blur(24px) saturate(140%);
    color: #ecf0fe;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    width: min(520px, 92vw);
    padding: 22px 24px;
    box-shadow: 0 40px 80px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.02) inset;
    display: flex; flex-direction: column; gap: 14px;
    animation: orka-modal-rise 0.18s ease-out;
  }
  @keyframes orka-modal-rise {
    from { opacity: 0; transform: translateY(12px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .orka-comment-dialog-title {
    font-size: 15px; font-weight: 600;
    margin: 0;
    color: #ecf0fe;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .orka-comment-dialog-title::before {
    content: '';
    width: 6px; height: 6px; border-radius: 999px;
    background: #fab387;
    box-shadow: 0 0 8px rgba(250, 179, 135, 0.7);
  }
  .orka-comment-dialog-snippet {
    font-size: 12px; color: #a6adc8;
    background: rgba(250, 179, 135, 0.08);
    border-radius: 8px; padding: 10px 12px;
    max-height: 100px; overflow: auto; white-space: pre-wrap;
    border-left: 3px solid rgba(250, 179, 135, 0.6);
    font-family: ui-monospace, monospace;
    line-height: 1.5;
  }
  .orka-comment-dialog-textarea {
    width: 100%; min-height: 110px; padding: 12px 14px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    font-family: inherit; font-size: 14px; resize: vertical;
    color: #ecf0fe; background: rgba(255, 255, 255, 0.04);
    box-sizing: border-box;
    transition: border-color 0.15s, background 0.15s;
    outline: none;
  }
  .orka-comment-dialog-textarea::placeholder { color: #6c7086; }
  .orka-comment-dialog-textarea:focus {
    border-color: rgba(250, 179, 135, 0.55);
    background: rgba(255, 255, 255, 0.06);
    box-shadow: 0 0 0 2px rgba(250, 179, 135, 0.18);
  }
  .orka-comment-dialog-actions {
    display: flex; justify-content: flex-end; gap: 8px;
  }
  .orka-comment-dialog-btn {
    padding: 9px 16px; border-radius: 10px; border: 1px solid transparent;
    font-family: inherit; font-size: 13px; font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .orka-comment-dialog-btn.primary {
    background: linear-gradient(180deg, rgba(250, 179, 135, 0.28), rgba(250, 179, 135, 0.16));
    border-color: rgba(250, 179, 135, 0.45);
    color: #fab387;
  }
  .orka-comment-dialog-btn.primary:hover {
    background: rgba(250, 179, 135, 0.32);
    border-color: rgba(250, 179, 135, 0.65);
  }
  .orka-comment-dialog-btn.secondary {
    background: rgba(255, 255, 255, 0.04);
    color: #a6adc8;
    border-color: rgba(255, 255, 255, 0.08);
  }
  .orka-comment-dialog-btn.secondary:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #ecf0fe;
  }

  /* ---- Toast ---- */
  .orka-comment-toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647;
    background: rgba(30, 30, 46, 0.94);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    color: #a6e3a1;
    padding: 10px 18px; border-radius: 999px;
    border: 1px solid rgba(166, 227, 161, 0.35);
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px; font-weight: 600;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
    animation: orka-toast-in 0.2s ease-out;
  }
  .orka-comment-toast.error {
    color: #f38ba8;
    border-color: rgba(243, 139, 168, 0.4);
  }
  @keyframes orka-toast-in {
    from { opacity: 0; transform: translate(-50%, 12px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  .orka-rail-handle {
    position: fixed;
    right: 0; top: 20px;
    width: 44px; min-height: 52px;
    background: rgba(17, 18, 42, 0.92);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    color: #fab387;
    border: 1px solid rgba(250, 179, 135, 0.35);
    border-right: 0;
    border-radius: 12px 0 0 12px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 4px;
    cursor: pointer;
    font-weight: 700;
    font-size: 16px;
    box-shadow: -6px 0 20px rgba(0, 0, 0, 0.35);
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    padding: 8px 0;
    z-index: 2147483646;
    transition: transform 0.18s ease-out, background 0.15s;
  }
  .orka-rail-handle:hover {
    transform: translateX(-3px);
    background: rgba(250, 179, 135, 0.16);
  }
  .orka-rail-handle-badge {
    font-size: 10px;
    font-weight: 700;
    background: #fab387;
    color: #11122a;
    border-radius: 999px;
    padding: 2px 7px;
    min-width: 18px;
    text-align: center;
    line-height: 1.2;
    box-shadow: 0 0 8px rgba(250, 179, 135, 0.5);
  }
  .orka-rail-handle-badge[data-count="0"] { display: none; }
  body.orka-rail-open .orka-rail-handle { display: none; }

  @media (max-width: 800px) {
    #orka-review-rail {
      width: 100vw;
      max-width: 100vw;
      top: auto; height: 70vh;
      transform: translateY(100%);
      border-left: 0;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px 16px 0 0;
    }
    body.orka-rail-open #orka-review-rail { transform: translateY(0); }
    .orka-rail-handle {
      right: 20px; bottom: 20px; top: auto;
      border-radius: 999px;
      border: 1px solid rgba(250, 179, 135, 0.35);
      width: 52px; height: 52px;
      flex-direction: row;
    }
    .orka-rail-handle:hover { transform: translateY(-3px); }
  }
</style>
<script id="orka-comments-widget">
(function() {
  var PROJECT_B64 = '${projectJs}';
  var FILE_PATH = '${filePathJs}';
  var FILE_PATH_QS = '${filePathQs}';
  var API_BASE = window.location.origin + '/api';

  // Local mirror of the rail state — comments array + a map by id for
  // quick lookup when highlighting / deleting.
  var comments = [];        // sorted newest-first
  var byId = Object.create(null);
  var activeId = null;

  // Fetch the raw file source once so we can compute accurate line
  // numbers for each comment. Cached; falls back to line 1 on failure.
  var sourceText = null;
  fetch(API_BASE + '/files/content?project=' + encodeURIComponent(PROJECT_B64) + '&path=' + FILE_PATH_QS)
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(d) { if (d && typeof d.content === 'string') sourceText = d.content; })
    .catch(function() {});

  // -------- DOM shell: rail as a FIXED overlay -----------------------
  //
  // We DO NOT touch the document body's layout — the doc keeps rendering
  // exactly as it would without the overlay. The rail is a fixed panel
  // on the right edge, hidden by transform, with a small handle that
  // pokes out (and shows a count badge when there are comments). Click
  // the handle OR any highlighted phrase to open the rail. Click a
  // card's × or use Esc to close it again. reviewContent is just an
  // alias so the rest of the code can pretend "the doc content" is
  // still a container — but we resolve it to document.body so
  // selection lookups + highlight walks work over the whole document.
  var reviewContent = document.body;

  // Handle button lives OUTSIDE the rail so position:fixed on it is
  // not affected by the rail own transform.
  var handleBtn = document.createElement('button');
  handleBtn.type = 'button';
  handleBtn.className = 'orka-rail-handle';
  handleBtn.id = 'orka-rail-handle';
  handleBtn.title = 'Abrir comentarios de revisión';
  handleBtn.innerHTML =
    '<span>💬</span>' +
    '<span class="orka-rail-handle-badge" id="orka-rail-handle-badge" data-count="0">0</span>';
  document.body.appendChild(handleBtn);

  var rail = document.createElement('aside');
  rail.id = 'orka-review-rail';
  rail.innerHTML =
    '<div class="orka-rail-header">' +
      '<div class="orka-rail-title">' +
        '<span>Comentarios de revisión</span>' +
        '<span class="orka-rail-count" id="orka-rail-count">0</span>' +
      '</div>' +
      '<div class="orka-rail-actions">' +
        '<button type="button" class="orka-rail-apply" id="orka-rail-apply" disabled title="Copies a Claude prompt that regenerates this document from scratch, weaving every unresolved comment into a fresh version + a changelog entry. Paste it into any Claude Code terminal.">' +
          '<span>✨ Regenerate with Claude</span>' +
        '</button>' +
        '<button type="button" class="orka-rail-clear" id="orka-rail-clear" disabled title="Borra todos los comentarios de este archivo. No se puede deshacer.">' +
          '<span>🧹 Limpiar</span>' +
        '</button>' +
        '<button type="button" class="orka-rail-toggle" id="orka-rail-toggle-btn" title="Cerrar panel">×</button>' +
      '</div>' +
    '</div>' +
    '<div class="orka-rail-body" id="orka-rail-body">' +
      '<div class="orka-rail-empty" id="orka-rail-empty">' +
        'Aún no hay comentarios.<br>' +
        'Selecciona texto en el documento y usa el botón flotante para agregar.' +
      '</div>' +
    '</div>';
  document.body.appendChild(rail);

  var railBody = rail.querySelector('#orka-rail-body');
  var railEmpty = rail.querySelector('#orka-rail-empty');
  var railCount = rail.querySelector('#orka-rail-count');
  var applyBtn = rail.querySelector('#orka-rail-apply');
  var clearBtn = rail.querySelector('#orka-rail-clear');
  var toggleBtn = rail.querySelector('#orka-rail-toggle-btn');
  var handleBadge = document.getElementById('orka-rail-handle-badge');

  function openRail() { document.body.classList.add('orka-rail-open'); }
  function closeRail() { document.body.classList.remove('orka-rail-open'); }
  handleBtn.addEventListener('click', openRail);
  toggleBtn.addEventListener('click', closeRail);
  // Esc closes the rail (only if focus isn't inside a textarea).
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    var t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
    if (document.body.classList.contains('orka-rail-open')) closeRail();
  });

  // -------- Selection → floating toolbar (Comment + Ask) ------------

  var ICON_COMMENT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_ASK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.3L19 10l-5.1 1.7L12 17l-1.9-5.3L5 10l5.1-1.7z"/><path d="M18 3v3M20 4.5h-3"/></svg>';
  var ICON_SEND = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>';

  var toolbar = document.createElement('div');
  toolbar.className = 'orka-selection-toolbar';
  var commentBtn = document.createElement('button');
  commentBtn.type = 'button';
  commentBtn.className = 'orka-selection-toolbar-btn comment';
  commentBtn.innerHTML = ICON_COMMENT + '<span>Comentar</span>';
  var divider = document.createElement('div');
  divider.className = 'orka-selection-toolbar-divider';
  var askBtn = document.createElement('button');
  askBtn.type = 'button';
  askBtn.className = 'orka-selection-toolbar-btn ask';
  askBtn.innerHTML = ICON_ASK + '<span>Preguntar</span>';
  toolbar.appendChild(commentBtn);
  toolbar.appendChild(divider);
  toolbar.appendChild(askBtn);
  document.body.appendChild(toolbar);

  var currentSelectedText = '';
  var lastSelectionRange = null;

  function hideToolbar() { toolbar.style.display = 'none'; }

  function positionToolbar(range) {
    var rect = range.getBoundingClientRect();
    var top = window.scrollY + rect.bottom + 6;
    // Show first, measure, then clamp — width depends on font metrics.
    toolbar.style.display = 'inline-flex';
    var tbWidth = toolbar.offsetWidth || 200;
    var left = Math.min(window.scrollX + rect.right, window.scrollX + window.innerWidth - tbWidth - 8);
    toolbar.style.top = top + 'px';
    toolbar.style.left = Math.max(8, left) + 'px';
  }

  var BLOCK_TAGS = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|PRE|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|FIGURE|FIGCAPTION|TR|UL|OL|TABLE|HR|DL|DT|DD|ADDRESS|DETAILS|SUMMARY)$/;

  // sel.toString() drops newlines between block siblings in some engines,
  // so a multi-line paragraph selection ended up glued together in the
  // Ask modal excerpt. Serialize the range ourselves and insert \n
  // between block boundaries.
  function getRangePlainText(range) {
    if (!range) return '';
    try {
      var frag = range.cloneContents();
      var out = [];
      function walk(node) {
        if (!node) return;
        if (node.nodeType === 3) { out.push(node.nodeValue || ''); return; }
        if (node.nodeType !== 1) return;
        var tag = node.nodeName;
        if (tag === 'BR') { out.push('\\n'); return; }
        var block = BLOCK_TAGS.test(tag);
        if (block && out.length && out[out.length - 1].slice(-1) !== '\\n') out.push('\\n');
        for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
        if (block) out.push('\\n');
      }
      for (var i = 0; i < frag.childNodes.length; i++) walk(frag.childNodes[i]);
      var plain = out.join('')
        .replace(/[ \\t]+\\n/g, '\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
      return plain || String(range).trim();
    } catch (err) {
      try { return String(range).trim(); } catch (_) { return ''; }
    }
  }

  function checkSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideToolbar(); return; }
    var range;
    try { range = sel.getRangeAt(0); } catch (_) { hideToolbar(); return; }
    var text = getRangePlainText(range) || sel.toString().trim();
    if (!text) { hideToolbar(); return; }
    var anchorEl = sel.anchorNode && sel.anchorNode.nodeType === 3
      ? sel.anchorNode.parentElement : sel.anchorNode;
    if (!anchorEl || !reviewContent.contains(anchorEl)) { hideToolbar(); return; }
    // Selections inside overlay-owned UI (rail, modals, inline ask input)
    // must not re-trigger the toolbar — that traps the user in a loop.
    if (anchorEl.closest && (
      anchorEl.closest('#orka-review-rail')
      || anchorEl.closest('.orka-ask-modal')
      || anchorEl.closest('.orka-ask-inline')
      || anchorEl.closest('.orka-ask-tray')
    )) { hideToolbar(); return; }
    lastSelectionRange = sel.getRangeAt(0);
    currentSelectedText = text;
    positionToolbar(lastSelectionRange);
  }

  document.addEventListener('mouseup', function() { setTimeout(checkSelection, 10); });
  document.addEventListener('touchend', function() { setTimeout(checkSelection, 150); });
  document.addEventListener('selectionchange', function() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) hideToolbar();
  });

  toolbar.addEventListener('mousedown', function(e) { e.preventDefault(); });
  commentBtn.addEventListener('click', function() {
    if (!currentSelectedText) return;
    openDialog(currentSelectedText);
    hideToolbar();
  });
  askBtn.addEventListener('click', function() {
    if (!currentSelectedText) return;
    openAskInline(currentSelectedText, lastSelectionRange);
    hideToolbar();
  });

  // -------- Ask flow: inline prompt → modal answer ------------------

  var askInline = null;

  function closeAskInline() {
    if (askInline && askInline.parentElement) askInline.parentElement.removeChild(askInline);
    askInline = null;
  }

  function openAskInline(selectedText, range) {
    closeAskInline();
    askInline = document.createElement('div');
    askInline.className = 'orka-ask-inline';
    var ta = document.createElement('textarea');
    ta.placeholder = 'Haz una pregunta sobre este fragmento…';
    ta.rows = 2;
    var send = document.createElement('button');
    send.type = 'button';
    send.innerHTML = ICON_SEND + '<span>Preguntar</span>';
    send.disabled = true;
    askInline.appendChild(ta);
    askInline.appendChild(send);
    document.body.appendChild(askInline);

    // Position near the selection (below the range, clamped to viewport).
    var rect = (range || (function() { var r = document.createRange(); r.selectNodeContents(document.body); return r; })()).getBoundingClientRect();
    askInline.style.display = 'inline-flex';
    var w = askInline.offsetWidth || 380;
    var left = Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - w - 8);
    var top = window.scrollY + rect.bottom + 8;
    askInline.style.left = Math.max(8, left) + 'px';
    askInline.style.top = top + 'px';

    ta.focus();
    ta.addEventListener('input', function() { send.disabled = !ta.value.trim(); });
    ta.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { closeAskInline(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!send.disabled) send.click(); }
    });
    send.addEventListener('click', function() {
      var question = ta.value.trim();
      if (!question) return;
      closeAskInline();
      launchAskModal(question, selectedText);
    });

    // Clicking outside cancels — but skip when the click lands on the
    // toolbar (already hidden) or the modal (opened by send).
    setTimeout(function() {
      var onDocDown = function(e) {
        if (!askInline) { document.removeEventListener('mousedown', onDocDown); return; }
        if (!askInline.contains(e.target)) { closeAskInline(); document.removeEventListener('mousedown', onDocDown); }
      };
      document.addEventListener('mousedown', onDocDown);
    }, 0);
  }

  // Cache the full document text once for Ask calls — the entire
  // rendered body (innerText) is used as the model's grounding context.
  var docTextCache = null;
  function getDocText() {
    if (docTextCache != null) return docTextCache;
    docTextCache = (document.body && document.body.innerText || '').slice(0);
    return docTextCache;
  }
  // Invalidate on any DOM mutation that touches the body (rare during
  // preview, but keeps the cache honest when marks / rails get added).
  var docTextInvalidator = new MutationObserver(function() { docTextCache = null; });
  try { docTextInvalidator.observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (_) {}

  // ---- Ask modal management (draggable, minimizable, stackable) ----

  var askTray = null;
  function ensureAskTray() {
    if (askTray) return askTray;
    askTray = document.createElement('div');
    askTray.className = 'orka-ask-tray';
    document.body.appendChild(askTray);
    return askTray;
  }

  var _askCounter = 0;
  // Offset each new modal so a stack of asks is visually distinguishable
  // and clicking through them is possible.
  function nextModalOffset() {
    var i = (_askCounter++) % 6;
    return { top: 80 + i * 26, right: 24 + i * 18 };
  }

  function launchAskModal(question, selectedText) {
    var modal = document.createElement('div');
    modal.className = 'orka-ask-modal';

    var header = document.createElement('div');
    header.className = 'orka-ask-modal-header';
    var title = document.createElement('div');
    title.className = 'orka-ask-modal-title';
    title.textContent = question.length > 60 ? question.slice(0, 57) + '…' : question;
    var minBtn = document.createElement('button');
    minBtn.type = 'button'; minBtn.className = 'orka-ask-modal-icon-btn';
    minBtn.title = 'Minimizar'; minBtn.textContent = '–';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.className = 'orka-ask-modal-icon-btn';
    closeBtn.title = 'Cerrar'; closeBtn.textContent = '×';
    header.appendChild(title); header.appendChild(minBtn); header.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'orka-ask-modal-body';
    var qEl = document.createElement('div');
    qEl.className = 'orka-ask-question';
    qEl.textContent = question;

    var exEl = document.createElement('div');
    exEl.className = 'orka-ask-excerpt';
    exEl.textContent = selectedText;

    var toggle = document.createElement('span');
    toggle.className = 'orka-ask-excerpt-toggle';
    toggle.textContent = 'Ocultar fragmento';
    toggle.addEventListener('click', function() {
      var hidden = exEl.style.display === 'none';
      exEl.style.display = hidden ? 'block' : 'none';
      toggle.textContent = hidden ? 'Ocultar fragmento' : 'Mostrar fragmento';
    });

    var content = document.createElement('div');
    var loading = document.createElement('div');
    loading.className = 'orka-ask-loading';
    loading.textContent = 'Pensando…';
    content.appendChild(loading);

    body.appendChild(qEl); body.appendChild(exEl); body.appendChild(toggle); body.appendChild(content);
    modal.appendChild(header); modal.appendChild(body);
    document.body.appendChild(modal);

    var off = nextModalOffset();
    modal.style.top = off.top + 'px';
    modal.style.right = off.right + 'px';

    // Drag from the header.
    (function() {
      var drag = null;
      header.addEventListener('mousedown', function(e) {
        if (e.target === minBtn || e.target === closeBtn) return;
        var r = modal.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        modal.style.right = 'auto';
        modal.style.left = r.left + 'px';
        e.preventDefault();
      });
      window.addEventListener('mousemove', function(e) {
        if (!drag) return;
        var w = modal.offsetWidth, h = modal.offsetHeight;
        var left = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - w);
        var top = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - h);
        modal.style.left = left + 'px';
        modal.style.top = top + 'px';
      });
      window.addEventListener('mouseup', function() { drag = null; });
    })();

    closeBtn.addEventListener('click', function() { modal.remove(); });
    minBtn.addEventListener('click', function() {
      modal.style.display = 'none';
      var tray = ensureAskTray();
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'orka-ask-pill';
      var label = document.createElement('span');
      label.textContent = question.length > 26 ? question.slice(0, 24) + '…' : question;
      var x = document.createElement('span');
      x.className = 'orka-ask-pill-close'; x.textContent = '×';
      pill.appendChild(label); pill.appendChild(x);
      pill.addEventListener('click', function(e) {
        if (e.target === x) { modal.remove(); pill.remove(); return; }
        modal.style.display = 'flex'; pill.remove();
      });
      tray.appendChild(pill);
    });

    // Fire the request.
    fetch(API_BASE + '/ai/ask-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: question,
        selectedText: selectedText,
        documentText: getDocText(),
        filePath: FILE_PATH,
      }),
    }).then(function(r) {
      return r.json().then(function(d) { return { ok: r.ok, data: d }; });
    }).then(function(result) {
      content.innerHTML = '';
      if (!result.ok || result.data && result.data.error) {
        var err = document.createElement('div');
        err.className = 'orka-ask-error';
        err.textContent = (result.data && result.data.error) || 'La solicitud falló.';
        content.appendChild(err);
        return;
      }
      var ans = document.createElement('div');
      ans.className = 'orka-ask-answer';
      ans.textContent = (result.data && result.data.answer) || '(respuesta vacía)';
      content.appendChild(ans);
    }).catch(function(e) {
      content.innerHTML = '';
      var err = document.createElement('div');
      err.className = 'orka-ask-error';
      err.textContent = 'Error de red: ' + (e && e.message || 'desconocido');
      content.appendChild(err);
    });
  }

  // -------- Helpers --------------------------------------------------

  function computeLineRange(text) {
    if (!sourceText) return { startLine: 1, endLine: 1 };
    var idx = sourceText.indexOf(text);
    if (idx < 0) return { startLine: 1, endLine: 1 };
    var before = sourceText.substring(0, idx);
    var startLine = (before.match(/\\n/g) || []).length + 1;
    var selLines = (text.match(/\\n/g) || []).length;
    return { startLine: startLine, endLine: startLine + selLines };
  }

  function showToast(msg, isError) {
    var el = document.createElement('div');
    el.className = 'orka-comment-toast' + (isError ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function() {
      el.style.transition = 'opacity 0.2s';
      el.style.opacity = '0';
      setTimeout(function() { el.remove(); }, 200);
    }, 1800);
  }

  function relTime(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return 'hace ' + s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return 'hace ' + m + ' min';
    var h = Math.floor(m / 60);
    if (h < 24) return 'hace ' + h + ' h';
    return new Date(t).toISOString().slice(0, 10);
  }

  // -------- Highlight matching text in the doc ----------------------

  // Highlight the phrase in the doc — 3-tier strategy so that most
  // selections (even ones spanning inline tags) get a visible mark:
  //
  //  1. FAST PATH: TreeWalker finds the phrase inside a single text
  //     node, wrap with surroundContents. Works for ~80% of selections.
  //
  //  2. CROSS-NODE PATH: normalize the doc's text content into a flat
  //     string, find the phrase's offset, then reconstruct a Range that
  //     spans multiple text nodes. Use extractContents + insertNode to
  //     wrap it — surroundContents throws on partial-node ranges but
  //     extract/insert does not. Works when the selection crossed
  //     inline formatting like <strong>, <em>, <a>.
  //
  //  3. FALLBACK: on any failure, do nothing visually — the comment is
  //     still saved and shows up in the rail, just without a mark in
  //     the doc.
  //
  // The walker skips the rail's own DOM so we never highlight text
  // inside a card snippet by accident.
  function isInRail(node) {
    var el = node && (node.nodeType === 3 ? node.parentElement : node);
    return el ? !!el.closest('#orka-review-rail') : false;
  }

  function attachMark(mark, commentId) {
    mark.className = 'orka-comment-mark';
    mark.dataset.commentId = commentId;
    mark.addEventListener('click', function(e) {
      e.stopPropagation();
      openRail();
      setActive(commentId, 'from-doc');
    });
  }

  function highlightPhrase(phrase, commentId) {
    if (!phrase) return null;

    // Tier 1: single-text-node substring match.
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      if (isInRail(node)) continue;
      if (node.parentElement && node.parentElement.closest('mark.orka-comment-mark')) continue;
      var idx = node.nodeValue.indexOf(phrase);
      if (idx === -1) continue;
      var range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + phrase.length);
      try {
        var mark = document.createElement('mark');
        range.surroundContents(mark);
        attachMark(mark, commentId);
        return mark;
      } catch (e) {
        // fall through to tier 2
      }
      break;
    }

    // Tier 2: cross-node span. Build a flat map of every text node
    // outside the rail with its cumulative character offset, find the
    // phrase in the joined string, then reconstruct the Range.
    var textNodes = [];
    var joined = '';
    var w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var n2;
    while ((n2 = w2.nextNode())) {
      if (isInRail(n2)) continue;
      if (n2.parentElement && n2.parentElement.closest('mark.orka-comment-mark')) continue;
      textNodes.push({ node: n2, start: joined.length, end: joined.length + n2.nodeValue.length });
      joined += n2.nodeValue;
    }
    // Normalize the phrase's whitespace the same way the browser
    // renders it — selection strings often collapse consecutive
    // whitespace whereas source text keeps it. If the exact phrase
    // isn't there, try a whitespace-collapsed variant on both sides.
    var idx2 = joined.indexOf(phrase);
    if (idx2 < 0) {
      var collapsed = phrase.replace(/\\s+/g, ' ');
      var joinedCol = joined.replace(/\\s+/g, ' ');
      var idxCol = joinedCol.indexOf(collapsed);
      if (idxCol >= 0) {
        idx2 = idxCol;
      }
    }
    if (idx2 < 0) return null;
    var startAbs = idx2;
    var endAbs = idx2 + phrase.length;
    var startNode = null, startOffset = 0;
    var endNode = null, endOffset = 0;
    for (var i = 0; i < textNodes.length; i++) {
      var tn = textNodes[i];
      if (startNode == null && tn.end >= startAbs) {
        startNode = tn.node;
        startOffset = Math.max(0, startAbs - tn.start);
      }
      if (endNode == null && tn.end >= endAbs) {
        endNode = tn.node;
        endOffset = Math.max(0, Math.min(tn.node.nodeValue.length, endAbs - tn.start));
        break;
      }
    }
    if (!startNode || !endNode) return null;

    // Wrap EACH text node inside the range independently. Never wrap
    // a Range that spans block elements — a single <mark> containing a
    // whole <section>/<div>/<li> would render as a giant colored
    // rectangle around block content (a <mark> is an inline element).
    // We visit every text node between start and end, compute the
    // sub-slice of that text node that falls inside the range, and
    // wrap only that slice.
    try {
      var full = document.createRange();
      full.setStart(startNode, startOffset);
      full.setEnd(endNode, endOffset);
      var common = full.commonAncestorContainer;
      // Range narrowed to the common ancestor's tree walker.
      var w3 = document.createTreeWalker(
        common.nodeType === 3 ? common.parentNode : common,
        NodeFilter.SHOW_TEXT,
        null
      );
      var toWrap = [];
      var seenStart = false;
      var n3;
      while ((n3 = w3.nextNode())) {
        if (isInRail(n3)) continue;
        if (n3.parentElement && n3.parentElement.closest('mark.orka-comment-mark')) continue;
        if (!seenStart) {
          if (n3 === startNode) seenStart = true; else continue;
        }
        var localStart = (n3 === startNode) ? startOffset : 0;
        var localEnd = (n3 === endNode) ? endOffset : n3.nodeValue.length;
        if (localEnd > localStart) toWrap.push({ node: n3, start: localStart, end: localEnd });
        if (n3 === endNode) break;
      }
      if (toWrap.length === 0) return null;
      var firstMark = null;
      for (var k = 0; k < toWrap.length; k++) {
        var it = toWrap[k];
        // Skip whitespace-only slices — wrapping " " between blocks
        // just adds visual noise on the page.
        if (!it.node.nodeValue.slice(it.start, it.end).trim()) continue;
        var sub = document.createRange();
        sub.setStart(it.node, it.start);
        sub.setEnd(it.node, it.end);
        try {
          var m = document.createElement('mark');
          sub.surroundContents(m);
          attachMark(m, commentId);
          if (!firstMark) firstMark = m;
        } catch (subErr) {
          // Skip this slice; keep going with the rest.
        }
      }
      return firstMark;
    } catch (e) {
      return null;
    }
  }

  function setActive(id, source) {
    activeId = id;
    Array.prototype.forEach.call(
      document.querySelectorAll('.orka-comment-mark.active, .orka-comment-card.active'),
      function(el) { el.classList.remove('active'); }
    );
    var card = document.querySelector('.orka-comment-card[data-comment-id="' + id + '"]');
    // A single comment may be split across MULTIPLE <mark>s when the
    // selection crossed inline formatting (e.g. plain text + <em> ...).
    // Activate every mark that carries this comment id so they all
    // switch to the orange focus state together — otherwise you get an
    // orange + yellow split for one logical highlight.
    var marks = document.querySelectorAll('.orka-comment-mark[data-comment-id="' + id + '"]');
    if (card) card.classList.add('active');
    for (var i = 0; i < marks.length; i++) marks[i].classList.add('active');
    if (source === 'from-doc' && card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (source === 'from-rail' && marks.length > 0) {
      marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // -------- Rail rendering ------------------------------------------

  function updateRailChrome() {
    var n = comments.length;
    railCount.textContent = String(n);
    handleBadge.textContent = n > 99 ? '99+' : String(n);
    handleBadge.dataset.count = String(n);
    applyBtn.disabled = n === 0;
    clearBtn.disabled = n === 0;
    railEmpty.style.display = n === 0 ? '' : 'none';
  }

  function makeCard(c) {
    var card = document.createElement('div');
    card.className = 'orka-comment-card' + (c.resolved ? ' resolved' : '');
    card.dataset.commentId = c.id;
    card.innerHTML =
      '<div class="orka-card-snippet"></div>' +
      '<div class="orka-card-body"></div>' +
      '<div class="orka-card-meta">' +
        '<span class="orka-card-time"></span>' +
        '<div class="orka-card-actions">' +
          '<button type="button" class="orka-card-btn" data-action="resolve" title="Marcar como resuelto">✓</button>' +
          '<button type="button" class="orka-card-btn danger" data-action="delete" title="Borrar comentario">✕</button>' +
        '</div>' +
      '</div>';
    card.querySelector('.orka-card-snippet').textContent =
      c.selectedText.length > 240 ? c.selectedText.slice(0, 240) + '…' : c.selectedText;
    card.querySelector('.orka-card-body').textContent = c.body;
    card.querySelector('.orka-card-time').textContent = relTime(c.createdAt) +
      (c.startLine ? ' · L' + c.startLine + (c.endLine > c.startLine ? '-' + c.endLine : '') : '');

    card.addEventListener('click', function(e) {
      if (e.target.closest('.orka-card-btn')) return;
      setActive(c.id, 'from-rail');
    });
    card.querySelector('[data-action="delete"]').addEventListener('click', function(e) {
      e.stopPropagation();
      if (!window.confirm('¿Borrar este comentario?')) return;
      fetch(API_BASE + '/projects/comments/' + encodeURIComponent(c.id) + '?project=' + encodeURIComponent(PROJECT_B64), {
        method: 'DELETE',
      }).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        removeCommentLocal(c.id);
        showToast('Comentario borrado');
      }).catch(function(err) {
        showToast('Falló borrado: ' + err.message, true);
      });
    });
    card.querySelector('[data-action="resolve"]').addEventListener('click', function(e) {
      e.stopPropagation();
      var newState = !c.resolved;
      fetch(API_BASE + '/projects/comments/' + encodeURIComponent(c.id) + '?project=' + encodeURIComponent(PROJECT_B64), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: newState }),
      }).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        c.resolved = newState;
        card.classList.toggle('resolved', newState);
      }).catch(function(err) {
        showToast('Falló actualización: ' + err.message, true);
      });
    });
    return card;
  }

  function addCommentLocal(c, opts) {
    comments.unshift(c);
    byId[c.id] = c;
    var card = makeCard(c);
    railBody.insertBefore(card, railBody.firstChild === railEmpty ? railEmpty.nextSibling : railBody.firstChild);
    highlightPhrase(c.selectedText, c.id);
    updateRailChrome();
    if (opts && opts.focus) {
      // User just wrote this — pop the rail open so they see the card land.
      openRail();
      setTimeout(function() { setActive(c.id, 'from-rail'); }, 100);
    }
  }

  function removeCommentLocal(id) {
    var idx = -1;
    for (var i = 0; i < comments.length; i++) if (comments[i].id === id) { idx = i; break; }
    if (idx >= 0) comments.splice(idx, 1);
    delete byId[id];
    var card = document.querySelector('.orka-comment-card[data-comment-id="' + id + '"]');
    if (card) card.remove();
    // Same "one comment can have many marks" story as setActive — unwrap
    // every mark that belongs to this comment.
    var allMarks = document.querySelectorAll('.orka-comment-mark[data-comment-id="' + id + '"]');
    for (var mi = 0; mi < allMarks.length; mi++) {
      var mm = allMarks[mi];
      var parent = mm.parentNode;
      while (mm.firstChild) parent.insertBefore(mm.firstChild, mm);
      parent.removeChild(mm);
    }
    updateRailChrome();
  }

  // -------- Initial load: fetch existing comments for this file ------

  fetch(API_BASE + '/projects/comments?project=' + encodeURIComponent(PROJECT_B64))
    .then(function(r) { return r.ok ? r.json() : []; })
    .then(function(all) {
      if (!Array.isArray(all)) return;
      var mine = all.filter(function(c) { return c.filePath === FILE_PATH; });
      // Sort newest first (createdAt desc) so freshest goes on top.
      mine.sort(function(a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
      // Insert in reverse so DOM order matches sorted-desc (unshift prepends).
      for (var i = mine.length - 1; i >= 0; i--) addCommentLocal(mine[i], null);
    })
    .catch(function() {});

  // -------- Write dialog --------------------------------------------

  function openDialog(selectedText) {
    var overlay = document.createElement('div');
    overlay.className = 'orka-comment-dialog-overlay';
    overlay.innerHTML =
      '<div class="orka-comment-dialog" role="dialog" aria-modal="true">' +
        '<h3 class="orka-comment-dialog-title">Nuevo comentario de revisión</h3>' +
        '<div class="orka-comment-dialog-snippet"></div>' +
        '<textarea class="orka-comment-dialog-textarea" placeholder="Escribí tu comentario… (Cmd/Ctrl+Enter para guardar)"></textarea>' +
        '<div class="orka-comment-dialog-actions">' +
          '<button type="button" class="orka-comment-dialog-btn secondary" data-action="cancel">Cancelar</button>' +
          '<button type="button" class="orka-comment-dialog-btn primary" data-action="save">Guardar</button>' +
        '</div>' +
      '</div>';
    overlay.querySelector('.orka-comment-dialog-snippet').textContent =
      selectedText.length > 500 ? selectedText.slice(0, 500) + '…' : selectedText;
    document.body.appendChild(overlay);

    var textarea = overlay.querySelector('.orka-comment-dialog-textarea');
    setTimeout(function() { textarea.focus(); }, 30);

    function close() { overlay.remove(); }
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);

    var saveBtn = overlay.querySelector('[data-action="save"]');
    function save() {
      var body = textarea.value.trim();
      if (!body) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Guardando…';
      var range = computeLineRange(selectedText);
      fetch(API_BASE + '/projects/comments?project=' + encodeURIComponent(PROJECT_B64), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: FILE_PATH,
          startLine: range.startLine,
          endLine: range.endLine,
          selectedText: selectedText,
          body: body,
        }),
      }).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function(saved) {
        close();
        var sel = window.getSelection();
        if (sel) sel.removeAllRanges();
        hideToolbar();
        addCommentLocal(saved, { focus: true });
        showToast('Comentario guardado');
      }).catch(function(err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Guardar';
        showToast('Falló: ' + (err && err.message ? err.message : 'desconocido'), true);
      });
    }
    saveBtn.addEventListener('click', save);
    textarea.addEventListener('keydown', function(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
      if (e.key === 'Escape') close();
    });
  }

  // -------- Apply with Claude: compose prompt + copy -----------------

  // Mirror of buildRegeneratePrompt() in
  // src/web-ui/src/components/CommentWidget.tsx — the same prompt that
  // the KB detail panel's magic-wand button ships to a terminal. Kept
  // in sync manually. Tells Claude to (a) read the current file + the
  // .changelog section for prior context, (b) rewrite the doc from
  // scratch weaving in every unresolved comment, (c) Write full-file
  // replacement, (d) bump version in the .changelog with a proper log
  // entry.
  function composeApplyPrompt() {
    var active = comments.filter(function(c) { return !c.resolved; });
    var isHtml = /\\.html?$/i.test(FILE_PATH);
    var projectPath;
    try { projectPath = atob(PROJECT_B64); } catch (_) { projectPath = '<project root>'; }
    var lines = [];
    lines.push('Regenerate the document \`' + FILE_PATH + '\` from scratch, incorporating the review comments below and any prior resolutions.');
    lines.push('');
    lines.push('## Steps');
    lines.push('');
    lines.push('1. Read the current file to understand its structure and intent.');
    if (isHtml) {
      lines.push('2. Read the \`<section class="changelog">\` at the bottom to see prior versions and what each addressed — keep decisions consistent across regens.');
    } else {
      lines.push('2. Read the comments log at \`.claude-orka/comments/log.md\` and grep it for prior entries referencing this file.');
    }
    lines.push('3. For each comment below, treat it as scoped feedback. **QUESTION**-type comments must be investigated (read code, related tickets, or do a deep-research pass) before being reflected in the rewrite.');
    lines.push('4. **Clean previous highlights first**: strip every existing \`<mark class="orka-diff-new">…</mark>\` wrapper from the current version, keeping the text inside. Only *this* regen\\\'s changes should stay highlighted.');
    lines.push('5. Rewrite the document from scratch, preserving its intent and structure but resolving every comment.');
    lines.push('6. **Mark what changed in this regen**: wrap ONLY the new, rewritten, or materially changed sentences / phrases / list items in \`<mark class="orka-diff-new">…</mark>\`. Keep it fine-grained — sentence-level ideally, never whole sections just because one line moved. Untouched paragraphs stay bare.');
    var lastStep;
    if (isHtml) {
      lines.push('7. Ensure the document\\\'s \`<style>\` block defines the highlight rule so the reviewer sees the marks. If not present, add:\\n   \`\`\`css\\n   mark.orka-diff-new { background: #fff3bf; color: inherit; padding: 1px 3px; border-radius: 3px; box-shadow: 0 0 0 1px rgba(240, 200, 90, 0.4); }\\n   \`\`\`');
      lines.push('8. Save the new content with the \`Write\` tool (full-file replacement, not patch). Path: \`' + FILE_PATH + '\`.');
      lines.push('9. Bump the version (major bump for a regen: \`v1.x → v2.0\`, chain further regens as \`v3.0\`, \`v4.0\`, etc.). Prepend a new \`<li>\` to the changelog with the version, ISO date, and a one-paragraph summary of what changed AND which comments it resolved (reference them inline). Update the \`.meta\` line to show the new "Current version" (or "Versión actual" if the file uses Spanish labels).');
      lastStep = 10;
    } else {
      lines.push('7. Save the new content with the \`Write\` tool (full-file replacement, not patch). Path: \`' + FILE_PATH + '\`.');
      lines.push('8. Append a **REGENERATE** entry to \`.claude-orka/comments/log.md\` with the version, timestamp, and what changed.');
      lastStep = 9;
    }
    lines.push(lastStep + '. **Delete the applied comments with the Orka CLI** — every comment listed below was baked into this regen, so it should no longer show up in the review rail. Run \`orka comment\` from the project root (\`' + projectPath + '\`). Two equivalent options:');
    lines.push('   - Bulk (recommended when all listed comments were applied): \`orka comment clear --file "' + FILE_PATH + '" --yes\` — wipes every comment on this file, including any that surfaced after this prompt was copied. Use with care.');
    lines.push('   - Surgical (drop only the comments this regen resolved): run \`orka comment delete <id>\` for each id in the "Comments to incorporate" list below. IDs are shown next to each comment header. Skip any comment that turned out to require follow-up work — leave those unresolved.');
    lines.push('   Either path removes the anchors from the rail on the next reload, so the reviewer\\\'s next pass only sees fresh feedback.');
    lines.push('');
    lines.push('## Comments to incorporate');
    lines.push('');
    for (var i = 0; i < active.length; i++) {
      var c = active[i];
      var lineRange = 'L' + c.startLine + (c.endLine > c.startLine ? '-' + c.endLine : '');
      lines.push('**' + lineRange + '** — id \`' + c.id + '\`');
      if (c.selectedText) {
        var snippet = c.selectedText.length > 240 ? c.selectedText.slice(0, 240) + '…' : c.selectedText;
        lines.push(' — selected:');
        lines.push('');
        lines.push('\`\`\`');
        snippet.split('\\n').forEach(function(l) { lines.push(l); });
        lines.push('\`\`\`');
        lines.push('');
      } else {
        lines.push('');
      }
      lines.push('> ' + c.body.replace(/\\n/g, '\\n> '));
      lines.push('');
    }
    lines.push('After saving, print a compact summary: what sections you changed, which comments you weaved in, and any research/deep-dive links.');
    return lines.join('\\n');
  }

  function copyText(text) {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function(resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand copy failed'));
      } catch (e) { reject(e); }
    });
  }

  applyBtn.addEventListener('click', function() {
    var active = comments.filter(function(c) { return !c.resolved; });
    if (active.length === 0) return;
    var prompt = composeApplyPrompt();
    copyText(prompt).then(function() {
      applyBtn.classList.add('flash-ok');
      var origHtml = applyBtn.innerHTML;
      applyBtn.innerHTML = '<span>✓ Copied (' + active.length + ')</span>';
      setTimeout(function() {
        applyBtn.classList.remove('flash-ok');
        applyBtn.innerHTML = origHtml;
      }, 2000);
      showToast('Prompt copied — paste it into any Claude Code terminal');
    }).catch(function(err) {
      showToast('Falló copia: ' + err.message, true);
    });
  });

  clearBtn.addEventListener('click', function() {
    var n = comments.length;
    if (n === 0) return;
    var msg = 'Vas a borrar ' + n + ' comentario' + (n === 1 ? '' : 's') + ' de este archivo. Esta acción no se puede deshacer. ¿Continuar?';
    if (!window.confirm(msg)) return;
    clearBtn.disabled = true;
    var origHtml = clearBtn.innerHTML;
    clearBtn.innerHTML = '<span>Borrando…</span>';
    fetch(API_BASE + '/projects/comments?project=' + encodeURIComponent(PROJECT_B64) + '&file=' + encodeURIComponent(FILE_PATH), {
      method: 'DELETE',
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(res) {
      var ids = comments.map(function(c) { return c.id; });
      for (var i = 0; i < ids.length; i++) removeCommentLocal(ids[i]);
      showToast('Se borraron ' + (res.deleted || 0) + ' comentario' + ((res.deleted || 0) === 1 ? '' : 's'));
      clearBtn.innerHTML = origHtml;
    }).catch(function(err) {
      clearBtn.disabled = false;
      clearBtn.innerHTML = origHtml;
      showToast('Falló limpieza: ' + err.message, true);
    });
  });
})();
</script>
`
}

async function buildFileTree(
  dirPath: string,
  basePath: string,
  depth: number = 0,
  maxDepth: number = 3
): Promise<FileTreeNode[]> {
  if (depth > maxDepth) {
    return []
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const nodes: FileTreeNode[] = []

  for (const entry of entries) {
    // Skip ignored patterns
    if (IGNORE_PATTERNS.includes(entry.name)) {
      continue
    }

    const fullPath = path.join(dirPath, entry.name)
    const relativePath = path.relative(basePath, fullPath)

    if (entry.isDirectory()) {
      const children = await buildFileTree(fullPath, basePath, depth + 1, maxDepth)
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'directory',
        children,
      })
    } else {
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
      })
    }
  }

  // Sort: directories first, then alphabetically
  nodes.sort((a, b) => {
    if (a.type === 'directory' && b.type === 'file') return -1
    if (a.type === 'file' && b.type === 'directory') return 1
    return a.name.localeCompare(b.name)
  })

  return nodes
}

/**
 * GET /api/files/list?project=<base64>&path=<relative>
 * Returns direct children of a directory with metadata (Finder-style listing)
 */
filesRouter.get('/list', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = (req.query.path as string) || ''

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const targetPath = relativePath ? path.join(projectPath, relativePath) : projectPath

    if (!await fs.pathExists(targetPath)) {
      res.status(404).json({ error: 'Path not found' })
      return
    }

    const stat = await fs.stat(targetPath)
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory' })
      return
    }

    const entries = await fs.readdir(targetPath, { withFileTypes: true })
    const items: {
      name: string
      path: string
      type: 'file' | 'directory'
      size: number
      modifiedAt: string
      extension: string
      childCount?: number
    }[] = []

    for (const entry of entries) {
      if (IGNORE_PATTERNS.includes(entry.name)) continue

      const entryFullPath = path.join(targetPath, entry.name)
      const entryRelativePath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name

      try {
        const entryStat = await fs.stat(entryFullPath)
        const isDir = entry.isDirectory()

        const item: typeof items[number] = {
          name: entry.name,
          path: entryRelativePath,
          type: isDir ? 'directory' : 'file',
          size: isDir ? 0 : entryStat.size,
          modifiedAt: entryStat.mtime.toISOString(),
          extension: isDir ? '' : (entry.name.split('.').pop()?.toLowerCase() || ''),
        }

        if (isDir) {
          try {
            const children = await fs.readdir(entryFullPath)
            item.childCount = children.filter(c => !IGNORE_PATTERNS.includes(c)).length
          } catch {
            item.childCount = 0
          }
        }

        items.push(item)
      } catch {
        // Skip entries we can't stat (permissions, etc.)
      }
    }

    // Sort: directories first, then alphabetically
    items.sort((a, b) => {
      if (a.type === 'directory' && b.type === 'file') return -1
      if (a.type === 'file' && b.type === 'directory') return 1
      return a.name.localeCompare(b.name)
    })

    const parentPath = relativePath
      ? relativePath.includes('/') ? relativePath.substring(0, relativePath.lastIndexOf('/')) : ''
      : null

    res.json({
      items,
      currentPath: relativePath,
      parentPath,
    })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/files/tree?project=<base64>
 * Returns the file tree for a project
 */
filesRouter.get('/tree', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await fs.pathExists(projectPath)) {
      res.status(404).json({ error: 'Project path not found' })
      return
    }

    const tree = await buildFileTree(projectPath, projectPath)
    res.json({ tree })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/files/tree-expand?project=<base64>&path=<relative>
 * Returns children for a specific directory (lazy loading)
 */
filesRouter.get('/tree-expand', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = req.query.path as string

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)
    const targetPath = relativePath ? path.join(projectPath, relativePath) : projectPath

    if (!isPathSafe(projectPath, relativePath || '')) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    if (!await fs.pathExists(targetPath)) {
      res.status(404).json({ error: 'Path not found' })
      return
    }

    const stat = await fs.stat(targetPath)
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory' })
      return
    }

    const children = await buildFileTree(targetPath, projectPath, 0, 1)
    res.json({ children })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/files/content?project=<base64>&path=<relative>
 * Returns the content of a file
 */
filesRouter.get('/content', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = req.query.path as string

    if (!projectEncoded || !relativePath) {
      res.status(400).json({ error: 'Project and path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const filePath = path.join(projectPath, relativePath)

    if (!await fs.pathExists(filePath)) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    const stat = await fs.stat(filePath)
    if (stat.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory' })
      return
    }

    // Check file size - limit to 5MB
    if (stat.size > 5 * 1024 * 1024) {
      res.status(413).json({ error: 'File too large (max 5MB)' })
      return
    }

    const content = await fs.readFile(filePath, 'utf-8')
    res.json({ content, path: relativePath, size: stat.size })
  } catch (error: any) {
    // Handle binary files gracefully
    if (error.code === 'ERR_INVALID_ARG_VALUE' || error.message?.includes('encoding')) {
      res.status(400).json({ error: 'Cannot read binary file' })
      return
    }
    res.status(500).json({ error: error.message })
  }
})

/**
 * PUT /api/files/content?project=<base64>&path=<relative>
 * Writes content to a file
 */
filesRouter.put('/content', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = req.query.path as string
    const { content } = req.body

    if (!projectEncoded || !relativePath) {
      res.status(400).json({ error: 'Project and path required' })
      return
    }

    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Content must be a string' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const filePath = path.join(projectPath, relativePath)

    // Ensure parent directory exists
    await fs.ensureDir(path.dirname(filePath))

    await fs.writeFile(filePath, content, 'utf-8')
    res.json({ success: true, path: relativePath })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/files/create?project=<base64>
 * Creates a new file or directory
 */
filesRouter.post('/create', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const { path: relativePath, type } = req.body

    if (!projectEncoded || !relativePath) {
      res.status(400).json({ error: 'Project and path required' })
      return
    }

    if (type !== 'file' && type !== 'directory') {
      res.status(400).json({ error: 'Type must be "file" or "directory"' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const targetPath = path.join(projectPath, relativePath)

    if (await fs.pathExists(targetPath)) {
      res.status(409).json({ error: 'Path already exists' })
      return
    }

    if (type === 'directory') {
      await fs.ensureDir(targetPath)
    } else {
      await fs.ensureDir(path.dirname(targetPath))
      await fs.writeFile(targetPath, '', 'utf-8')
    }

    res.json({ success: true, path: relativePath, type })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /api/files?project=<base64>&path=<relative>
 * Deletes a file or directory
 */
filesRouter.delete('/', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = req.query.path as string

    if (!projectEncoded || !relativePath) {
      res.status(400).json({ error: 'Project and path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const targetPath = path.join(projectPath, relativePath)

    if (!await fs.pathExists(targetPath)) {
      res.status(404).json({ error: 'Path not found' })
      return
    }

    await fs.remove(targetPath)
    res.json({ success: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/files/image?project=<base64>&path=<relative>
 * Serves an image file as binary
 */
filesRouter.get('/image', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = req.query.path as string

    if (!projectEncoded || !relativePath) {
      res.status(400).json({ error: 'Project and path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const filePath = path.join(projectPath, relativePath)

    if (!await fs.pathExists(filePath)) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    const stat = await fs.stat(filePath)
    if (stat.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory' })
      return
    }

    // Check file size - limit to 10MB for images
    if (stat.size > 10 * 1024 * 1024) {
      res.status(413).json({ error: 'File too large (max 10MB)' })
      return
    }

    // Get MIME type from extension
    const ext = path.extname(filePath).slice(1).toLowerCase()
    const mimeType = IMAGE_MIME_TYPES[ext]

    if (!mimeType) {
      res.status(400).json({ error: 'Not a supported image format' })
      return
    }

    // Set content type and serve file
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Cache-Control', 'public, max-age=3600')

    const fileStream = fs.createReadStream(filePath)
    fileStream.pipe(res)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * Who may frame a preview page.
 *
 * `'self'` alone breaks the common two-machine setup: an Orka server on
 * the laptop embedding a preview served by the Orka server on the desktop
 * (both reachable over the tailnet) is cross-origin, so the browser
 * refuses the frame outright. Tailnet + loopback origins are all the same
 * user's own machines, so widening to them costs nothing in clickjacking
 * terms while making cross-host embeds work natively (overlays, live
 * scripts and all) instead of falling back to the proxy below.
 */
const PREVIEW_FRAME_ANCESTORS = [
  "frame-ancestors 'self'",
  'https://*.ts.net:*',
  'http://*.ts.net:*',
  'https://localhost:*',
  'http://localhost:*',
  'https://127.0.0.1:*',
  'http://127.0.0.1:*',
].join(' ')

/**
 * GET /api/files/proxy?url=<absolute http(s) url>
 *
 * Same-origin embed proxy for the voice agent's attachment viewer.
 *
 * Attached URLs are rendered in an iframe, and remote pages routinely
 * refuse to be framed — `X-Frame-Options: DENY`, CSP `frame-ancestors`,
 * or (the case that motivated this) *another Orka server* whose preview
 * route pins `frame-ancestors` to its own origin list. Fetching the
 * document here and re-serving it from our origin sidesteps all of that:
 * the browser only ever sees the headers we emit.
 *
 * HTML gets a `<base href>` so relative *and* root-relative assets keep
 * resolving against the remote origin. Everything else (PDF, images,
 * text) streams through with its content type.
 *
 * The client sandboxes the resulting frame WITHOUT `allow-same-origin`,
 * so remote scripts run in an opaque origin and can't reach our storage
 * or APIs even though the bytes arrive from our host.
 */
const PROXY_TIMEOUT_MS = 20_000
const PROXY_MAX_BYTES = 25 * 1024 * 1024

filesRouter.get('/proxy', async (req, res) => {
  const raw = typeof req.query.url === 'string' ? req.query.url.trim() : ''
  if (!raw) {
    res.status(400).json({ error: 'url query param required' })
    return
  }

  let target: URL
  try {
    target = new URL(raw)
  } catch {
    res.status(400).json({ error: `invalid url: ${raw}` })
    return
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    res.status(400).json({ error: `unsupported scheme: ${target.protocol}` })
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS)
  try {
    const upstream = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'ClaudeOrkaViewer/1.0 (+https://github.com/enruana/claude-orka)',
        Accept: 'text/html,application/xhtml+xml,application/pdf,image/*,*/*;q=0.8',
      },
    })
    clearTimeout(timer)

    if (!upstream.ok) {
      res.status(502).json({ error: `upstream returned HTTP ${upstream.status}`, url: target.toString() })
      return
    }

    const contentType = (upstream.headers.get('content-type') || 'application/octet-stream').toLowerCase()
    const buf = Buffer.from(await upstream.arrayBuffer())
    if (buf.byteLength > PROXY_MAX_BYTES) {
      res.status(413).json({ error: `body too large (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)` })
      return
    }

    // Redirects change what relative URLs should resolve against.
    const finalUrl = upstream.url || target.toString()

    // Never forward the upstream's framing/transport policy — re-serving
    // it here would reintroduce the very block we're routing around.
    res.setHeader('Cache-Control', 'no-store')
    res.removeHeader('X-Frame-Options')

    if (contentType.includes('text/html') || contentType.includes('xhtml')) {
      let body = buf.toString('utf-8')
      if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1)

      // Drop any <base> the document ships with — ours has to win, and a
      // second <base> earlier in the head would shadow it.
      body = body.replace(/<base\b[^>]*>/gi, '')

      const baseTag = `<base href="${finalUrl.replace(/"/g, '&quot;')}">`
      const headOpen = body.match(/<head\b[^>]*>/i)
      if (headOpen) {
        const at = headOpen.index! + headOpen[0].length
        body = body.slice(0, at) + '\n' + baseTag + body.slice(at)
      } else if (/<html\b[^>]*>/i.test(body)) {
        body = body.replace(/(<html\b[^>]*>)/i, `$1<head>${baseTag}</head>`)
      } else {
        body = baseTag + '\n' + body
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.send(body)
      return
    }

    res.setHeader('Content-Type', contentType)
    res.send(buf)
  } catch (error: any) {
    clearTimeout(timer)
    if (error?.name === 'AbortError') {
      res.status(504).json({ error: `upstream timed out after ${PROXY_TIMEOUT_MS / 1000}s` })
      return
    }
    res.status(502).json({ error: error?.message || 'proxy fetch failed' })
  }
})

/**
 * GET /api/files/preview/:encodedProject/*
 *
 * Path-based file server used for the inline HTML preview in
 * FileViewerPage. Unlike `/api/files/raw` (which uses query params),
 * this endpoint puts the project + file path in the URL path, so
 * relative asset URLs inside the HTML (e.g. `<link href="style.css">`,
 * `<img src="img/foo.png">`) resolve correctly against the current
 * document URL — no `<base href>` injection needed.
 *
 * `:encodedProject` is URL-safe base64 (RFC 4648 §5: `-` for `+`, `_`
 * for `/`, no `=` padding) so it drops cleanly into a path segment.
 * The wildcard captures the relative file path (may contain slashes).
 */
// Express 5 (path-to-regexp v8) requires named wildcards — `*path`
// captures everything after the encoded project segment as a slash-
// separated list, exposed via `req.params.path` (string[] in v8).
filesRouter.get('/preview/:encodedProject/*path', async (req, res) => {
  try {
    const encodedProject = req.params.encodedProject
    const rawPath = (req.params as unknown as Record<string, string | string[]>).path
    const filePath = Array.isArray(rawPath) ? rawPath.join('/') : (rawPath || '')

    let projectPath: string
    try {
      // Node's `base64url` decoder handles the URL-safe alphabet natively.
      projectPath = Buffer.from(encodedProject, 'base64url').toString('utf-8')
    } catch {
      res.status(400).json({ error: 'invalid encodedProject' })
      return
    }

    if (!isPathSafe(projectPath, filePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }
    const fullPath = path.resolve(projectPath, filePath)
    if (!await fs.pathExists(fullPath)) {
      res.status(404).json({ error: 'File not found' })
      return
    }
    const stat = await fs.stat(fullPath)
    if (stat.isDirectory()) {
      res.status(400).json({ error: 'Cannot serve a directory' })
      return
    }

    const ext = path.extname(fullPath).slice(1).toLowerCase()
    const MIME_TYPES: Record<string, string> = {
      html: 'text/html', htm: 'text/html',
      css: 'text/css', js: 'text/javascript',
      json: 'application/json', xml: 'application/xml',
      svg: 'image/svg+xml', png: 'image/png',
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp',
      pdf: 'application/pdf', txt: 'text/plain',
      md: 'text/markdown',
    }

    if (ext === 'html' || ext === 'htm') {
      // Two independent opt-in overlays, both live on this same route:
      //   ?comments=1  — floating "add comment" button + rail
      //   ?voice=1     — floating mic FAB + captions rail
      // They coexist: FAB (bottom-right) and comment-rail (right side)
      // don't collide, and each overlay is its own DOM subtree.
      // CSP is relaxed identically when either is on — inline scripts,
      // same-origin fetch, same-origin WS.
      const commentsMode = req.query.comments === '1' || req.query.comments === 'true'
      const voiceMode    = req.query.voice    === '1' || req.query.voice    === 'true'

      if (commentsMode || voiceMode) {
        res.setHeader(
          'Content-Security-Policy',
          [
            "default-src 'self' data: blob:",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            // Voice mode plays Kokoro-synthesized PCM back through Web Audio.
            "media-src 'self' data: blob:",
            // 'self' covers wss:// to the same origin (needed by voice WS).
            "connect-src 'self'",
            // Voice mode now embeds /voice-agent in an iframe — allow
            // same-origin frames explicitly (some browsers require
            // frame-src even when default-src 'self' is set).
            "frame-src 'self'",
            PREVIEW_FRAME_ANCESTORS,
          ].join('; ')
        )
      } else {
        // Lockdown CSP for the sandbox iframe embed path (default).
        res.setHeader(
          'Content-Security-Policy',
          [
            "default-src 'self' data: blob:",
            "script-src 'none'",
            "connect-src 'none'",
            "form-action 'none'",
            PREVIEW_FRAME_ANCESTORS,
            "base-uri 'self'",
          ].join('; ')
        )
      }
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')

      let body = await fs.readFile(fullPath, 'utf-8')
      if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1)

      // Match doctype at the very start, ignoring any HTML comments and
      // whitespace that precede it — otherwise generators that emit a
      // "<!-- generated at ... -->" line before the doctype get a second
      // doctype prepended, throwing the browser into quirks mode.
      const hasDoctype = /^(?:\s|<!--[\s\S]*?-->)*<!doctype/i.test(body)
      if (!hasDoctype) {
        body = '<!DOCTYPE html>\n' + body
      }

      if (commentsMode || voiceMode) {
        // Compose the two overlays (either or both). Both inject just
        // before </body> — for HTML files without </body> we append.
        const projectB64 = Buffer.from(projectPath, 'utf-8').toString('base64')
        let overlay = ''
        if (commentsMode) overlay += buildCommentsOverlay({ projectB64, filePath })
        if (voiceMode)    overlay += buildVoiceOverlay({ projectB64, filePath })
        const bodyCloseIdx = body.search(/<\/body\s*>/i)
        if (bodyCloseIdx >= 0) {
          body = body.slice(0, bodyCloseIdx) + overlay + body.slice(bodyCloseIdx)
        } else {
          body = body + overlay
        }

        // Force a mobile viewport meta so the overlay renders at 1:1
        // instead of shrunk to the 980px legacy viewport when the
        // source HTML doesn't declare one. `viewport-fit=cover` is
        // required for `env(safe-area-inset-*)` in the widget to
        // actually pick up iPhone notch/home-indicator insets.
        // Only inject when neither the doc nor a prior overlay has
        // already provided one, so authored preview pages keep their
        // own viewport declaration.
        if (!/<meta\s+[^>]*name=["']?viewport["']?/i.test(body)) {
          const viewportTag = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
          const headOpenMatch = body.match(/<head\b[^>]*>/i)
          if (headOpenMatch) {
            const insertAt = headOpenMatch.index! + headOpenMatch[0].length
            body = body.slice(0, insertAt) + '\n' + viewportTag + body.slice(insertAt)
          } else {
            // No <head> tag at all — prepend after the doctype so it
            // still lands in the pre-body region.
            body = body.replace(/(<!DOCTYPE[^>]*>\s*)/i, `$1${viewportTag}\n`) || (viewportTag + '\n' + body)
          }
        }
      }

      res.send(body)
      return
    }

    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream')
    fs.createReadStream(fullPath).pipe(res)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/files/raw?project=<base64>&path=<relative>
 * Serve a file with its native content type (for HTML preview, etc.)
 */
filesRouter.get('/raw', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const filePath = req.query.path as string

    if (!projectEncoded || !filePath) {
      res.status(400).json({ error: 'project and path are required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, filePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const fullPath = path.resolve(projectPath, filePath)

    if (!await fs.pathExists(fullPath)) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    const stat = await fs.stat(fullPath)
    if (stat.isDirectory()) {
      res.status(400).json({ error: 'Cannot serve a directory' })
      return
    }

    const ext = path.extname(fullPath).slice(1).toLowerCase()
    const MIME_TYPES: Record<string, string> = {
      html: 'text/html', htm: 'text/html',
      css: 'text/css', js: 'text/javascript',
      json: 'application/json', xml: 'application/xml',
      svg: 'image/svg+xml', png: 'image/png',
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp',
      pdf: 'application/pdf', txt: 'text/plain',
      md: 'text/markdown',
    }

    // HTML preview needs two guarantees for the file to render the way
    // the author saw it in the editor:
    //   1. UTF-8 charset in the header (accented characters, emoji, etc.
    //      — otherwise Chrome/Safari can decode as Latin-1 and mangle them).
    //   2. A doctype so the browser enters standards mode. Many docs
    //      generated by tools / hand-authored snippets start with a
    //      `<title>` or `<style>` fragment; without a doctype the page
    //      renders in quirks mode and CSS box-sizing / line-height / table
    //      layouts silently misbehave.
    //
    // For non-HTML files we keep the original streaming path (avoids
    // buffering PDFs / images).
    if (ext === 'html' || ext === 'htm') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')

      let body = await fs.readFile(fullPath, 'utf-8')
      // Strip any leading BOM (browsers handle it, but our doctype sniff
      // shouldn't be tripped by an invisible byte).
      if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1)

      const startsWithDoctype = /^(?:\s|<!--[\s\S]*?-->)*<!doctype/i.test(body)
      if (!startsWithDoctype) {
        // Prepend a doctype; browsers will still auto-generate <html> /
        // <body> around whatever fragment follows. Standards mode + a
        // correctly-declared charset are what the file was missing.
        body = '<!DOCTYPE html>\n' + body
      }
      res.send(body)
      return
    }

    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream')
    fs.createReadStream(fullPath).pipe(res)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/files/download?project=<base64>&path=<relative>
 * Downloads a file or directory as a zip archive (directories) or raw file (single files)
 */
filesRouter.get('/download', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const relativePath = (req.query.path as string) || ''

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, relativePath)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const targetPath = relativePath ? path.join(projectPath, relativePath) : projectPath

    if (!await fs.pathExists(targetPath)) {
      res.status(404).json({ error: 'Path not found' })
      return
    }

    const stat = await fs.stat(targetPath)
    const name = path.basename(targetPath) || 'project'

    if (stat.isDirectory()) {
      // Stream a tar.gz archive of the directory using system tar
      const archiveName = `${name}.tar.gz`
      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`)

      const parentDir = path.dirname(targetPath)
      const dirName = path.basename(targetPath)

      const tar = execa('tar', ['czf', '-', dirName], {
        cwd: parentDir,
        stdout: 'pipe',
        stderr: 'pipe',
        buffer: false,
      })

      tar.stdout!.pipe(res)

      tar.stderr!.on('data', (chunk: Buffer) => {
        console.error('tar stderr:', chunk.toString())
      })

      res.on('close', () => {
        tar.kill()
      })

      await tar.catch((err) => {
        if (!res.headersSent) {
          res.status(500).json({ error: err.message })
        }
      })
    } else {
      // Single file download
      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
      res.setHeader('Content-Length', stat.size.toString())
      fs.createReadStream(targetPath).pipe(res)
    }
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message })
    }
  }
})

/**
 * GET /api/files/search?project=<base64>&query=<string>&caseSensitive=<bool>&regex=<bool>
 * Search for text across project files using grep
 */
filesRouter.get('/search', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const query = req.query.query as string
    const caseSensitive = req.query.caseSensitive === 'true'
    const regex = req.query.regex === 'true'

    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    if (!query || query.length < 2) {
      res.status(400).json({ error: 'Query must be at least 2 characters' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await fs.pathExists(projectPath)) {
      res.status(404).json({ error: 'Project path not found' })
      return
    }

    const EXCLUDE_DIRS = [
      'node_modules', '.git', 'dist', '.next', '.claude-orka',
      '__pycache__', '.venv', '.tsbuildinfo', 'coverage', '.nyc_output',
      'build', '.cache', '.parcel-cache',
    ]

    const args: string[] = [
      '-rn',           // recursive, line numbers
      '-I',            // skip binary files
      '--color=never', // no ANSI colors
    ]

    if (!caseSensitive) args.push('-i')
    if (regex) {
      args.push('-E') // extended regex
    } else {
      args.push('-F') // fixed string (literal)
    }

    for (const dir of EXCLUDE_DIRS) {
      args.push(`--exclude-dir=${dir}`)
    }

    args.push('--', query, '.')

    const MAX_MATCHES = 500

    const result = await execa('grep', args, {
      cwd: projectPath,
      reject: false,
      timeout: 10000,
      stripFinalNewline: true,
    })

    // grep exit code 1 = no matches, 2 = error
    if (result.exitCode === 2) {
      res.status(500).json({ error: 'Search failed: ' + (result.stderr || 'unknown error') })
      return
    }

    if (!result.stdout || result.exitCode === 1) {
      res.json({ results: [], totalMatches: 0, truncated: false })
      return
    }

    const lines = result.stdout.split('\n').filter(Boolean)
    const truncated = lines.length > MAX_MATCHES
    const limitedLines = lines.slice(0, MAX_MATCHES)

    // Parse grep output: ./path/to/file:lineNum:matched text
    const fileMap = new Map<string, { line: number; text: string }[]>()

    for (const line of limitedLines) {
      // Match: ./relative/path:lineNumber:text
      const match = line.match(/^\.\/(.+?):(\d+):(.*)$/)
      if (!match) continue

      const [, filePath, lineStr, text] = match
      const lineNum = parseInt(lineStr, 10)

      if (!fileMap.has(filePath)) {
        fileMap.set(filePath, [])
      }
      fileMap.get(filePath)!.push({ line: lineNum, text: text.trim() })
    }

    const results = Array.from(fileMap.entries()).map(([filePath, matches]) => ({
      path: filePath,
      matches,
    }))

    res.json({
      results,
      totalMatches: lines.length > MAX_MATCHES ? lines.length : limitedLines.length,
      truncated,
    })
  } catch (error: any) {
    if (error.timedOut) {
      res.status(408).json({ error: 'Search timed out' })
      return
    }
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/files/move?project=<base64>
 * Moves a file or directory from one path to another
 */
filesRouter.post('/move', async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    const { from, to } = req.body

    if (!projectEncoded || !from || !to) {
      res.status(400).json({ error: 'Project, from, and to paths required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!isPathSafe(projectPath, from) || !isPathSafe(projectPath, to)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const fromAbsolute = path.resolve(projectPath, from)
    const toAbsolute = path.resolve(projectPath, to)

    if (!await fs.pathExists(fromAbsolute)) {
      res.status(404).json({ error: 'Source path not found' })
      return
    }

    // Prevent moving a folder into itself or a descendant
    const fromStat = await fs.stat(fromAbsolute)
    if (fromStat.isDirectory() && (toAbsolute + '/').startsWith(fromAbsolute + '/')) {
      res.status(400).json({ error: 'Cannot move a folder into itself' })
      return
    }

    // Ensure target parent directory exists
    const toParent = path.dirname(toAbsolute)
    if (!await fs.pathExists(toParent)) {
      res.status(400).json({ error: 'Target parent directory does not exist' })
      return
    }

    // Check for name conflict at destination
    if (await fs.pathExists(toAbsolute)) {
      res.status(409).json({ error: 'A file or folder with that name already exists at the destination' })
      return
    }

    await fs.move(fromAbsolute, toAbsolute)
    res.json({ success: true, from, to })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/files/upload?project=<base64>
 * Uploads files to a specified directory within the project.
 * Body (multipart): files[] + destination (relative path, defaults to project root)
 */
const upload = multer({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max per file
})

// Accept both 'files' (plural, from finder) and 'file' (singular, from terminal drag-drop)
const uploadFields = upload.fields([
  { name: 'files', maxCount: 20 },
  { name: 'file', maxCount: 1 },
])

filesRouter.post('/upload', uploadFields, async (req, res) => {
  try {
    const projectEncoded = req.query.project as string
    if (!projectEncoded) {
      res.status(400).json({ error: 'Project path required' })
      return
    }

    const projectPath = decodeProjectPath(projectEncoded)

    if (!await fs.pathExists(projectPath)) {
      res.status(404).json({ error: 'Project path not found' })
      return
    }

    const reqFiles = req.files as Record<string, Express.Multer.File[]> | undefined
    const files = [
      ...(reqFiles?.['files'] || []),
      ...(reqFiles?.['file'] || []),
    ]
    if (files.length === 0) {
      res.status(400).json({ error: 'No files provided' })
      return
    }

    // Destination directory (relative to project root)
    // Finder always sends 'destination' field (even empty for root).
    // Terminal callers don't send it at all → fall back to .claude-orka/uploads/
    const hasDestination = req.body != null && 'destination' in req.body
    const destination = (req.body?.destination as string) || ''

    const useUploadsDir = !hasDestination
    const targetDir = useUploadsDir
      ? path.join(projectPath, '.claude-orka', 'uploads')
      : destination
        ? path.join(projectPath, destination)
        : projectPath

    if (destination && !isPathSafe(projectPath, destination)) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    await fs.ensureDir(targetDir)

    const uploaded: { name: string; path: string; absolutePath: string }[] = []

    for (const file of files) {
      // Sanitize filename: remove path separators and null bytes
      const sanitizedName = file.originalname
        .replace(/[/\\]/g, '_')
        .replace(/\0/g, '')
        .replace(/\.\./g, '_')

      // Add timestamp prefix for uploads dir to avoid collisions
      const fileName = useUploadsDir ? `${Date.now()}-${sanitizedName}` : sanitizedName
      const destPath = path.join(targetDir, fileName)

      // Verify the resolved path is within the project directory
      if (!path.resolve(destPath).startsWith(path.resolve(projectPath))) {
        continue // Skip unsafe files
      }

      await fs.writeFile(destPath, file.buffer)

      const relativePath = path.relative(projectPath, destPath)
      uploaded.push({ name: sanitizedName, path: relativePath, absolutePath: destPath })
    }

    res.json({ success: true, uploaded })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})
