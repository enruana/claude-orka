// Offscreen document — sole owner of the recording pipeline.
//
// Why offscreen: side panels and popup windows die the moment the user
// closes them. If the pipeline lives in those docs, the user closes the
// side panel → recording dies. Offscreen documents in MV3 persist as
// long as their justification is valid (USER_MEDIA here), so we can
// keep capturing audio even with no visible UI.
//
// Views (sidepanel, float) are read-only: they subscribe to broadcasts
// and send start/stop commands. State lives here.
//
// Message protocol
//   FROM view → offscreen:
//     { target:'offscreen', action:'start', params:{...} }
//     { target:'offscreen', action:'stop' }
//     { target:'offscreen', action:'query_state' }        → sendResponse
//   FROM offscreen → views (broadcast, fire-and-forget):
//     { target:'view', action:'state', state:{...} }
//     { target:'view', action:'delta', text, since, until }
//     { target:'view', action:'level', bars:[...] }
//     { target:'view', action:'log', text, level }
//     { target:'view', action:'error', message }
//     { target:'view', action:'saved', name, size, duration }

const state = {
  recording: false,
  audioContext: null,
  micStream: null,
  tabStream: null,
  mediaRecorder: null,
  mediaChunks: [],
  liveWS: null,
  liveWorklet: null,
  liveConnected: false,
  liveLanguage: 'auto',
  mode: 'tab',
  chunkMs: 1500,
  startedAt: 0,
  durationTimer: null,
  levelTimer: null,
  analyser: null,
  serverUrl: '',
  // Persisted transcript so a freshly-reopened view can catch up.
  transcriptChunks: [],
  fullTranscript: '',
  // Metadata of the last saved recording so a view that missed the
  // 'saved' broadcast (e.g. side panel was closed at Stop time) can
  // still display the confirmation card on its next open.
  lastSaved: null,
}

// ---------- Message handling ----------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return
  if (msg.action === 'start') {
    startCapture(msg.params).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ error: e.message })
    )
    return true
  }
  if (msg.action === 'stop') {
    stopCapture().then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ error: e.message })
    )
    return true
  }
  if (msg.action === 'query_state') {
    sendResponse({
      state: getPublicState(),
      transcriptChunks: state.transcriptChunks,
      lastSaved: state.lastSaved,
    })
    return
  }
})

function broadcast(payload) {
  try {
    chrome.runtime.sendMessage({ target: 'view', ...payload }).catch(() => {})
  } catch {}
}

function log(text, level) {
  broadcast({ action: 'log', text, level: level || 'info' })
  if (level === 'err') console.error('[offscreen]', text)
  else console.log('[offscreen]', text)
}

function getPublicState() {
  const dur = state.recording ? Math.floor((Date.now() - state.startedAt) / 1000) : 0
  return {
    recording: state.recording,
    connected: state.liveConnected,
    duration: dur,
    language: state.liveLanguage,
    mode: state.mode,
  }
}

function broadcastState() {
  broadcast({ action: 'state', state: getPublicState() })
}

// ---------- Capture start / stop ------------------------------------------

async function startCapture(params) {
  if (state.recording) {
    log('already recording, ignoring start')
    return
  }
  const { mode, deviceId, live, liveLanguage, tabStreamId, chunkMs, serverUrl } = params
  state.mode = mode
  state.liveLanguage = liveLanguage || 'auto'
  state.chunkMs = chunkMs || 1500
  state.serverUrl = (serverUrl || '').replace(/\/+$/, '')
  state.transcriptChunks = []
  state.fullTranscript = ''

  state.audioContext = new AudioContext()
  try { await state.audioContext.resume() } catch {}
  let liveSourceNode = null
  let finalStream = null

  if (mode === 'tab' || mode === 'both') {
    if (!tabStreamId) throw new Error('missing tabStreamId')
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: tabStreamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: tabStreamId,
        },
      },
    })
    tabStream.getVideoTracks().forEach((t) => t.stop())
    state.tabStream = tabStream

    if (mode === 'both' && deviceId) {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      })
      state.micStream = micStream
      const dest = state.audioContext.createMediaStreamDestination()
      const merger = state.audioContext.createGain()
      const tabSource = state.audioContext.createMediaStreamSource(tabStream)
      const micSource = state.audioContext.createMediaStreamSource(micStream)
      tabSource.connect(merger)
      micSource.connect(merger)
      merger.connect(dest)
      tabSource.connect(state.audioContext.destination)
      liveSourceNode = merger
      finalStream = dest.stream
    } else {
      const source = state.audioContext.createMediaStreamSource(tabStream)
      source.connect(state.audioContext.destination)
      liveSourceNode = source
      finalStream = tabStream
    }
  } else {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
    })
    state.micStream = micStream
    const source = state.audioContext.createMediaStreamSource(micStream)
    liveSourceNode = source
    finalStream = micStream
  }

  // Analyser for the audio level bars — tap the live source (post-mix
  // in the 'both' case) so the bars reflect what whisper will actually
  // hear.
  state.analyser = state.audioContext.createAnalyser()
  state.analyser.fftSize = 256
  state.analyser.smoothingTimeConstant = 0.7
  liveSourceNode.connect(state.analyser)
  startLevelLoop()

  // Persist the full session as an audio blob for the Recordings page.
  state.mediaChunks = []
  state.mediaRecorder = new MediaRecorder(finalStream, {
    mimeType: 'audio/webm;codecs=opus',
  })
  state.mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.mediaChunks.push(e.data)
  }
  state.mediaRecorder.start(1000)

  state.recording = true
  state.startedAt = Date.now()
  startDurationTimer()

  if (live) {
    setupLiveStream(state.audioContext, liveSourceNode).catch((err) => {
      log('live setup failed: ' + err.message, 'err')
    })
  }
  broadcastState()
  log('capture started (' + mode + ')', 'ok')
}

async function stopCapture() {
  if (!state.recording) return
  state.recording = false
  log('stopping capture')

  if (state.durationTimer) { clearInterval(state.durationTimer); state.durationTimer = null }
  if (state.levelTimer) { clearInterval(state.levelTimer); state.levelTimer = null }
  const duration = Math.floor((Date.now() - state.startedAt) / 1000)

  teardownLive()

  let blob = null
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    await new Promise((resolve) => {
      state.mediaRecorder.onstop = () => resolve()
      state.mediaRecorder.stop()
    })
    blob = new Blob(state.mediaChunks, { type: 'audio/webm' })
  }

  await teardownCapture()

  if (blob && blob.size > 0) {
    try {
      const name = generateRecordingName()
      await saveRecording(blob, duration, name)
      log('recording saved: ' + name + '.webm (' + duration + 's, ' + blob.size + ' bytes)', 'ok')
      state.lastSaved = { name, size: blob.size, duration, savedAt: Date.now() }
      broadcast({ action: 'saved', name, size: blob.size, duration })
    } catch (err) {
      log('IndexedDB save failed: ' + err.message, 'err')
      broadcast({ action: 'save_error', message: err.message })
    }
  } else {
    log('nothing to save (empty blob)', 'err')
  }

  broadcastState()
}

async function teardownCapture() {
  try { if (state.tabStream) state.tabStream.getTracks().forEach((t) => t.stop()) } catch {}
  try { if (state.micStream) state.micStream.getTracks().forEach((t) => t.stop()) } catch {}
  try { if (state.audioContext) await state.audioContext.close() } catch {}
  state.tabStream = null
  state.micStream = null
  state.audioContext = null
  state.mediaRecorder = null
  state.mediaChunks = []
  state.analyser = null
}

function startDurationTimer() {
  state.durationTimer = setInterval(() => {
    broadcastState()
  }, 500)
}

// ---------- Level loop (audio bars) ---------------------------------------

function startLevelLoop() {
  const freq = new Uint8Array(state.analyser.frequencyBinCount)
  const NUM_BARS = 6
  const step = Math.floor(freq.length / NUM_BARS)
  state.levelTimer = setInterval(() => {
    if (!state.analyser) return
    state.analyser.getByteFrequencyData(freq)
    const bars = []
    for (let i = 0; i < NUM_BARS; i++) {
      let sum = 0
      for (let j = i * step; j < (i + 1) * step; j++) sum += freq[j]
      // 180 is a reasonable ceiling for speech — anything above the
      // typical dynamic range will just clip to full bar height.
      bars.push(Math.min(1, (sum / step) / 180))
    }
    broadcast({ action: 'level', bars })
  }, 60)
}

// ---------- Live WebSocket ------------------------------------------------

async function setupLiveStream(ctx, sourceNode) {
  const SERVER = state.serverUrl
  const wsUrl = SERVER.replace(/^http/i, 'ws') +
    `/api/transcribe/live?language=${encodeURIComponent(state.liveLanguage)}&chunkMs=${state.chunkMs}`
  log('live WS → ' + wsUrl)

  // Same-origin preflight — a friendly failure surfaces cert issues
  // BEFORE we've opened the WebSocket (WS errors are opaque to JS).
  try {
    const r = await fetch(`${SERVER}/api/transcribe/status`)
    if (!r.ok) throw new Error('HTTP ' + r.status)
  } catch (err) {
    throw new Error('preflight failed (' + err.message + ')')
  }

  await ctx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'))
  state.liveWorklet = new AudioWorkletNode(ctx, 'pcm16-downsampler', {
    processorOptions: { targetRate: 16000, frameSize: 3200 },
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
  })
  sourceNode.connect(state.liveWorklet)

  const pendingFrames = []
  state.liveWS = new WebSocket(wsUrl)
  state.liveWS.binaryType = 'arraybuffer'

  state.liveWS.addEventListener('open', () => {
    state.liveConnected = true
    broadcastState()
    while (pendingFrames.length > 0) {
      try { state.liveWS.send(pendingFrames.shift()) } catch {}
    }
    log('WS connected', 'ok')
  })
  state.liveWS.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.type === 'ready') {
      log('WS ready session=' + msg.sessionId + ' chunkMs=' + msg.chunkMs)
    } else if (msg.type === 'transcript') {
      appendChunk(msg.text, msg.since, msg.until, msg.driftMs, msg.inferMs)
    } else if (msg.type === 'error') {
      log('WS server-error: ' + msg.message, 'err')
    }
  })
  state.liveWS.addEventListener('close', (ev) => {
    state.liveConnected = false
    broadcastState()
    log('WS closed code=' + ev.code + ' reason=' + (ev.reason || '—'))
    if (ev.code === 1006) {
      log('  ↳ 1006 hint: WSS host does not match server cert. Point Server URL at the exact hostname the cert is for.', 'err')
    }
  })
  state.liveWS.addEventListener('error', () => {
    state.liveConnected = false
    broadcastState()
    log('WS transport error', 'err')
  })

  state.liveWorklet.port.onmessage = (ev) => {
    const buf = ev.data
    if (state.liveConnected && state.liveWS && state.liveWS.readyState === WebSocket.OPEN) {
      try { state.liveWS.send(buf) } catch {}
    } else if (pendingFrames.length < 200) {
      pendingFrames.push(buf)
    }
  }
}

function teardownLive() {
  if (state.liveWorklet) {
    try { state.liveWorklet.port.onmessage = null } catch {}
    try { state.liveWorklet.disconnect() } catch {}
    state.liveWorklet = null
  }
  if (state.liveWS) {
    try {
      if (state.liveWS.readyState === WebSocket.OPEN) {
        state.liveWS.send(JSON.stringify({ type: 'flush' }))
        state.liveWS.close(1000, 'recording stopped')
      }
    } catch {}
    state.liveWS = null
  }
  state.liveConnected = false
}

function appendChunk(text, since, until, driftMs, inferMs) {
  if (!text) return
  const chunk = { text, since, until, ts: Date.now() }
  state.transcriptChunks.push(chunk)
  state.fullTranscript += (state.fullTranscript ? ' ' : '') + text
  broadcast({ action: 'delta', text, since, until, driftMs, inferMs })
}

log('offscreen document ready')
