;(async () => {
  const SERVER = await getServerUrl()
  const dot = document.getElementById('status-dot')
  const versionBadge = document.getElementById('menu-version')
  const extVersion = chrome.runtime.getManifest().version
  try {
    const res = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(3000) })
    dot.className = 'status-dot ' + (res.ok ? 'online' : 'offline')
    if (res.ok && versionBadge) {
      const body = await res.json().catch(() => null)
      const serverVersion = body && typeof body.version === 'string' ? body.version : null
      if (serverVersion) {
        const cmp = cmpSemverStr(extVersion, serverVersion)
        versionBadge.textContent = cmp === 0
          ? `v${extVersion}`
          : cmp < 0
            ? `v${extVersion} → v${serverVersion}`
            : `v${extVersion}`
        versionBadge.classList.remove('hidden', 'synced', 'outdated')
        versionBadge.classList.add(cmp === 0 ? 'synced' : cmp < 0 ? 'outdated' : 'synced')
        versionBadge.title = cmp < 0
          ? `Server is on v${serverVersion}. Open Settings to update.`
          : `Extension v${extVersion} matches the server.`
      }
    }
  } catch {
    dot.className = 'status-dot offline'
    if (versionBadge) {
      versionBadge.textContent = `v${extVersion}`
      versionBadge.classList.remove('hidden')
    }
  }
})()

function cmpSemverStr(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

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
