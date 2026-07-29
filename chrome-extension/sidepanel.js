// Orka side panel — VIEW ONLY. All recording state (AudioContext,
// MediaRecorder, WebSocket, worklet) lives in the offscreen document
// (offscreen.js) so it survives users closing the side panel with X.
// This file just gathers setup params, dispatches start/stop to
// offscreen, and renders whatever state / delta / level messages come
// back on chrome.runtime.onMessage.

// ---------- DOM refs --------------------------------------------------------

const els = {
  statusDot: document.getElementById('status-dot'),
  langTag: document.getElementById('lang-tag'),
  btnCollapse: document.getElementById('btn-collapse'),
  btnExpand: document.getElementById('btn-expand'),
  // rail
  railDot: document.getElementById('rail-dot'),
  railDuration: document.getElementById('rail-duration'),
  btnStopRail: document.getElementById('btn-stop-rail'),
  // server URL
  serverUrlDisplay: document.getElementById('server-url-display'),
  btnServerEdit: document.getElementById('btn-server-edit'),
  serverEditBlock: document.getElementById('server-edit-block'),
  serverUrlInput: document.getElementById('server-url-input'),
  btnServerSave: document.getElementById('btn-server-save'),
  serverStatus: document.getElementById('server-status'),
  // setup
  setupView: document.getElementById('setup-view'),
  targetTitle: document.getElementById('target-title'),
  modeSel: document.getElementById('mode'),
  micPermBlock: document.getElementById('mic-permission-block'),
  micDeviceBlock: document.getElementById('mic-device-block'),
  micDevice: document.getElementById('mic-device'),
  btnReqMic: document.getElementById('btn-req-mic'),
  liveEnabled: document.getElementById('live-enabled'),
  liveLangBlock: document.getElementById('live-lang-block'),
  liveLanguage: document.getElementById('live-language'),
  btnStart: document.getElementById('btn-start'),
  setupError: document.getElementById('setup-error'),
  // recording
  recordingView: document.getElementById('recording-view'),
  btnStop: document.getElementById('btn-stop'),
  btnNewSession: document.getElementById('btn-new-session'),
  savedCard: document.getElementById('saved-card'),
  savedName: document.getElementById('saved-name'),
  savedMeta: document.getElementById('saved-meta'),
  btnOpenRecordings: document.getElementById('btn-open-recordings'),
  btnCopyKb: document.getElementById('btn-copy-kb'),
  btnEditKbPrompt: document.getElementById('btn-edit-kb-prompt'),
  kbModal: document.getElementById('kb-prompt-modal'),
  kbModalClose: document.getElementById('kb-prompt-close'),
  kbModalCancel: document.getElementById('kb-prompt-cancel'),
  kbModalSave: document.getElementById('kb-prompt-save'),
  kbModalReset: document.getElementById('kb-prompt-reset'),
  kbModalTextarea: document.getElementById('kb-prompt-textarea'),
  recDot: document.getElementById('rec-dot'),
  duration: document.getElementById('duration'),
  audioBars: document.getElementById('audio-bars'),
  driftBadge: document.getElementById('drift-badge'),
  liveEmpty: document.getElementById('live-empty'),
  liveTranscript: document.getElementById('live-transcript'),
  topicEmpty: document.getElementById('topic-empty'),
  topicEmptyMsg: document.getElementById('topic-empty-msg'),
  topicEmptyCta: document.getElementById('topic-empty-cta'),
  topicStatus: document.getElementById('topic-status'),
  topicList: document.getElementById('topic-list'),
  // extras
  cloudToggle: document.getElementById('cloud-optin-toggle'),
  runLog: document.getElementById('run-log'),
}

// ---------- Local view state -----------------------------------------------

const view = {
  targetTabId: null,
  targetTitle: '',
  micPermission: 'unknown',
  cloudOptIn: false,
  liveLanguage: 'auto',
  // Copy of what offscreen has told us
  recording: false,
  connected: false,
  duration: 0,
  // Local copies of transcript & topic data — offscreen owns the
  // authoritative version but for the topic tab we keep enough state
  // here to make the periodic topic-stream call.
  transcriptChunks: [],
  // Segmentation returned by the last topic-stream call, ordered
  // chronologically (earliest first). Replaced wholesale on every
  // response — Claude re-segments from scratch each poll so the
  // client doesn't need to reconcile.
  topics: [],
  lastTopicRequestAt: 0,
}

const NUM_BARS = 6
const TOPIC_INTERVAL_MS = 20000
const TOPIC_MIN_CHARS = 240

// Pre-create bar elements once
for (let i = 0; i < NUM_BARS; i++) {
  const b = document.createElement('span')
  b.className = 'sp-bar'
  b.style.height = '2px'
  els.audioBars.appendChild(b)
}

// ---------- Helpers --------------------------------------------------------

function logView(text, level) {
  const line = document.createElement('div')
  if (level === 'err') line.className = 'log-err'
  else if (level === 'ok') line.className = 'log-ok'
  const ts = new Date().toTimeString().slice(0, 8)
  line.textContent = `[${ts}] ${text}`
  els.runLog.appendChild(line)
  els.runLog.hidden = false
  els.runLog.scrollTop = els.runLog.scrollHeight
  if (level === 'err') console.error('[sp]', text)
  else console.log('[sp]', text)
}

function fmtDuration(secs) {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function setStatus(kind) {
  els.statusDot.classList.remove('connected', 'error', 'recording')
  els.railDot.classList.remove('connected', 'error', 'recording')
  if (kind === 'connected') { els.statusDot.classList.add('connected'); els.railDot.classList.add('connected') }
  else if (kind === 'error') { els.statusDot.classList.add('error'); els.railDot.classList.add('error') }
  else if (kind === 'recording') { els.statusDot.classList.add('recording'); els.railDot.classList.add('recording') }
  els.statusDot.title = kind
}

function showSetupError(msg) { els.setupError.textContent = msg; els.setupError.classList.remove('hidden') }
function clearSetupError() { els.setupError.classList.add('hidden') }

function showRecordingView() {
  els.setupView.classList.add('hidden')
  els.recordingView.classList.remove('hidden')
  document.body.classList.remove('sp-mode-setup')
  document.body.classList.add('sp-mode-recording')
  els.btnStopRail.hidden = false
}
function showSetupView() {
  els.recordingView.classList.add('hidden')
  els.setupView.classList.remove('hidden')
  document.body.classList.remove('sp-mode-recording')
  document.body.classList.add('sp-mode-setup')
  els.btnStart.disabled = false
  els.btnStart.textContent = 'Start recording'
  els.btnStopRail.hidden = true
}

// ---------- Init -----------------------------------------------------------

;(async function init() {
  try {
    const stored = await chrome.storage.local.get([
      'recorderTargetTabId', 'recorderTargetTitle',
      'cloudOptIn', 'serverUrl',
    ])
    view.targetTabId = stored.recorderTargetTabId || null
    view.targetTitle = stored.recorderTargetTitle || '(unknown tab)'
    view.cloudOptIn = !!stored.cloudOptIn
    els.cloudToggle.checked = view.cloudOptIn
    els.targetTitle.textContent = view.targetTitle
    els.serverUrlDisplay.textContent = stored.serverUrl || 'https://localhost:3456'
    if (!view.targetTabId) {
      showSetupError('No capture target set. Click the Orka icon again while on the tab you want to record.')
    }
    await checkMicPermission()
    updateEmptyMessages()
    await runServerHealthCheck({ silent: false })

    // Ask offscreen (if it exists) for current state. If a recording is
    // already going (user reopened the panel after closing it), catch up.
    try {
      const r = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'query_state' })
      if (r && r.state) {
        applyStateUpdate(r.state)
        if (r.transcriptChunks && r.transcriptChunks.length > 0) {
          els.liveEmpty.classList.add('hidden')
          r.transcriptChunks.forEach((c) => renderChunk(c.text, c.since, c.until, false))
          view.transcriptChunks = r.transcriptChunks.slice()
        }
        if (r.state.recording) {
          showRecordingView()
          logView('resumed existing recording session', 'ok')
        } else if (r.transcriptChunks && r.transcriptChunks.length > 0) {
          // Recording ended while the panel was closed — show the
          // review view so the user can re-read the transcript without
          // clicking Start.
          showRecordingView()
          enterReviewMode()
          logView('showing prior session (recording ended while panel closed)', 'ok')
          if (r.lastSaved) {
            showSavedCard(r.lastSaved.name, r.lastSaved.duration, r.lastSaved.size)
          }
        }
      }
    } catch {
      // no offscreen doc — that's fine, will get created on Start.
    }
  } catch (err) {
    logView('init failed: ' + err.message, 'err')
  }
})()

// ---------- Server URL: edit + health --------------------------------------

els.btnServerEdit.addEventListener('click', async () => {
  const cur = await getServerUrl()
  els.serverUrlInput.value = cur
  els.serverEditBlock.classList.toggle('hidden')
})

els.btnServerSave.addEventListener('click', async () => {
  let v = (els.serverUrlInput.value || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(v)) {
    els.serverStatus.textContent = 'URL must start with http:// or https://'
    els.serverStatus.className = 'sp-server-status err'
    return
  }
  try {
    await setServerUrl(v)
    els.serverUrlDisplay.textContent = v
    els.serverEditBlock.classList.add('hidden')
    logView('server URL saved: ' + v, 'ok')
    await runServerHealthCheck({ silent: false })
  } catch (err) {
    els.serverStatus.textContent = 'save failed: ' + err.message
    els.serverStatus.className = 'sp-server-status err'
  }
})

async function runServerHealthCheck({ silent } = {}) {
  const url = await getServerUrl()
  els.serverStatus.textContent = 'checking…'
  els.serverStatus.className = 'sp-server-status'
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    const r = await fetch(`${url}/api/health`, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const st = await fetch(`${url}/api/transcribe/status`, { signal: ctrl.signal }).then((r) => r.json()).catch(() => null)
    if (st && st.available === false) {
      els.serverStatus.textContent = 'server ok, whisper NOT ready: ' + (st.message || '')
      els.serverStatus.className = 'sp-server-status err'
      if (!silent) logView('whisper not ready', 'err')
    } else {
      els.serverStatus.textContent = 'reachable · whisper ' + (st?.model || 'ok')
      els.serverStatus.className = 'sp-server-status ok'
      if (!silent) logView('server ok', 'ok')
    }
  } catch (err) {
    els.serverStatus.textContent = 'unreachable: ' + err.message + ' — edit the URL above'
    els.serverStatus.className = 'sp-server-status err'
    if (!silent) logView('server health failed: ' + err.message, 'err')
  }
}

// ---------- Setup UI wiring ------------------------------------------------

els.modeSel.addEventListener('change', () => {
  const needsMic = els.modeSel.value === 'mic' || els.modeSel.value === 'both'
  els.micPermBlock.classList.toggle('hidden', !needsMic || view.micPermission === 'granted')
  els.micDeviceBlock.classList.toggle('hidden', !needsMic || view.micPermission !== 'granted')
})
els.liveEnabled.addEventListener('change', () => {
  els.liveLangBlock.classList.toggle('hidden', !els.liveEnabled.checked)
})
els.liveLangBlock.classList.toggle('hidden', !els.liveEnabled.checked)

els.btnReqMic.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((t) => t.stop())
    view.micPermission = 'granted'
    await checkMicPermission()
  } catch (err) {
    view.micPermission = 'denied'
    showSetupError('Microphone access denied. Check chrome://settings/content/microphone.')
  }
})

async function checkMicPermission() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const audioIn = devices.filter((d) => d.kind === 'audioinput')
    if (audioIn.length > 0 && audioIn[0].label) {
      view.micPermission = 'granted'
      els.micPermBlock.classList.add('hidden')
      const needsMic = els.modeSel.value === 'mic' || els.modeSel.value === 'both'
      els.micDeviceBlock.classList.toggle('hidden', !needsMic)
      els.micDevice.innerHTML = ''
      audioIn.forEach((d) => {
        const o = document.createElement('option')
        o.value = d.deviceId
        o.textContent = d.label || 'Mic ' + d.deviceId.slice(0, 6)
        els.micDevice.appendChild(o)
      })
    } else {
      view.micPermission = 'unknown'
      const needsMic = els.modeSel.value === 'mic' || els.modeSel.value === 'both'
      els.micPermBlock.classList.toggle('hidden', !needsMic)
      els.micDeviceBlock.classList.add('hidden')
    }
  } catch (err) {
    logView('mic perm check failed: ' + err.message, 'err')
  }
}

// ---------- Start / Stop → offscreen ---------------------------------------

els.btnStart.addEventListener('click', async () => {
  clearSetupError()
  const mode = els.modeSel.value
  const needsMic = mode === 'mic' || mode === 'both'
  if (needsMic && view.micPermission !== 'granted') {
    showSetupError('Microphone permission required for this mode.')
    return
  }
  if ((mode === 'tab' || mode === 'both') && !view.targetTabId) {
    showSetupError('No capture target. Close and re-open from the Orka icon.')
    return
  }

  els.btnStart.disabled = true
  els.btnStart.textContent = 'Starting…'
  view.liveLanguage = els.liveLanguage.value || 'auto'

  try {
    // 1. Ensure the offscreen doc exists before we start yelling at it.
    const ensure = await chrome.runtime.sendMessage({ action: 'ensureOffscreen' })
    if (ensure?.error) throw new Error('offscreen: ' + ensure.error)

    // 2. Grab a fresh tab streamId (only relevant for tab / both modes).
    let tabStreamId = null
    if (mode === 'tab' || mode === 'both') {
      const s = await chrome.runtime.sendMessage({
        action: 'getStreamId',
        targetTabId: view.targetTabId,
      })
      if (s?.error) throw new Error('tabCapture: ' + s.error)
      tabStreamId = s.streamId
    }

    const serverUrl = await getServerUrl()

    // 3. Tell offscreen to start. This is a request/response — if it
    // throws we still show the setup view.
    const resp = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start',
      params: {
        mode,
        deviceId: needsMic ? els.micDevice.value : '',
        live: els.liveEnabled.checked,
        liveLanguage: view.liveLanguage,
        tabStreamId,
        chunkMs: 1500,
        serverUrl,
      },
    })
    if (resp?.error) throw new Error(resp.error)

    showRecordingView()
    logView('capture started', 'ok')
  } catch (err) {
    logView('start failed: ' + err.message, 'err')
    showSetupError(err.message)
    els.btnStart.disabled = false
    els.btnStart.textContent = 'Start recording'
  }
})

async function requestStop() {
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' })
  } catch (err) {
    logView('stop failed: ' + err.message, 'err')
  }
}
els.btnStop.addEventListener('click', requestStop)
els.btnStopRail.addEventListener('click', requestStop)
els.btnNewSession.addEventListener('click', exitReviewToSetup)

els.btnOpenRecordings.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('recordings.html') })
})

// ---------- Broadcast handling (from offscreen) ----------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'view') return
  if (msg.action === 'state') applyStateUpdate(msg.state)
  else if (msg.action === 'delta') {
    renderChunk(msg.text, msg.since, msg.until, true)
    if (typeof msg.driftMs === 'number') updateDrift(msg.driftMs)
    maybeRequestTopic()
  }
  else if (msg.action === 'level') renderBars(msg.bars)
  else if (msg.action === 'log') logView(msg.text, msg.level)
  else if (msg.action === 'error') { logView('offscreen error: ' + msg.message, 'err'); setStatus('error') }
  else if (msg.action === 'saved') {
    logView('recording saved: ' + msg.name + ' (' + msg.duration + 's, ' + msg.size + ' bytes)', 'ok')
    showSavedCard(msg.name, msg.duration, msg.size)
  }
  else if (msg.action === 'save_error') {
    logView('save failed: ' + msg.message, 'err')
  }
})

function applyStateUpdate(st) {
  const wasRecording = view.recording
  view.recording = !!st.recording
  view.connected = !!st.connected
  view.duration = st.duration || 0
  view.liveLanguage = st.language || view.liveLanguage
  els.duration.textContent = fmtDuration(view.duration)
  els.railDuration.textContent = fmtDuration(view.duration)
  if (view.recording && view.connected) setStatus('connected')
  else if (view.recording) setStatus('recording')
  else setStatus('idle')
  if (view.connected) {
    els.langTag.hidden = false
    els.langTag.textContent = view.liveLanguage
  }
  if (wasRecording && !view.recording) {
    // Recording just ended (natural stop OR user hit stop). Enter review
    // mode: keep the transcript, current topic and history visible, but
    // swap the record-bar controls so the user can either start a fresh
    // session or just re-read.
    enterReviewMode()
  }
}

function enterReviewMode() {
  view.reviewMode = true
  els.recDot.classList.remove('recording')
  els.btnStop.classList.add('hidden')
  els.btnNewSession.classList.remove('hidden')
  // Reset the bars to a flat line — nothing is being recorded now.
  els.audioBars.querySelectorAll('.sp-bar').forEach((el) => { el.style.height = '2px' })
}

function showSavedCard(name, duration, size) {
  els.savedCard.classList.remove('hidden')
  els.savedName.textContent = name + '.webm'
  const mb = (size / (1024 * 1024)).toFixed(2)
  els.savedMeta.textContent = `Duration ${fmtDuration(duration)} · Size ${mb} MB · Saved in Orka Recordings (IndexedDB)`
  // Remember what we have so the "Copy for KB" button can build a
  // payload with real metadata (name, duration) not just the transcript.
  view.lastSavedName = name
  view.lastSavedDuration = duration
  view.lastSavedSize = size
}

function hideSavedCard() {
  els.savedCard.classList.add('hidden')
  els.savedName.textContent = '—'
  els.savedMeta.textContent = '—'
  view.lastSavedName = null
  view.lastSavedDuration = null
  view.lastSavedSize = null
}

function exitReviewToSetup() {
  view.reviewMode = false
  els.btnStop.classList.remove('hidden')
  els.btnNewSession.classList.add('hidden')
  els.recDot.classList.add('recording')
  hideSavedCard()
  // Clear session state so the next recording starts fresh.
  view.transcriptChunks = []
  view.fullTranscript = ''
  view.topics = []
  view.lastTopicRequestAt = 0
  view.topicLastError = null
  els.liveTranscript.innerHTML = ''
  els.liveEmpty.classList.remove('hidden')
  els.langTag.hidden = true
  els.duration.textContent = '00:00'
  els.railDuration.textContent = '00:00'
  renderTopics()
  showSetupView()
}

function renderBars(bars) {
  const spans = els.audioBars.querySelectorAll('.sp-bar')
  spans.forEach((el, i) => {
    const v = bars[i] || 0
    el.style.height = Math.max(2, Math.round(v * 20)) + 'px'
  })
}

/**
 * Update the "how far behind is the transcript" badge. Colors:
 *   green (≤2s)  — feels live, no visible lag
 *   amber (≤6s)  — noticeable but not painful
 *   red (>6s)    — falling behind, whisper can't keep up
 * The value is the audio buffered on the server minus what's been
 * transcribed. It naturally shrinks between chunks and grows when
 * inference is slow.
 */
function updateDrift(driftMs) {
  const badge = els.driftBadge
  if (!badge) return
  badge.classList.remove('ok', 'warn', 'err')
  if (driftMs <= 2000) {
    badge.classList.add('ok')
    badge.textContent = 'Live'
  } else if (driftMs <= 6000) {
    badge.classList.add('warn')
    badge.textContent = (driftMs / 1000).toFixed(1) + 's behind'
  } else {
    badge.classList.add('err')
    badge.textContent = (driftMs / 1000).toFixed(1) + 's behind'
  }
}

function renderChunk(text, since, until, fresh) {
  if (!text) return
  if (fresh) {
    view.transcriptChunks.push({ text, since, until, ts: Date.now() })
  }
  els.liveEmpty.classList.add('hidden')
  // The actual scroll container is the panel (.sp-panel), not the
  // transcript div inside it. Note whether the user is currently near
  // the bottom BEFORE appending — that way we only auto-scroll when
  // they're following live, and don't jerk them away when they've
  // scrolled up to re-read.
  const panel = document.getElementById('tab-live')
  const wasNearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 120

  const span = document.createElement('span')
  span.className = 'chunk' + (fresh ? ' fresh' : '')
  span.textContent = text + ' '
  els.liveTranscript.appendChild(span)
  if (fresh) setTimeout(() => span.classList.remove('fresh'), 3000)
  if (wasNearBottom) panel.scrollTop = panel.scrollHeight
}

// ---------- Topic segmentation (cloud opt-in) ------------------------------
//
// Each poll asks Claude to segment the FULL running transcript into a
// list of coherent topic cards, ordered chronologically. We replace the
// local `view.topics` wholesale with the model's answer — no local
// reconciliation, no history bucket. The list gets rendered in the
// Topics tab with the newest topic pinned to the top.

async function maybeRequestTopic() {
  if (!view.cloudOptIn) return
  if (view.topicRequestInFlight) return
  const now = Date.now()
  if (now - view.lastTopicRequestAt < TOPIC_INTERVAL_MS) return
  const fullTranscript = view.transcriptChunks.map((c) => c.text).join(' ').trim()
  if (fullTranscript.length < TOPIC_MIN_CHARS) return
  view.lastTopicRequestAt = now
  view.topicRequestInFlight = true
  view.topicLastError = null
  updateTopicStatus()

  const SERVER = await getServerUrl()
  try {
    const resp = await fetch(`${SERVER}/api/ai/topic-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: fullTranscript,
        language: view.liveLanguage === 'auto' ? undefined : view.liveLanguage,
      }),
    })
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      const short = (errBody || '').slice(0, 160)
      view.topicLastError = 'HTTP ' + resp.status + (short ? ' — ' + short : '')
      logView('topic-stream ' + resp.status + ': ' + short, 'err')
      return
    }
    const data = await resp.json()
    const topics = Array.isArray(data.topics) ? data.topics : []
    if (topics.length === 0) {
      view.topicLastError = 'no topics returned'
      return
    }
    // Normalize each entry — defensive against schema drift from Claude.
    view.topics = topics.map((t) => ({
      title: (t && t.title) || '(untitled)',
      summary: (t && t.summary) || '',
      keyPoints: Array.isArray(t && t.keyPoints) ? t.keyPoints : [],
      sentiment: (t && t.sentiment) || 'neutral',
    }))
    renderTopics()
    logView(`topics segmented (${view.topics.length}) in ${data.latencyMs || '?'}ms`, 'ok')
  } catch (err) {
    view.topicLastError = err.message
    logView('topic-stream err: ' + err.message, 'err')
  } finally {
    view.topicRequestInFlight = false
    updateTopicStatus()
  }
}

function updateEmptyMessages() {
  const off = !view.cloudOptIn
  els.topicEmptyMsg.innerHTML = off
    ? 'Topic segmentation is <strong>off</strong>. Enable it below — the Orka server uses your Claude Code login, no extra API key needed.'
    : 'Topics will appear here once there\'s enough transcript to segment.'
  els.topicEmptyCta.classList.toggle('hidden', !off)
  updateTopicStatus()
}

// Live status line above the topic list. Shows what the segmenter is
// doing right now: waiting for more transcript, throttled between polls,
// calling Claude, or an error state.
function updateTopicStatus() {
  const el = els.topicStatus
  if (!view.cloudOptIn) {
    el.hidden = true
    return
  }
  const now = Date.now()
  const chars = view.transcriptChunks.map((c) => c.text).join(' ').trim().length
  const sinceRequest = view.lastTopicRequestAt ? now - view.lastTopicRequestAt : Infinity

  if (view.topicRequestInFlight) {
    el.hidden = false
    el.className = 'sp-topic-status working'
    el.textContent = 'Asking Claude Haiku to segment the transcript…'
  } else if (view.topicLastError) {
    el.hidden = false
    el.className = 'sp-topic-status err'
    el.textContent = 'Last call failed: ' + view.topicLastError
  } else if (chars < TOPIC_MIN_CHARS) {
    el.hidden = false
    el.className = 'sp-topic-status'
    el.textContent = `Buffering transcript — ${chars} / ${TOPIC_MIN_CHARS} chars until the first segmentation.`
  } else if (sinceRequest < TOPIC_INTERVAL_MS) {
    const wait = Math.ceil((TOPIC_INTERVAL_MS - sinceRequest) / 1000)
    el.hidden = false
    el.className = 'sp-topic-status'
    el.textContent = `Next segmentation in ~${wait}s · ${view.topics.length} topics so far.`
  } else {
    el.hidden = true
  }
}

// Repaint the topic status every second so the countdown feels live.
setInterval(() => {
  if (view.cloudOptIn) updateTopicStatus()
}, 1000)

/**
 * Render the topic list — newest at the top. Called after every
 * successful segmentation call. The list is a full replacement of the
 * previous DOM state; the model returns the full segmentation each poll.
 */
function renderTopics() {
  updateEmptyMessages()
  els.topicList.innerHTML = ''
  if (!view.topics || view.topics.length === 0) {
    els.topicEmpty.classList.remove('hidden')
    return
  }
  els.topicEmpty.classList.add('hidden')
  // Model returns chronological (earliest first). Display reversed so
  // the freshest topic is at the top.
  const reversed = [...view.topics].reverse()
  reversed.forEach((topic, i) => {
    const li = document.createElement('li')
    li.className = 'sp-topic-card' + (i === 0 ? ' newest' : '')

    const idx = document.createElement('span')
    idx.className = 'sp-topic-index'
    // Show the original chronological number (1 = oldest topic).
    idx.textContent = '#' + (view.topics.length - i)
    li.appendChild(idx)

    const h2 = document.createElement('h2')
    h2.textContent = topic.title || '(untitled)'
    li.appendChild(h2)

    if (topic.summary) {
      const p = document.createElement('p')
      p.className = 'sp-topic-summary'
      p.textContent = topic.summary
      li.appendChild(p)
    }

    if (topic.keyPoints && topic.keyPoints.length > 0) {
      const ul = document.createElement('ul')
      ul.className = 'sp-topic-points'
      topic.keyPoints.forEach((kp) => {
        const kli = document.createElement('li')
        kli.textContent = kp
        ul.appendChild(kli)
      })
      li.appendChild(ul)
    }

    const foot = document.createElement('footer')
    foot.className = 'sp-topic-meta'
    const sentiment = (topic.sentiment || 'neutral').toLowerCase()
    const sSpan = document.createElement('span')
    sSpan.className = 'sp-topic-sentiment ' + sentiment
    sSpan.textContent = sentiment
    foot.appendChild(sSpan)
    li.appendChild(foot)

    els.topicList.appendChild(li)
  })
}

// ---------- Tabs -----------------------------------------------------------

document.querySelectorAll('.sp-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab
    document.querySelectorAll('.sp-tab').forEach((b) => b.classList.toggle('active', b === btn))
    document.querySelectorAll('.sp-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + target))
  })
})

// ---------- Collapse / Detach ---------------------------------------------

els.btnCollapse.addEventListener('click', () => { document.body.classList.add('collapsed'); view.userCollapsed = true })
els.btnExpand.addEventListener('click', () => { document.body.classList.remove('collapsed'); view.userCollapsed = false })

const COLLAPSE_WIDTH_PX = 180
const EXPAND_WIDTH_PX = 260
const ro = new ResizeObserver((entries) => {
  const w = entries[0]?.contentRect?.width || window.innerWidth
  if (w <= COLLAPSE_WIDTH_PX && !document.body.classList.contains('collapsed')) {
    document.body.classList.add('collapsed')
  } else if (w >= EXPAND_WIDTH_PX && document.body.classList.contains('collapsed') && !view.userCollapsed) {
    document.body.classList.remove('collapsed')
  }
})
ro.observe(document.body)

// ---------- Cloud opt-in --------------------------------------------------

els.cloudToggle.addEventListener('change', async () => {
  view.cloudOptIn = els.cloudToggle.checked
  try { await chrome.storage.local.set({ cloudOptIn: view.cloudOptIn }) } catch {}
  updateEmptyMessages()
  if (view.cloudOptIn && view.transcriptChunks.length > 0) {
    view.lastTopicRequestAt = 0
    maybeRequestTopic()
  }
})

// Inline CTAs in the empty states — flip the same toggle without the
// user having to hunt for the banner at the bottom of the panel.
function enableCloudFromCta() {
  els.cloudToggle.checked = true
  els.cloudToggle.dispatchEvent(new Event('change'))
}
els.topicEmptyCta.addEventListener('click', enableCloudFromCta)

// ---------- Copy for Claude KB --------------------------------------------
//
// Post-Stop, the review view has everything we need to feed a Claude
// session that just needs to load the KB skills and register the meeting:
//   - Full transcript (view.transcriptChunks)
//   - Topic segmentation (view.topics) — the last successful call to
//     /api/ai/topic-stream. If topics never ran (cloud opt-in off), we
//     still ship the transcript.
//   - Recording metadata (view.lastSavedName / duration / size)
//   - The user's KB prompt template (chrome.storage.local via
//     getKbPromptTemplate — SAME storage key the recordings page uses,
//     so tweaking it here also tweaks it there).
//
// Composed text goes to the clipboard via the same
// clipboard-with-execCommand-fallback pattern as recordings.js.

async function composeKbPayload() {
  const prompt = await getKbPromptTemplate()
  const parts = [prompt.trim(), '---']

  // Metadata block — Claude uses this to build the meeting entity.
  const meta = []
  if (view.lastSavedName) meta.push(`- Recording: ${view.lastSavedName}.webm`)
  if (typeof view.lastSavedDuration === 'number') {
    meta.push(`- Duration: ${fmtDuration(view.lastSavedDuration)}`)
  }
  meta.push(`- Language: ${view.liveLanguage || 'auto'}`)
  meta.push(`- Captured: ${new Date().toISOString()}`)
  if (meta.length > 0) {
    parts.push('## Meeting metadata\n' + meta.join('\n'))
  }

  // Topic segmentation, chronological (earliest → latest). This mirrors
  // what Claude produced in the Topics tab.
  if (view.topics && view.topics.length > 0) {
    const lines = ['## Topics discussed (' + view.topics.length + ')']
    view.topics.forEach((topic, i) => {
      lines.push('')
      lines.push(`### ${i + 1}. ${topic.title || '(untitled)'}`)
      if (topic.summary) lines.push(topic.summary)
      if (topic.keyPoints && topic.keyPoints.length > 0) {
        lines.push('')
        lines.push('Key points:')
        topic.keyPoints.forEach((kp) => lines.push('- ' + kp))
      }
      if (topic.sentiment && topic.sentiment !== 'neutral') {
        lines.push('')
        lines.push('Sentiment: ' + topic.sentiment)
      }
    })
    parts.push(lines.join('\n'))
  }

  // Full transcript last — Claude has the summaries above for context.
  const transcript = view.transcriptChunks.map((c) => c.text).join(' ').trim()
  if (transcript) {
    parts.push('## Full transcript\n\n' + transcript)
  }

  return parts.join('\n\n')
}

/**
 * Copy text via the Async Clipboard API when we're in a secure context;
 * fall back to a throwaway textarea + execCommand("copy") when we're
 * not (e.g. http://localhost tests). Same shape as recordings.js.
 */
async function copyPlainText(text) {
  try {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function flashCopyButton(btn) {
  if (!btn) return
  btn.classList.add('flash-ok')
  const original = btn.textContent
  btn.textContent = '✓ Copied'
  setTimeout(() => {
    btn.classList.remove('flash-ok')
    btn.textContent = original
  }, 1500)
}

els.btnCopyKb.addEventListener('click', async () => {
  const transcriptChars = view.transcriptChunks.map((c) => c.text).join(' ').trim().length
  if (transcriptChars < 20) {
    logView('nothing to copy — transcript is empty', 'err')
    return
  }
  try {
    const payload = await composeKbPayload()
    const ok = await copyPlainText(payload)
    if (ok) {
      flashCopyButton(els.btnCopyKb)
      logView(`copied ${payload.length} chars (${view.topics.length} topics, ${transcriptChars} transcript chars)`, 'ok')
    } else {
      logView('clipboard copy failed — no secure context?', 'err')
    }
  } catch (err) {
    logView('copy failed: ' + err.message, 'err')
  }
})

// ---------- KB prompt editor modal -----------------------------------------

async function openKbPromptEditor() {
  try {
    els.kbModalTextarea.value = await getKbPromptTemplate()
  } catch {
    els.kbModalTextarea.value = ''
  }
  els.kbModal.classList.remove('hidden')
  setTimeout(() => els.kbModalTextarea.focus(), 20)
}
function closeKbPromptEditor() {
  els.kbModal.classList.add('hidden')
}
els.btnEditKbPrompt.addEventListener('click', openKbPromptEditor)
els.kbModalClose.addEventListener('click', closeKbPromptEditor)
els.kbModalCancel.addEventListener('click', closeKbPromptEditor)
els.kbModal.addEventListener('click', (e) => {
  if (e.target === els.kbModal) closeKbPromptEditor()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.kbModal.classList.contains('hidden')) closeKbPromptEditor()
})
els.kbModalSave.addEventListener('click', async () => {
  const v = els.kbModalTextarea.value.trim()
  if (!v) return
  try {
    await setKbPromptTemplate(v)
    logView('KB prompt saved', 'ok')
    closeKbPromptEditor()
  } catch (err) {
    logView('KB prompt save failed: ' + err.message, 'err')
  }
})
els.kbModalReset.addEventListener('click', async () => {
  try {
    await resetKbPromptTemplate()
    els.kbModalTextarea.value = await getKbPromptTemplate()
    logView('KB prompt reset to default', 'ok')
  } catch (err) {
    logView('KB prompt reset failed: ' + err.message, 'err')
  }
})
