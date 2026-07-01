let SERVER = ''

let recordings = []
let selectedId = null
let serverAvailable = false
let activeTab = 'transcript'

const listEl = document.getElementById('recordings-list')
const emptyEl = document.getElementById('empty-state')
const noSelectionEl = document.getElementById('no-selection')
const detailContentEl = document.getElementById('detail-content')
const detailNameEl = document.getElementById('detail-name')
const detailMetaEl = document.getElementById('detail-meta')
const tabsAreaEl = document.getElementById('tabs-area')
const transcriptTextEl = document.getElementById('transcript-text')
const reportTextEl = document.getElementById('report-text')
const reportEmptyEl = document.getElementById('report-empty')
const reportGeneratingEl = document.getElementById('report-generating')
const processingStatusEl = document.getElementById('processing-status')
const processingLabelEl = document.getElementById('processing-label')
const statusDotEl = document.getElementById('status-dot')
const statusTextEl = document.getElementById('status-text')

// Init: load server URL, then recordings and status
;(async () => {
  SERVER = await getServerUrl()
  loadRecordings()
  checkServerStatus()
})()

document.getElementById('link-writer').href = chrome.runtime.getURL('writer.html')
document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-input').click())
document.getElementById('file-input').addEventListener('change', handleImport)
document.getElementById('btn-refresh-status').addEventListener('click', checkServerStatus)
document.getElementById('btn-transcribe').addEventListener('click', () => transcribeSelected())

// Language picker — remember the last choice across sessions so the user
// doesn't re-pick it on every recording. Defaults to "auto" on first run.
const LANG_KEY = 'orka-transcribe-language'
const langSelect = document.getElementById('transcribe-language')
const savedLang = localStorage.getItem(LANG_KEY)
if (savedLang && ['auto', 'en', 'es'].includes(savedLang)) {
  langSelect.value = savedLang
}
langSelect.addEventListener('change', () => {
  localStorage.setItem(LANG_KEY, langSelect.value)
})

/** Returns 'auto' | 'en' | 'es'. Single source of truth for both the
 *  detail-panel button and the inline transcribe button in each card. */
function getSelectedLanguage() {
  return langSelect.value || 'auto'
}
document.getElementById('btn-download-audio').addEventListener('click', () => downloadAudio())
document.getElementById('btn-generate-report').addEventListener('click', () => generateReport())
document.getElementById('btn-report-from-tab').addEventListener('click', () => generateReport())
document.getElementById('btn-copy').addEventListener('click', () => copyActiveTab())
document.getElementById('btn-download-text').addEventListener('click', () => downloadActiveTab())
document.getElementById('btn-auto-name').addEventListener('click', () => autoNameSelected())
document.getElementById('btn-copy-for-kb').addEventListener('click', () => copyReportForKb())
document.getElementById('btn-edit-kb-prompt').addEventListener('click', () => openPromptEditor())

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab))
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + activeTab))
    refreshKbButtonsVisibility()
  })
})

/**
 * The "Copy for KB" + "Edit prompt" buttons only make sense when the user
 * is looking at the Report tab AND a report actually exists for the
 * selected recording. Called on tab switch and on recording select.
 */
function refreshKbButtonsVisibility() {
  const rec = recordings.find(r => r.id === selectedId)
  const hasReport = !!(rec && rec.report)
  const show = activeTab === 'report' && hasReport
  document.getElementById('btn-copy-for-kb').classList.toggle('hidden', !show)
  document.getElementById('btn-edit-kb-prompt').classList.toggle('hidden', !show)
}

async function checkServerStatus() {
  try {
    const res = await fetch(`${SERVER}/api/transcribe/status`, { signal: AbortSignal.timeout(3000) })
    const data = await res.json()
    serverAvailable = data.available === true
    statusDotEl.className = 'status-dot ' + (serverAvailable ? 'online' : 'offline')
    statusTextEl.textContent = serverAvailable ? 'Whisper ready' : 'Whisper unavailable'
  } catch {
    serverAvailable = false
    statusDotEl.className = 'status-dot offline'
    statusTextEl.textContent = 'Server offline'
  }
}

async function loadRecordings() {
  try {
    recordings = await getRecordings()
  } catch (err) {
    console.error('Failed to load recordings:', err)
    recordings = []
  }
  renderList()
}

function renderList() {
  listEl.querySelectorAll('.recording-card').forEach(el => el.remove())

  if (recordings.length === 0) {
    emptyEl.classList.remove('hidden')
    return
  }
  emptyEl.classList.add('hidden')

  recordings.forEach(rec => {
    const card = document.createElement('div')
    card.className = 'recording-card' + (rec.id === selectedId ? ' selected' : '')
    card.dataset.id = rec.id

    const status = rec.transcriptionStatus || 'pending'
    const badgeLabel = { pending: 'Not transcribed', processing: 'Processing...', completed: 'Transcribed', error: 'Error' }
    const hasReport = !!rec.report

    let badges = `<span class="card-badge badge-${status}">${badgeLabel[status]}</span>`
    if (hasReport) {
      badges += `<span class="card-badge badge-report">Report</span>`
    }

    card.innerHTML = `
      <div class="card-info">
        <h3>${escapeHtml(rec.name)}</h3>
        <div class="card-meta">
          <span>${formatDuration(rec.duration)}</span>
          <span>${formatFileSize(rec.size)}</span>
          <span>${formatDate(rec.createdAt)}</span>
        </div>
        <div class="card-badges">${badges}</div>
      </div>
      <div class="card-actions">
        <button class="btn-card" data-action="transcribe" title="Transcribe">&#9654;</button>
        <button class="btn-card" data-action="download" title="Download">&#8595;</button>
        <button class="btn-card danger" data-action="delete" title="Delete">&times;</button>
      </div>
    `

    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return
      selectRecording(rec.id)
    })

    card.querySelector('[data-action="transcribe"]').addEventListener('click', () => {
      selectRecording(rec.id)
      transcribeSelected()
    })
    card.querySelector('[data-action="download"]').addEventListener('click', () => {
      downloadRecordingById(rec.id)
    })
    card.querySelector('[data-action="delete"]').addEventListener('click', () => {
      deleteRec(rec.id)
    })

    listEl.appendChild(card)
  })
}

function selectRecording(id) {
  selectedId = id
  const rec = recordings.find(r => r.id === id)
  if (!rec) return

  listEl.querySelectorAll('.recording-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id)
  })

  // Hide the empty-state placeholder once a recording is selected — without
  // this both .no-selection and #detail-content end up visible inside the
  // same flex column, with the placeholder eating all the vertical space
  // and pushing the real content down to the bottom of the panel.
  noSelectionEl.classList.add('hidden')
  detailContentEl.classList.remove('hidden')

  detailNameEl.textContent = rec.name
  detailMetaEl.textContent = `${formatDuration(rec.duration)} \u00B7 ${formatFileSize(rec.size)} \u00B7 ${formatDate(rec.createdAt)}`

  // If this recording was already transcribed in a specific language, snap
  // the picker to that \u2014 the user is most likely to re-transcribe in the
  // same language. New recordings keep whatever the user last chose.
  if (rec.transcriptionLanguage && ['auto', 'en', 'es'].includes(rec.transcriptionLanguage)) {
    langSelect.value = rec.transcriptionLanguage
  }

  const hasTranscript = rec.transcriptionStatus === 'completed' && rec.transcription
  const hasReport = !!rec.report
  const isProcessing = rec.transcriptionStatus === 'processing'

  // Actions
  document.getElementById('btn-transcribe').classList.toggle('hidden', hasTranscript || isProcessing)
  document.getElementById('btn-generate-report').classList.toggle('hidden', !hasTranscript || hasReport)
  document.getElementById('btn-auto-name').classList.toggle('hidden', !hasTranscript)
  processingStatusEl.classList.toggle('hidden', !isProcessing)
  if (isProcessing) processingLabelEl.textContent = 'Transcribing...'

  // Tabs area
  if (hasTranscript) {
    tabsAreaEl.classList.remove('hidden')
    transcriptTextEl.textContent = rec.transcription

    // Report tab state
    if (hasReport) {
      reportEmptyEl.classList.add('hidden')
      reportGeneratingEl.classList.add('hidden')
      reportTextEl.classList.remove('hidden')
      reportTextEl.innerHTML = renderMarkdown(rec.report)
    } else {
      reportEmptyEl.classList.remove('hidden')
      reportGeneratingEl.classList.add('hidden')
      reportTextEl.classList.add('hidden')
    }
  } else {
    tabsAreaEl.classList.add('hidden')
  }

  // Keep the KB copy/edit buttons in sync — visibility depends on both
  // the active tab and whether the current recording has a report.
  refreshKbButtonsVisibility()
}

async function transcribeSelected() {
  const rec = recordings.find(r => r.id === selectedId)
  if (!rec) return

  if (!serverAvailable) {
    alert('Transcription server is not available. Make sure orka start is running and Whisper is installed.')
    return
  }

  rec.transcriptionStatus = 'processing'
  await updateRecording(rec.id, { transcriptionStatus: 'processing' })
  selectRecording(rec.id)
  renderList()

  // Capture the picker value at submit time — if the user changes the
  // dropdown mid-job we don't want to retroactively change what the server
  // was asked. Stored on the recording so future re-transcribes have a
  // sensible default (the user typically transcribes the same recording
  // in the same language they spoke it in).
  const language = getSelectedLanguage()

  try {
    // Step 1: Upload audio - server responds immediately with jobId.
    // `?language=` is forwarded to Whisper as `-l <lang>`. Skipping the
    // param means the server picks 'auto', so we always send it explicitly
    // for log clarity.
    const uploadRes = await fetch(`${SERVER}/api/transcribe?language=${encodeURIComponent(language)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: rec.blob,
    })

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}))
      throw new Error(err.message || 'Upload failed')
    }

    const { jobId } = await uploadRes.json()
    if (!jobId) throw new Error('No job ID returned')

    // Step 2: Poll for result every 2 seconds (max 10 minutes)
    const maxAttempts = 300 // 300 * 2s = 10 minutes
    let attempts = 0

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      attempts++

      const pollRes = await fetch(`${SERVER}/api/transcribe/job/${jobId}`, {
        signal: AbortSignal.timeout(10000)
      })

      if (!pollRes.ok) {
        throw new Error('Failed to check transcription status')
      }

      const result = await pollRes.json()

      if (result.status === 'completed') {
        rec.transcription = result.text
        rec.transcriptionStatus = 'completed'
        // Persist the language we requested + whatever Whisper resolved to
        // (server echoes the effective lang on the job result — defaults to
        // the requested value when not auto-detected). Useful for diagnostics
        // and a future "re-transcribe with same settings" affordance.
        await updateRecording(rec.id, {
          transcription: result.text,
          transcriptionStatus: 'completed',
          transcriptionLanguage: result.language || language,
        })
        rec.transcriptionLanguage = result.language || language
        renderList()
        selectRecording(rec.id)
        generateReport()
        return
      }

      if (result.status === 'error') {
        throw new Error(result.error || 'Transcription failed')
      }

      // Still processing - continue polling
    }

    throw new Error('Transcription timed out (10 min limit)')
  } catch (err) {
    console.error('Transcription error:', err)
    rec.transcriptionStatus = 'error'
    await updateRecording(rec.id, { transcriptionStatus: 'error' })
    renderList()
    selectRecording(rec.id)
  }
}

async function generateReport() {
  const rec = recordings.find(r => r.id === selectedId)
  if (!rec?.transcription) return

  // Switch to report tab and show generating state
  activeTab = 'report'
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'report'))
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-report'))

  reportEmptyEl.classList.add('hidden')
  reportTextEl.classList.add('hidden')
  reportGeneratingEl.classList.remove('hidden')

  document.getElementById('btn-generate-report').classList.add('hidden')

  try {
    const res = await fetch(`${SERVER}/api/ai/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: rec.transcription }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Report generation failed')
    }

    const data = await res.json()
    rec.report = data.report
    await updateRecording(rec.id, { report: data.report })

    reportGeneratingEl.classList.add('hidden')
    reportTextEl.classList.remove('hidden')
    reportTextEl.innerHTML = renderMarkdown(data.report)

    renderList()
    refreshKbButtonsVisibility()
  } catch (err) {
    console.error('Report error:', err)
    reportGeneratingEl.classList.add('hidden')
    reportEmptyEl.classList.remove('hidden')
    reportEmptyEl.querySelector('p').textContent = 'Report generation failed: ' + err.message
    document.getElementById('btn-generate-report').classList.remove('hidden')
  }
}

async function autoNameSelected() {
  const rec = recordings.find(r => r.id === selectedId)
  if (!rec) return

  const text = rec.report || rec.transcription
  if (!text) return

  const btn = document.getElementById('btn-auto-name')
  btn.classList.add('naming')
  btn.disabled = true

  try {
    const res = await fetch(`${SERVER}/api/ai/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Naming failed')
    }

    const data = await res.json()

    // Format: dd-mm-yy_title
    const d = new Date(rec.createdAt)
    const dd = String(d.getDate()).padStart(2, '0')
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const yy = String(d.getFullYear()).slice(-2)
    const newName = `${dd}-${mm}-${yy}_${data.title}`

    rec.name = newName
    await updateRecording(rec.id, { name: newName })

    detailNameEl.textContent = newName
    renderList()
  } catch (err) {
    console.error('Auto-name error:', err)
    alert('Failed to generate name: ' + err.message)
  } finally {
    btn.classList.remove('naming')
    btn.disabled = false
  }
}

function copyActiveTab() {
  const rec = recordings.find(r => r.id === selectedId)
  if (!rec) return

  const text = activeTab === 'report' ? rec.report : rec.transcription
  if (!text) return

  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btn-copy')
    btn.style.color = '#a6e3a1'
    setTimeout(() => { btn.style.color = '' }, 1500)
  })
}

function downloadActiveTab() {
  const rec = recordings.find(r => r.id === selectedId)
  if (!rec) return

  const text = activeTab === 'report' ? rec.report : rec.transcription
  if (!text) return

  const ext = activeTab === 'report' ? '-report.md' : '-transcript.txt'
  const type = activeTab === 'report' ? 'text/markdown' : 'text/plain'
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = rec.name + ext
  a.click()
  URL.revokeObjectURL(url)
}

function downloadRecordingById(id) {
  const rec = recordings.find(r => r.id === id)
  if (!rec) return
  const url = URL.createObjectURL(rec.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = rec.name + '.webm'
  a.click()
  URL.revokeObjectURL(url)
}

function downloadAudio() {
  if (selectedId) downloadRecordingById(selectedId)
}

async function deleteRec(id) {
  if (!confirm('Delete this recording?')) return
  try {
    await deleteRecording(id)
    recordings = recordings.filter(r => r.id !== id)
    if (selectedId === id) {
      selectedId = null
      noSelectionEl.classList.remove('hidden')
      detailContentEl.classList.add('hidden')
    }
    renderList()
  } catch (err) {
    console.error('Delete failed:', err)
  }
}

async function handleImport(e) {
  const files = e.target.files
  if (!files || files.length === 0) return

  for (const file of Array.from(files)) {
    try {
      const duration = await getAudioDuration(file)
      const name = file.name.replace(/\.[^/.]+$/, '')
      const rec = await saveRecording(file, duration, name)
      recordings.unshift(rec)
    } catch (err) {
      console.error('Import failed:', err)
    }
  }

  e.target.value = ''
  renderList()
}

function getAudioDuration(file) {
  return new Promise((resolve) => {
    const audio = new Audio()
    audio.onloadedmetadata = () => resolve(Math.floor(audio.duration))
    audio.onerror = () => resolve(0)
    audio.src = URL.createObjectURL(file)
  })
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

// Markdown rendering via marked.js
function renderMarkdown(md) {
  if (!md) return ''
  return marked.parse(md)
}

// ============================================================
// Copy report + KB prompt (paste into a Claude session)
// ============================================================

/**
 * Compose the current KB prompt template with the selected recording's
 * report, plain text, and drop it in the clipboard so the user can paste
 * it straight into a Claude Code session. The prompt template lives in
 * chrome.storage.local so the user can tweak it once and forget it.
 */
async function copyReportForKb() {
  const rec = recordings.find(r => r.id === selectedId)
  if (!rec || !rec.report) return

  const prompt = await getKbPromptTemplate()
  // Separator between the user's instructions and the report body — the
  // horizontal rule makes it visually obvious in Claude's UI and gives
  // the model an unambiguous handoff line.
  const composed = `${prompt}\n\n---\n\n${rec.report}`

  const ok = await copyPlainText(composed)
  if (ok) {
    flashButton(document.getElementById('btn-copy-for-kb'))
  }
}

/**
 * Prefer navigator.clipboard.writeText; fall back to a throwaway textarea
 * + execCommand for the non-secure-context case. Returns true on success.
 */
async function copyPlainText(text) {
  try {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to execCommand
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

function flashButton(btn) {
  if (!btn) return
  const prevColor = btn.style.color
  btn.style.color = '#a6e3a1'
  setTimeout(() => { btn.style.color = prevColor }, 1500)
}

// ============================================================
// KB prompt editor modal
// ============================================================

async function openPromptEditor() {
  const modal = document.getElementById('kb-prompt-modal')
  const textarea = document.getElementById('kb-prompt-textarea')
  textarea.value = await getKbPromptTemplate()
  modal.classList.remove('hidden')
  // Focus at the end so the user can start editing immediately without
  // wiping out what's there with an accidental keystroke.
  setTimeout(() => {
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, 30)
}

function closePromptEditor() {
  document.getElementById('kb-prompt-modal').classList.add('hidden')
}

document.getElementById('kb-prompt-close').addEventListener('click', closePromptEditor)
document.getElementById('kb-prompt-cancel').addEventListener('click', closePromptEditor)
document.getElementById('kb-prompt-modal').addEventListener('click', (e) => {
  // Click on the backdrop (outside the modal box) closes.
  if (e.target === e.currentTarget) closePromptEditor()
})

document.getElementById('kb-prompt-save').addEventListener('click', async () => {
  const value = document.getElementById('kb-prompt-textarea').value.trim()
  if (!value) {
    // Empty save = user probably wants the default back; treat it as reset.
    await resetKbPromptTemplate()
  } else {
    await setKbPromptTemplate(value)
  }
  closePromptEditor()
})

document.getElementById('kb-prompt-reset').addEventListener('click', async () => {
  await resetKbPromptTemplate()
  // Reflect the reset in the textarea in case the user wants to keep editing.
  document.getElementById('kb-prompt-textarea').value = await getKbPromptTemplate()
})
