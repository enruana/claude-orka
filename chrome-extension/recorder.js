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

// Live-transcription state. Only populated when params.live === '1'.
// We keep the AudioWorklet + WS as an independent branch off the same
// captured stream so it can be torn down without touching MediaRecorder.
let liveWorkletNode = null
let liveWS = null
let liveConnected = false
let liveLanguage = 'auto'
let liveSessionId = null

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
    live: p.get('live') === '1',
    liveLanguage: p.get('liveLanguage') || 'auto',
  }
}

// -----------------------------------------------------------------------------
// Live transcription pipeline
//
// When the user opts in from the record-setup page, we pipe the same source
// stream that MediaRecorder is consuming through an AudioWorklet that emits
// PCM16 16kHz mono chunks. Those chunks stream over a WebSocket to the Orka
// server (`/api/transcribe/live`) which returns transcript deltas, which we
// then re-broadcast via the SW so the sidepanel can render them without
// having to know about the recorder window.
// -----------------------------------------------------------------------------

function broadcastLiveEvent(payload) {
  try {
    chrome.runtime.sendMessage({ action: 'liveEvent', payload }).catch(() => {})
  } catch {
    // SW may have been torn down; ignore.
  }
}

async function setupLive(ctx, sourceForLive, language) {
  liveLanguage = language || 'auto'
  const SERVER = await getServerUrl()
  // Convert http(s) → ws(s) so the WS transport matches the server scheme.
  // The transcribe-live endpoint is served by the same host/port as the
  // rest of the API.
  const wsUrl = SERVER.replace(/^http/i, 'ws') +
    `/api/transcribe/live?language=${encodeURIComponent(liveLanguage)}`

  // Load the worklet before wiring it. The relative path resolves against
  // chrome-extension://<id>/pcm-worklet.js — Chrome resolves worklet modules
  // relative to the current document.
  try {
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'))
  } catch (err) {
    console.error('[live] failed to load audio worklet', err)
    broadcastLiveEvent({ type: 'error', message: 'Failed to load audio worklet: ' + err.message })
    return
  }

  liveWorkletNode = new AudioWorkletNode(ctx, 'pcm16-downsampler', {
    processorOptions: { targetRate: 16000, frameSize: 3200 },
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
  })
  sourceForLive.connect(liveWorkletNode)

  // Open the WebSocket. Buffer any early PCM frames so we don't drop the
  // first ~100ms while the handshake completes.
  const pendingFrames = []
  try {
    liveWS = new WebSocket(wsUrl)
    liveWS.binaryType = 'arraybuffer'
  } catch (err) {
    console.error('[live] WS construction failed', err)
    broadcastLiveEvent({ type: 'error', message: 'Live WS failed: ' + err.message })
    return
  }

  liveWS.addEventListener('open', () => {
    liveConnected = true
    // Flush any buffered PCM frames captured before the socket opened.
    while (pendingFrames.length > 0) {
      const f = pendingFrames.shift()
      try { liveWS.send(f) } catch {}
    }
    broadcastLiveEvent({ type: 'session_started', language: liveLanguage })
  })

  liveWS.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'ready') {
        liveSessionId = msg.sessionId || null
      } else if (msg.type === 'transcript') {
        broadcastLiveEvent({
          type: 'transcript_delta',
          text: msg.text,
          since: msg.since,
          until: msg.until,
        })
      } else if (msg.type === 'error') {
        broadcastLiveEvent({ type: 'error', message: msg.message })
      }
    } catch (err) {
      console.warn('[live] non-JSON message', ev.data)
    }
  })

  liveWS.addEventListener('close', () => {
    liveConnected = false
    broadcastLiveEvent({ type: 'session_ended' })
  })

  liveWS.addEventListener('error', (err) => {
    liveConnected = false
    console.warn('[live] WS error', err)
    broadcastLiveEvent({ type: 'error', message: 'Live WS error' })
  })

  // Ship each PCM frame from the worklet straight into the socket.
  liveWorkletNode.port.onmessage = (ev) => {
    const buf = ev.data // ArrayBuffer of Int16Array samples
    if (liveConnected && liveWS && liveWS.readyState === WebSocket.OPEN) {
      try { liveWS.send(buf) } catch {}
    } else {
      // Buffer for the first ~200 frames (< 1MB) before the WS opens.
      if (pendingFrames.length < 200) pendingFrames.push(buf)
    }
  }
}

function teardownLive() {
  if (liveWorkletNode) {
    try { liveWorkletNode.port.onmessage = null } catch {}
    try { liveWorkletNode.disconnect() } catch {}
    liveWorkletNode = null
  }
  if (liveWS) {
    try {
      if (liveWS.readyState === WebSocket.OPEN) {
        liveWS.send(JSON.stringify({ type: 'flush' }))
        liveWS.close(1000, 'recording stopped')
      }
    } catch {}
    liveWS = null
  }
  liveConnected = false
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
    // Node the live pipeline should tap. We set this in every branch to
    // whatever "mixed everything" node most represents what the user
    // wants transcribed (tab+mic when both, tab-only when tab, mic-only
    // when mic).
    let liveSourceNode = null

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
        liveSourceNode = merger
      } else {
        // Tab only
        audioContext = new AudioContext()
        const source = audioContext.createMediaStreamSource(tabStream)
        source.connect(audioContext.destination)
        setupAnalyser(audioContext, source)

        stream = tabStream
        finalStream = tabStream
        liveSourceNode = source
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
      liveSourceNode = source
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

    // Kick off the live-transcription pipeline off the same audio graph.
    // Failures here don't cancel the recording — we surface an error
    // event but let MediaRecorder keep going.
    if (params.live && liveSourceNode && audioContext) {
      setupLive(audioContext, liveSourceNode, params.liveLanguage).catch((err) => {
        console.error('[live] setup failed', err)
        broadcastLiveEvent({ type: 'error', message: 'Live setup failed: ' + err.message })
      })
    }
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

  // Flush + tear down the live pipeline before we close MediaRecorder
  // so any pending PCM makes it out.
  teardownLive()

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
