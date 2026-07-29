// Orka Chrome Extension - Background Service Worker
//
// The extension used to open a floating recorder popup + a side panel
// consumer. The recorder now lives entirely inside the side panel
// (sidepanel.html/js/css), so this SW only needs to:
//   1. Hand out fresh tab-capture streamIds when the side panel asks.
//   2. Keep the legacy `openRecorder` handler as a no-op / fallback in
//      case someone still has the old popup URL bookmarked.

chrome.runtime.onInstalled.addListener(() => {
  console.log('Orka extension installed')
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getStreamId') {
    handleGetStreamId({ targetTabId: message.targetTabId }).then(sendResponse)
    return true
  }
  if (message.action === 'ensureOffscreen') {
    ensureOffscreenDocument().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ error: err.message })
    )
    return true
  }
  if (message.action === 'closeOffscreen') {
    closeOffscreenDocument().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ error: err.message })
    )
    return true
  }
  // Legacy handlers kept for backward compatibility with any pinned
  // popup window still around from an earlier install. They just no-op
  // if the caller no longer exists.
  if (message.action === 'openRecorder') {
    handleOpenRecorder(message).then(sendResponse)
    return true
  }
  if (message.action === 'openSidePanel') {
    handleOpenSidePanel(message).then(sendResponse)
    return true
  }
})

/**
 * Ensure the offscreen document exists — it owns the recording pipeline
 * (AudioContext, MediaRecorder, WebSocket, worklet) so it can outlive
 * the side panel / float popup. Only ONE offscreen doc per extension.
 */
async function ensureOffscreenDocument() {
  // hasDocument() was added later; check its existence before calling.
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    const exists = await chrome.offscreen.hasDocument()
    if (exists) return
  } else {
    // Fallback: attempt create and swallow "already exists" errors.
    try {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('offscreen.html'),
        reasons: ['USER_MEDIA'],
        justification: 'Long-lived meeting recorder + live transcription pipeline that must survive UI closes.',
      })
    } catch (err) {
      if (/single offscreen/i.test(err.message)) return
      throw err
    }
    return
  }
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['USER_MEDIA'],
    justification: 'Long-lived meeting recorder + live transcription pipeline that must survive UI closes.',
  })
}

async function closeOffscreenDocument() {
  try { await chrome.offscreen.closeDocument() } catch {}
}

/**
 * Return a tab-capture streamId for the specified (or currently active)
 * tab. The streamId Chrome issues here expires after ~10 seconds and is
 * single-use, so callers must invoke `getUserMedia` immediately.
 */
async function handleGetStreamId({ targetTabId } = {}) {
  try {
    let tabId = targetTabId
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      tabId = tab?.id
    }
    if (!tabId) return { error: 'No target tab found' }

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    })
    return { streamId, tabId }
  } catch (err) {
    return { error: err.message }
  }
}

// Legacy: open the side panel for the given (or active) tab.
async function handleOpenSidePanel({ tabId } = {}) {
  try {
    let target = tabId
    if (!target) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      target = tab?.id
    }
    if (!target) return { error: 'no active tab' }
    await chrome.sidePanel.setOptions({
      tabId: target,
      path: 'sidepanel.html',
      enabled: true,
    })
    await chrome.sidePanel.open({ tabId: target })
    return { success: true }
  } catch (err) {
    return { error: err.message }
  }
}

// Legacy popup opener (superseded by the side panel).
async function handleOpenRecorder({ mode, deviceId, tabId, streamId, live, liveLanguage }) {
  try {
    const params = new URLSearchParams({
      mode: mode || 'tab',
      deviceId: deviceId || '',
      tabId: (tabId || 0).toString(),
      streamId: streamId || '',
      live: live ? '1' : '0',
      liveLanguage: liveLanguage || 'auto',
    })
    await chrome.windows.create({
      url: chrome.runtime.getURL('recorder.html?' + params.toString()),
      type: 'popup',
      width: 320,
      height: 260,
      top: 80,
      left: 80,
      focused: true,
    })
    return { success: true }
  } catch (err) {
    return { error: err.message }
  }
}
