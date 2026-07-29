// Server status check
;(async () => {
  const SERVER = await getServerUrl()
  const dot = document.getElementById('status-dot')
  try {
    const res = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(3000) })
    dot.className = 'status-dot ' + (res.ok ? 'online' : 'offline')
  } catch {
    dot.className = 'status-dot offline'
  }
})()

// Writer - open in new tab
document.getElementById('btn-writer').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('writer.html') })
  window.close()
})

// Recorder — moved out of a floating popup into the side panel so the
// user can keep the recording UI docked and even minimize it to a thin
// strip while they're on the actual meeting tab. Clicking the button:
//   1. Reads the currently active tab (activeTab is granted for it right
//      now thanks to this popup click gesture).
//   2. Stashes the tabId in chrome.storage.local so the side panel can
//      pick it up when it loads.
//   3. Opens the side panel for that tab in the same user gesture — the
//      `chrome.sidePanel.open()` API requires a fresh gesture and losing
//      it will silently fail with a permission error.
document.getElementById('btn-recorder').addEventListener('click', async () => {
  const btn = document.getElementById('btn-recorder')
  btn.style.opacity = '0.5'
  btn.style.pointerEvents = 'none'

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!tab?.id) throw new Error('No active tab found')

    await chrome.storage.local.set({
      recorderTargetTabId: tab.id,
      recorderTargetTitle: tab.title || '',
      recorderTargetUrl: tab.url || '',
      recorderRequestedAt: Date.now(),
    })

    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'sidepanel.html',
      enabled: true,
    })
    await chrome.sidePanel.open({ tabId: tab.id })

    window.close()
  } catch (err) {
    alert('Failed: ' + err.message)
    btn.style.opacity = ''
    btn.style.pointerEvents = ''
  }
})

// Recordings - open in new tab
document.getElementById('btn-recordings').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('recordings.html') })
  window.close()
})

// Settings - open in new tab
document.getElementById('btn-settings').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') })
  window.close()
})
