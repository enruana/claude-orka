const urlInput = document.getElementById('server-url')
const btnSave = document.getElementById('btn-save')
const btnTest = document.getElementById('btn-test')
const testResult = document.getElementById('test-result')
const testDot = document.getElementById('test-dot')
const testText = document.getElementById('test-text')
const toastEl = document.getElementById('toast')
const toastTextEl = document.getElementById('toast-text')
const versionChip = document.getElementById('version-chip')
const versionDot = document.getElementById('version-dot')
const versionLabel = document.getElementById('version-label')
const btnUpdate = document.getElementById('btn-update')
const versionHelp = document.getElementById('version-help')

function cmpSemver(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

async function refreshVersionStatus() {
  const extVersion = chrome.runtime.getManifest().version
  versionChip.classList.remove('synced', 'outdated', 'unknown')
  versionDot.className = 'version-dot checking'
  versionLabel.textContent = `Checking… (ext v${extVersion})`
  btnUpdate.classList.add('hidden')
  versionHelp.classList.add('hidden')

  const url = (await getServerUrl()).replace(/\/+$/, '')
  let serverVersion = null
  try {
    const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const data = await res.json()
      if (typeof data?.version === 'string') serverVersion = data.version
    }
  } catch { /* fallthrough to unknown */ }

  if (!serverVersion) {
    versionChip.classList.add('unknown')
    versionDot.className = 'version-dot unknown'
    versionLabel.textContent = `Server unreachable — ext v${extVersion}`
    return
  }

  const cmp = cmpSemver(extVersion, serverVersion)
  if (cmp === 0) {
    versionChip.classList.add('synced')
    versionDot.className = 'version-dot synced'
    versionLabel.textContent = `v${extVersion} · synced with server`
  } else if (cmp < 0) {
    versionChip.classList.add('outdated')
    versionDot.className = 'version-dot outdated'
    versionLabel.textContent = `v${extVersion} → server is v${serverVersion}`
    btnUpdate.classList.remove('hidden')
    versionHelp.classList.remove('hidden')
    versionHelp.innerHTML = `Opens <code>chrome://extensions</code>. Hit the reload icon on the <strong>Orka</strong> card to pick up the new files, then come back here.`
  } else {
    versionChip.classList.add('synced')
    versionDot.className = 'version-dot ahead'
    versionLabel.textContent = `v${extVersion} (newer than server v${serverVersion})`
  }
}

btnUpdate.addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: 'chrome://extensions/' })
  } catch {
    showToast('Open chrome://extensions and click reload on the Orka card')
  }
})

;(async () => {
  urlInput.value = await getServerUrl()
  void refreshVersionStatus()
})()

// Save
btnSave.addEventListener('click', async () => {
  const raw = urlInput.value.trim()
  if (!raw) {
    showToast('URL cannot be empty')
    return
  }
  // Remove trailing slash
  const url = raw.replace(/\/+$/, '')
  urlInput.value = url
  await setServerUrl(url)
  showToast('Saved')
  void refreshVersionStatus()
})

// Enter key saves
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnSave.click()
})

// Test connection
btnTest.addEventListener('click', async () => {
  const url = urlInput.value.trim().replace(/\/+$/, '')
  if (!url) {
    showToast('Enter a URL first')
    return
  }

  btnTest.disabled = true
  btnTest.textContent = 'Testing...'
  testResult.classList.remove('hidden')
  testDot.className = 'test-dot testing'
  testText.textContent = 'Connecting...'

  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      testDot.className = 'test-dot success'
      testText.textContent = 'Connected'
    } else {
      testDot.className = 'test-dot error'
      testText.textContent = `Server responded with ${res.status}`
    }
  } catch (err) {
    testDot.className = 'test-dot error'
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      testText.textContent = 'Connection timed out'
    } else {
      testText.textContent = 'Cannot reach server'
    }
  } finally {
    btnTest.disabled = false
    btnTest.textContent = 'Test Connection'
  }
})

function showToast(msg) {
  toastTextEl.textContent = msg
  toastEl.classList.remove('hidden')
  setTimeout(() => toastEl.classList.add('hidden'), 2000)
}

// -----------------------------------------------------------------------------
// KB prompt template — mirror of the editor available inside Recordings.
// Persists via storage.js (chrome.storage.local). Same source of truth,
// same default. Editing here or there both write to the same key.
// -----------------------------------------------------------------------------
const kbPromptTextarea = document.getElementById('kb-prompt')
const btnKbSave = document.getElementById('btn-kb-save')
const btnKbReset = document.getElementById('btn-kb-reset')

;(async () => {
  kbPromptTextarea.value = await getKbPromptTemplate()
})()

btnKbSave.addEventListener('click', async () => {
  const value = kbPromptTextarea.value.trim()
  if (!value) {
    await resetKbPromptTemplate()
    kbPromptTextarea.value = await getKbPromptTemplate()
    showToast('Reset to default')
    return
  }
  await setKbPromptTemplate(value)
  showToast('Saved')
})

btnKbReset.addEventListener('click', async () => {
  await resetKbPromptTemplate()
  kbPromptTextarea.value = await getKbPromptTemplate()
  showToast('Reset to default')
})
