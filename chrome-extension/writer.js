const SERVER = 'http://localhost:3456'
let debounceTimer = null
let lastSource = null

const els = {
  english: document.getElementById('english'),
  spanish: document.getElementById('spanish'),
  tone: document.getElementById('tone'),
  loading: document.getElementById('loading'),
  results: document.getElementById('results'),
  improved: document.getElementById('improved'),
  grammarFix: document.getElementById('grammarFix'),
  summary: document.getElementById('summary'),
  statusDot: document.querySelector('.status-dot'),
  statusText: document.querySelector('.status-text'),
}

// Check server status
async function checkServer() {
  try {
    const res = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      els.statusDot.classList.add('online')
      els.statusDot.classList.remove('offline')
      els.statusText.textContent = 'Connected'
    } else {
      throw new Error()
    }
  } catch {
    els.statusDot.classList.add('offline')
    els.statusDot.classList.remove('online')
    els.statusText.textContent = 'Server offline'
  }
}

checkServer()

// Debounced translate
function scheduleTranslate(sourceLang) {
  clearTimeout(debounceTimer)
  lastSource = sourceLang
  debounceTimer = setTimeout(() => translate(sourceLang), 1500)
}

async function translate(sourceLang) {
  const text = sourceLang === 'en' ? els.english.value.trim() : els.spanish.value.trim()
  if (!text) return

  els.loading.classList.remove('hidden')
  els.results.classList.add('hidden')

  try {
    const res = await fetch(`${SERVER}/api/ai/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        sourceLang,
        tone: els.tone.value,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Request failed')
    }

    const data = await res.json()

    // Fill opposite textarea
    if (sourceLang === 'en') {
      els.spanish.value = data.translation
    } else {
      els.english.value = data.translation
    }

    // Fill results
    els.improved.textContent = data.improved
    els.grammarFix.textContent = data.grammarFix
    els.summary.textContent = data.summary

    els.results.classList.remove('hidden')
  } catch (err) {
    els.improved.textContent = ''
    els.grammarFix.textContent = ''
    els.summary.textContent = `Error: ${err.message}`
    els.results.classList.remove('hidden')
  } finally {
    els.loading.classList.add('hidden')
  }
}

// Input listeners
els.english.addEventListener('input', () => scheduleTranslate('en'))
els.spanish.addEventListener('input', () => scheduleTranslate('es'))

// Tone change re-triggers
els.tone.addEventListener('change', () => {
  if (lastSource) {
    const text = lastSource === 'en' ? els.english.value.trim() : els.spanish.value.trim()
    if (text) translate(lastSource)
  }
})

// Copy buttons with icon swap
document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target
    const text = document.getElementById(target).textContent
    if (!text) return

    navigator.clipboard.writeText(text).then(() => {
      const iconCopy = btn.querySelector('.icon-copy')
      const iconCheck = btn.querySelector('.icon-check')

      btn.classList.add('copied')
      iconCopy.classList.add('hidden')
      iconCheck.classList.remove('hidden')

      setTimeout(() => {
        btn.classList.remove('copied')
        iconCopy.classList.remove('hidden')
        iconCheck.classList.add('hidden')
      }, 1500)
    })
  })
})
