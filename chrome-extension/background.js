// Orka Chrome Extension - Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log('Orka extension installed')
})

// Listen for messages from extension pages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getStreamId') {
    handleGetStreamId().then(sendResponse)
    return true
  }
  if (message.action === 'openRecorder') {
    handleOpenRecorder(message).then(sendResponse)
    return true
  }
})

// Get streamId while activeTab is still valid (called from popup menu)
async function handleGetStreamId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!tab?.id) {
      return { error: 'No active tab found' }
    }

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    })

    return { streamId, tabId: tab.id }
  } catch (err) {
    return { error: err.message }
  }
}

// Open recorder window (called from record-setup)
async function handleOpenRecorder({ mode, deviceId, tabId, streamId }) {
  try {
    const params = new URLSearchParams({
      mode: mode || 'tab',
      deviceId: deviceId || '',
      tabId: (tabId || 0).toString(),
      streamId: streamId || '',
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
