const modeSelect = document.getElementById('capture-mode')
const micSection = document.getElementById('mic-section')
const micPermNeeded = document.getElementById('mic-permission-needed')
const micSelectGroup = document.getElementById('mic-select-group')
const micDevice = document.getElementById('mic-device')
const btnRequestMic = document.getElementById('btn-request-mic')
const btnStart = document.getElementById('btn-start')
const errorEl = document.getElementById('error')

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

    const result = await chrome.runtime.sendMessage({
      action: 'openRecorder',
      mode,
      deviceId,
      tabId,
      streamId,
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
