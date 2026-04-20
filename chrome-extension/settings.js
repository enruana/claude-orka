const urlInput = document.getElementById('server-url')
const btnSave = document.getElementById('btn-save')
const btnTest = document.getElementById('btn-test')
const testResult = document.getElementById('test-result')
const testDot = document.getElementById('test-dot')
const testText = document.getElementById('test-text')
const toastEl = document.getElementById('toast')
const toastTextEl = document.getElementById('toast-text')

// Load current value
;(async () => {
  urlInput.value = await getServerUrl()
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
