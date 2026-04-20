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

// Recorder - get streamId NOW (while popup is open and activeTab is valid),
// then open setup window with the streamId already secured
document.getElementById('btn-recorder').addEventListener('click', async () => {
  const btn = document.getElementById('btn-recorder')
  btn.style.opacity = '0.5'
  btn.style.pointerEvents = 'none'

  try {
    // Get streamId from background while activeTab is still valid
    const result = await chrome.runtime.sendMessage({ action: 'getStreamId' })

    if (result?.error) {
      alert(result.error)
      return
    }

    const params = new URLSearchParams({
      tabId: result.tabId.toString(),
      streamId: result.streamId,
    })

    chrome.windows.create({
      url: chrome.runtime.getURL('record-setup.html?' + params.toString()),
      type: 'popup',
      width: 340,
      height: 420,
      focused: true,
    })
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
