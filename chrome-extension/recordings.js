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
document.getElementById('btn-download-audio').addEventListener('click', () => downloadAudio())
document.getElementById('btn-generate-report').addEventListener('click', () => generateReport())
document.getElementById('btn-report-from-tab').addEventListener('click', () => generateReport())
document.getElementById('btn-copy').addEventListener('click', () => copyActiveTab())
document.getElementById('btn-download-text').addEventListener('click', () => downloadActiveTab())
document.getElementById('btn-auto-name').addEventListener('click', () => autoNameSelected())

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab))
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + activeTab))
  })
})

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

  noSelectionEl.classList.remove('hidden')
  detailContentEl.classList.remove('hidden')

  detailNameEl.textContent = rec.name
  detailMetaEl.textContent = `${formatDuration(rec.duration)} \u00B7 ${formatFileSize(rec.size)} \u00B7 ${formatDate(rec.createdAt)}`

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

  try {
    // Step 1: Upload audio - server responds immediately with jobId
    const uploadRes = await fetch(`${SERVER}/api/transcribe`, {
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
        await updateRecording(rec.id, { transcription: result.text, transcriptionStatus: 'completed' })
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
