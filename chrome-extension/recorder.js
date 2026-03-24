// Recorder page - captures tab audio via MediaRecorder

const NUM_BARS = 5
let mediaRecorder = null
let chunks = []
let stream = null
let micStream = null
let audioContext = null
let analyser = null
let animationId = null
let startTime = 0

const stateEls = {
  starting: document.getElementById('state-starting'),
  recording: document.getElementById('state-recording'),
  stopped: document.getElementById('state-stopped'),
  error: document.getElementById('state-error'),
}
const durationEl = document.getElementById('duration')
const barsEl = document.querySelectorAll('.bar')
const errorMsg = document.getElementById('error-msg')

function showState(name) {
  Object.values(stateEls).forEach(el => el.classList.add('hidden'))
  stateEls[name].classList.remove('hidden')
}

function getParams() {
  const p = new URLSearchParams(window.location.search)
  return {
    mode: p.get('mode') || 'tab',
    deviceId: p.get('deviceId') || '',
    tabId: parseInt(p.get('tabId') || '0', 10),
    streamId: p.get('streamId') || '',
  }
}

// Audio visualization
function updateLevels() {
  if (!analyser) return
  const data = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(data)

  const step = Math.floor(data.length / NUM_BARS)
  for (let i = 0; i < NUM_BARS; i++) {
    let sum = 0
    for (let j = i * step; j < (i + 1) * step; j++) sum += data[j]
    const level = Math.min(1, (sum / step) / 180)
    barsEl[i].style.height = Math.max(4, level * 36) + 'px'
  }
  animationId = requestAnimationFrame(updateLevels)
}

function setupAnalyser(ctx, source) {
  analyser = ctx.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.7
  source.connect(analyser)
  updateLevels()
}

// Duration timer
let durationInterval = null
function startDurationTimer() {
  startTime = Date.now()
  durationInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - startTime) / 1000)
    durationEl.textContent = formatDuration(secs)
  }, 1000)
}

async function startRecording(params) {
  try {
    let finalStream

    if (params.mode === 'tab' || params.mode === 'both') {
      // Use the stream ID passed from background.js
      const tabStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: params.streamId,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: params.streamId,
          },
        },
      })

      // Stop video tracks - only need audio
      tabStream.getVideoTracks().forEach(t => t.stop())

      if (params.mode === 'both' && params.deviceId) {
        // Mix tab + mic
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: params.deviceId } },
        })

        audioContext = new AudioContext()
        const destination = audioContext.createMediaStreamDestination()
        const merger = audioContext.createGain()

        const tabSource = audioContext.createMediaStreamSource(tabStream)
        const micSource = audioContext.createMediaStreamSource(micStream)

        tabSource.connect(merger)
        micSource.connect(merger)
        merger.connect(destination)
        tabSource.connect(audioContext.destination)

        setupAnalyser(audioContext, merger)
        stream = tabStream
        finalStream = destination.stream
      } else {
        // Tab only
        audioContext = new AudioContext()
        const source = audioContext.createMediaStreamSource(tabStream)
        source.connect(audioContext.destination)
        setupAnalyser(audioContext, source)

        stream = tabStream
        finalStream = tabStream
      }
    } else {
      // Mic only
      finalStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: params.deviceId } },
      })
      audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(finalStream)
      setupAnalyser(audioContext, source)
      stream = finalStream
    }

    chunks = []
    mediaRecorder = new MediaRecorder(finalStream, {
      mimeType: 'audio/webm;codecs=opus',
    })

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    mediaRecorder.start(1000)
    startDurationTimer()
    showState('recording')
  } catch (err) {
    errorMsg.textContent = 'Error: ' + err.message
    showState('error')
  }
}

async function stopRecording() {
  // Stop animation
  if (animationId) { cancelAnimationFrame(animationId); animationId = null }
  analyser = null
  barsEl.forEach(b => b.style.height = '4px')

  // Stop timer
  if (durationInterval) { clearInterval(durationInterval); durationInterval = null }
  const duration = Math.floor((Date.now() - startTime) / 1000)

  // Stop MediaRecorder
  await new Promise((resolve) => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.onstop = () => resolve()
      mediaRecorder.stop()
    } else {
      resolve()
    }
  })

  // Stop all tracks
  if (stream) stream.getTracks().forEach(t => t.stop())
  if (micStream) micStream.getTracks().forEach(t => t.stop())
  if (audioContext) { audioContext.close(); audioContext = null }

  const blob = new Blob(chunks, { type: 'audio/webm' })
  const recordingName = generateRecordingName()

  if (blob.size === 0) {
    errorMsg.textContent = 'Recording is empty'
    showState('error')
    return
  }

  // Download file
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = recordingName + '.webm'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)

  // Save to IndexedDB
  try {
    await saveRecording(blob, duration, recordingName)
  } catch (err) {
    console.error('Failed to save to IndexedDB:', err)
  }

  setTimeout(() => URL.revokeObjectURL(url), 1000)
  showState('stopped')
}

// Event listeners
document.getElementById('btn-stop').addEventListener('click', stopRecording)
document.getElementById('btn-recordings').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('recordings.html') })
  window.close()
})

// Start on load
const params = getParams()
if (!params.streamId && !params.deviceId) {
  errorMsg.textContent = 'Missing recording parameters'
  showState('error')
} else {
  startRecording(params)
}
