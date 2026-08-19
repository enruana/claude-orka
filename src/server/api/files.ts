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
    background: #f6f8fa;
    border-left: 1px solid #d0d7de;
    display: flex;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #1f2328;
    z-index: 2147483645;
    /* Fully off-screen by default — no strip of the rail poking out. */
    transform: translateX(100%);
    transition: transform 0.22s ease-out;
    box-shadow: -8px 0 32px rgba(0,0,0,0.10);
  }
  body.orka-rail-open #orka-review-rail {
    transform: translateX(0);
  }
  .orka-rail-header {
    padding: 14px 16px;
    border-bottom: 1px solid #d0d7de;
    background: white;
    display: flex;
    flex-direction: column;
    gap: 10px;
    position: sticky; top: 0; z-index: 5;
  }
  .orka-rail-title {
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; font-weight: 600;
  }
  .orka-rail-count {
    background: #eaeef2; color: #57606a;
    padding: 1px 8px; border-radius: 999px;
    font-family: ui-monospace, monospace; font-size: 11px;
  }
  .orka-rail-apply {
    flex: 1;
    padding: 8px 12px;
    border-radius: 6px;
    border: 0;
    background: #ea580c;
    color: white;
    font-weight: 600;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  }
  .orka-rail-apply:hover { filter: brightness(1.08); }
  .orka-rail-apply:disabled { opacity: 0.5; cursor: not-allowed; }
  .orka-rail-apply.flash-ok { background: #16a34a; }
  .orka-rail-actions {
    display: flex; gap: 8px; align-items: center;
  }
  .orka-rail-toggle {
    border: 1px solid #d0d7de;
    background: white;
    color: #57606a;
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .orka-rail-toggle:hover { color: #24292f; }

  .orka-rail-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .orka-rail-empty {
    text-align: center;
    color: #6e7781;
    font-style: italic;
    font-size: 13px;
    padding: 40px 20px;
    line-height: 1.5;
  }

  /* ---- Comment card ---- */
  .orka-comment-card {
    background: white;
    border: 1px solid #d0d7de;
    border-radius: 8px;
    padding: 12px;
    animation: orka-card-in 0.22s ease-out;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .orka-comment-card:hover {
    border-color: #ea580c;
  }
  .orka-comment-card.active {
    border-color: #ea580c;
    box-shadow: 0 0 0 2px rgba(234,88,12,0.15);
  }
  .orka-comment-card.resolved {
    opacity: 0.6;
    border-style: dashed;
  }
  .orka-card-snippet {
    background: #fff8e1;
    border-left: 3px solid #eab308;
    padding: 6px 8px;
    font-size: 12px;
    color: #57606a;
    font-family: ui-monospace, monospace;
    border-radius: 3px;
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
    color: #1f2328;
    line-height: 1.5;
    white-space: pre-wrap;
    margin-bottom: 6px;
  }
  .orka-card-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    color: #6e7781;
    padding-top: 6px;
    border-top: 1px dashed #eaeef2;
  }
  .orka-card-actions { display: flex; gap: 4px; }
  .orka-card-btn {
    background: transparent;
    border: 0;
    color: #6e7781;
    cursor: pointer;
    padding: 3px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-family: inherit;
    transition: color 0.12s, background 0.12s;
  }
  .orka-card-btn:hover { background: #eaeef2; color: #1f2328; }
  .orka-card-btn.danger:hover { background: #ffe5e5; color: #dc2626; }

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
    background: rgba(234,179,8,0.35) !important;
    color: inherit !important;
    padding: 0 1px !important;
    border-radius: 2px !important;
    cursor: pointer !important;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
    transition: background 0.15s;
  }
  mark.orka-comment-mark:hover,
  .orka-comment-mark:hover {
    background: rgba(234,179,8,0.55) !important;
  }
  mark.orka-comment-mark.active,
  .orka-comment-mark.active {
    background: rgba(234,88,12,0.45) !important;
    outline: 1px solid rgba(234,88,12,0.85) !important;
    outline-offset: 0;
  }

  /* ---- Floating "add" button on selection ---- */
  .orka-add-comment-btn {
    position: absolute;
    z-index: 2147483646;
    display: none;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(0,0,0,0.15);
    background: #ea580c;
    color: white;
    font-size: 12px;
    font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    line-height: 1;
    user-select: none;
  }
  .orka-add-comment-btn:hover { filter: brightness(1.08); }

  /* ---- Write dialog (modal for typing) ---- */
  .orka-comment-dialog-overlay {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(0,0,0,0.45); backdrop-filter: blur(2px);
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  }
  .orka-comment-dialog {
    background: white; color: #1a1a1a;
    border-radius: 12px; width: min(520px, 92vw);
    padding: 20px 22px; box-shadow: 0 30px 60px rgba(0,0,0,0.3);
    display: flex; flex-direction: column; gap: 12px;
  }
  .orka-comment-dialog-title { font-size: 15px; font-weight: 600; margin: 0; }
  .orka-comment-dialog-snippet {
    font-size: 12px; color: #444;
    background: #fff8e1; border-radius: 6px; padding: 8px 10px;
    max-height: 100px; overflow: auto; white-space: pre-wrap;
    border-left: 3px solid #eab308;
    font-family: ui-monospace, monospace;
  }
  .orka-comment-dialog-textarea {
    width: 100%; min-height: 100px; padding: 10px;
    border: 1px solid #d1d5db; border-radius: 8px;
    font-family: inherit; font-size: 14px; resize: vertical;
    color: #1a1a1a; background: white; box-sizing: border-box;
  }
  .orka-comment-dialog-textarea:focus { outline: 2px solid #ea580c; outline-offset: 0; }
  .orka-comment-dialog-actions {
    display: flex; justify-content: flex-end; gap: 8px;
  }
  .orka-comment-dialog-btn {
    padding: 8px 14px; border-radius: 8px; border: 0;
    font-family: inherit; font-size: 13px; font-weight: 600;
    cursor: pointer;
  }
  .orka-comment-dialog-btn.primary { background: #ea580c; color: white; }
  .orka-comment-dialog-btn.primary:hover { filter: brightness(1.08); }
  .orka-comment-dialog-btn.secondary { background: transparent; color: #444; }
  .orka-comment-dialog-btn.secondary:hover { background: #f0f0f0; }

  /* ---- Toast ---- */
  .orka-comment-toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647;
    background: #10b981; color: white;
    padding: 10px 16px; border-radius: 999px;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px; font-weight: 600;
    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    animation: orka-toast-in 0.15s ease-out;
  }
  .orka-comment-toast.error { background: #dc2626; }
  @keyframes orka-toast-in {
    from { opacity: 0; transform: translate(-50%, 10px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  /* ---- Handle — always-visible orange button pinned to the viewport
          right edge (or bottom on mobile). Fixed positioning means it
          survives the rail sliding on/off screen. Hidden when the rail
          is open so it doesn't overlap the close button. ---- */
  .orka-rail-handle {
    position: fixed;
    right: 0; top: 20px;
    width: 44px; min-height: 52px;
    background: #ea580c; color: white;
    border: 0;
    border-radius: 8px 0 0 8px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 2px;
    cursor: pointer;
    font-weight: 700;
    font-size: 20px;
    box-shadow: -4px 0 14px rgba(0,0,0,0.18);
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    padding: 8px 0;
    z-index: 2147483646;
    transition: transform 0.18s ease-out;
  }
  .orka-rail-handle:hover { transform: translateX(-3px); }
  .orka-rail-handle-badge {
    font-size: 10px;
    font-weight: 700;
    background: white;
    color: #ea580c;
    border-radius: 999px;
    padding: 1px 6px;
    min-width: 16px;
    text-align: center;
    line-height: 1.2;
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
      border-top: 1px solid #d0d7de;
    }
    body.orka-rail-open #orka-review-rail { transform: translateY(0); }
    .orka-rail-handle {
      right: 20px; bottom: 20px; top: auto;
      border-radius: 999px;
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

  // -------- Selection → floating "+" button --------------------------

  var addBtn = document.createElement('button');
  addBtn.className = 'orka-add-comment-btn';
  addBtn.type = 'button';
  addBtn.textContent = '💬 Comentar';
  document.body.appendChild(addBtn);

  var currentSelectedText = '';

  function hideAddBtn() { addBtn.style.display = 'none'; }

  function positionAddBtn(range) {
    var rect = range.getBoundingClientRect();
    var top = window.scrollY + rect.bottom + 6;
    var left = Math.min(window.scrollX + rect.right, window.scrollX + window.innerWidth - 140);
    addBtn.style.top = top + 'px';
    addBtn.style.left = left + 'px';
    addBtn.style.display = 'block';
  }

  function checkSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideAddBtn(); return; }
    var text = sel.toString().trim();
    if (!text) { hideAddBtn(); return; }
    // Only accept selections inside the doc content (not in the rail).
    var anchorEl = sel.anchorNode && sel.anchorNode.nodeType === 3
      ? sel.anchorNode.parentElement : sel.anchorNode;
    if (!anchorEl || !reviewContent.contains(anchorEl)) { hideAddBtn(); return; }
    var range = sel.getRangeAt(0);
    currentSelectedText = text;
    positionAddBtn(range);
  }

  document.addEventListener('mouseup', function() { setTimeout(checkSelection, 10); });
  document.addEventListener('touchend', function() { setTimeout(checkSelection, 150); });
  document.addEventListener('selectionchange', function() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) hideAddBtn();
  });

  addBtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
  addBtn.addEventListener('click', function() {
    if (!currentSelectedText) return;
    openDialog(currentSelectedText);
  });

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
        hideAddBtn();
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
    lines.push('4. Rewrite the document from scratch, preserving its intent and structure but resolving every comment.');
    lines.push('5. Save the new content with the \`Write\` tool (full-file replacement, not patch). Path: \`' + FILE_PATH + '\`.');
    if (isHtml) {
      lines.push('6. Bump the version (major bump for a regen: \`v1.x → v2.0\`, chain further regens as \`v3.0\`, \`v4.0\`, etc.). Prepend a new \`<li>\` to the changelog with the version, ISO date, and a one-paragraph summary of what changed AND which comments it resolved (reference them inline). Update the \`.meta\` line to show the new "Current version" (or "Versión actual" if the file uses Spanish labels).');
    } else {
      lines.push('6. Append a **REGENERATE** entry to \`.claude-orka/comments/log.md\` with the version, timestamp, and what changed.');
    }
    lines.push('');
    lines.push('## Comments to incorporate');
    lines.push('');
    for (var i = 0; i < active.length; i++) {
      var c = active[i];
      var lineRange = 'L' + c.startLine + (c.endLine > c.startLine ? '-' + c.endLine : '');
      lines.push('**' + lineRange + '**');
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
            "frame-ancestors 'self'",
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
            "frame-ancestors 'self'",
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
