const modeSelect = document.getElementById('capture-mode')
const micSection = document.getElementById('mic-section')
const micPermNeeded = document.getElementById('mic-permission-needed')
const micSelectGroup = document.getElementById('mic-select-group')
const micDevice = document.getElementById('mic-device')
const btnRequestMic = document.getElementById('btn-request-mic')
const btnStart = document.getElementById('btn-start')
const errorEl = document.getElementById('error')
const liveEnabled = document.getElementById('live-enabled')
const liveLangRow = document.getElementById('live-lang-row')
const liveLangSelect = document.getElementById('live-language')

// Show / hide language row based on the live checkbox
liveEnabled.addEventListener('change', () => {
  liveLangRow.classList.toggle('hidden', !liveEnabled.checked)
})

// Get tabId and streamId from URL params (passed from menu.js)
const urlParams = new URLSearchParams(window.location.search)
const tabId = urlParams.get('tabId') || '0'
const streamId = urlParams.get('streamId') || ''

let micPermission = 'unknown'

// Mode change handler
modeSelect.addEventListener('change', () => {
  const mode = modeSelect.value
  const needsMic = mode === 'mic' || mode === 'both'

  micSection.classList.toggle('hidden', !needsMic)
  if (needsMic) {
    checkMicPermission()
  }
})

// Check mic permission and load devices
async function checkMicPermission() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const audioInputs = devices.filter(d => d.kind === 'audioinput')

    if (audioInputs.length > 0 && audioInputs[0].label) {
      micPermission = 'granted'
      micPermNeeded.classList.add('hidden')
      micSelectGroup.classList.remove('hidden')

      micDevice.innerHTML = ''
      audioInputs.forEach(d => {
        const opt = document.createElement('option')
        opt.value = d.deviceId
        opt.textContent = d.label || 'Microphone ' + d.deviceId.slice(0, 8)
        micDevice.appendChild(opt)
      })
    } else {
      micPermission = 'unknown'
      micPermNeeded.classList.remove('hidden')
      micSelectGroup.classList.add('hidden')
    }
  } catch {
    micPermission = 'unknown'
    micPermNeeded.classList.remove('hidden')
    micSelectGroup.classList.add('hidden')
  }
}

// Request mic permission
btnRequestMic.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach(t => t.stop())
    micPermission = 'granted'
    await checkMicPermission()
  } catch (err) {
    micPermission = 'denied'
    showError('Microphone permission denied. Check browser settings.')
  }
})

// Start recording - open recorder window via background
btnStart.addEventListener('click', async () => {
  const mode = modeSelect.value
  const needsMic = mode === 'mic' || mode === 'both'

  if (needsMic && micPermission !== 'granted') {
    showError('Microphone permission is required for this mode.')
    return
  }

  btnStart.disabled = true
  btnStart.textContent = 'Starting...'
  hideError()

  try {
    const deviceId = needsMic ? (micDevice.value || '') : ''

    const live = liveEnabled.checked
    const liveLanguage = live ? (liveLangSelect.value || 'auto') : ''
    const targetTabId = parseInt(tabId, 10) || 0

    // Refresh the tab-capture streamId at the moment of Start. The one
    // we received when the menu popup opened is often stale by now:
    // Chrome expires those in ~10 seconds and the user routinely spends
    // longer configuring the mode / mic. We re-request against the
    // ORIGINAL target tab (kept in the URL) so activeTab still applies.
    let freshStreamId = streamId
    try {
      const s = await chrome.runtime.sendMessage({
        action: 'getStreamId',
        targetTabId,
      })
      if (s?.error) throw new Error(s.error)
      freshStreamId = s.streamId || streamId
    } catch (err) {
      // Fall back to the initial streamId — it may still work if the
      // user was fast enough. The recorder will surface a clearer error
      // if it too fails.
      console.warn('[recorder] streamId refresh failed', err)
    }

    // Open the side panel FROM THIS PAGE (preserves the click gesture,
    // which sending through the SW does not reliably do). Do it before
    // openRecorder so the panel is ready to catch the very first
    // session_started event.
    if (live && targetTabId) {
      try {
        await chrome.sidePanel.setOptions({
          tabId: targetTabId,
          path: 'sidepanel.html',
          enabled: true,
        })
        await chrome.sidePanel.open({ tabId: targetTabId })
      } catch (err) {
        console.warn('[live] side panel open failed', err)
      }
    }

    const result = await chrome.runtime.sendMessage({
      action: 'openRecorder',
      mode,
      deviceId,
      tabId,
      streamId: freshStreamId,
      live,
      liveLanguage,
    })

    if (result?.error) {
      throw new Error(result.error)
    }

    // Close setup window - recorder window is now open
    window.close()
  } catch (err) {
    showError(err.message)
    btnStart.disabled = false
    btnStart.textContent = 'Start Recording'
  }
})

function showError(msg) {
  errorEl.textContent = msg
  errorEl.classList.remove('hidden')
}

function hideError() {
  errorEl.classList.add('hidden')
}
