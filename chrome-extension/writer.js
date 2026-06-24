let SERVER = ''
let debounceTimer = null
let lastSource = null

const els = {
  english: document.getElementById('english'),
  spanish: document.getElementById('spanish'),
  tone: document.getElementById('tone'),
  toneWrap: document.getElementById('tone-wrap'),
  loading: document.getElementById('loading'),
  results: document.getElementById('results'),
  improved: document.getElementById('improved'),
  grammarFix: document.getElementById('grammarFix'),
  summary: document.getElementById('summary'),
  statusDot: document.querySelector('.status-dot'),
  statusText: document.querySelector('.status-text'),
  // Markdown tab
  mdInput: document.getElementById('md-input'),
  mdFormatBtn: document.getElementById('md-format-btn'),
  mdLoading: document.getElementById('md-loading'),
  mdResults: document.getElementById('md-results'),
  mdSource: document.getElementById('md-source'),
  mdRendered: document.getElementById('md-rendered'),
  mdCopyHtml: document.getElementById('md-copy-html'),
}

// Init: load server URL then check status
;(async () => {
  SERVER = await getServerUrl()
  checkServer()
})()

// === Tab switching ===
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn))
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`))
    // Tone selector only relevant for translator
    if (els.toneWrap) els.toneWrap.style.visibility = tab === 'translator' ? 'visible' : 'hidden'
  })
})

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

// === Translator ===
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

    if (sourceLang === 'en') {
      els.spanish.value = data.translation
    } else {
      els.english.value = data.translation
    }

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

els.english.addEventListener('input', () => scheduleTranslate('en'))
els.spanish.addEventListener('input', () => scheduleTranslate('es'))
els.tone.addEventListener('change', () => {
  if (lastSource) {
    const text = lastSource === 'en' ? els.english.value.trim() : els.spanish.value.trim()
    if (text) translate(lastSource)
  }
})

// === Markdown formatter ===
async function formatMarkdown() {
  const text = els.mdInput.value.trim()
  if (!text) return

  els.mdFormatBtn.disabled = true
  els.mdLoading.classList.remove('hidden')
  els.mdResults.classList.add('hidden')

  try {
    const res = await fetch(`${SERVER}/api/ai/markdown-format`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Request failed')
    }

    const data = await res.json()
    const md = data.markdown || ''
    els.mdSource.textContent = md
    els.mdRendered.innerHTML = (typeof marked !== 'undefined' && md) ? marked.parse(md) : md
    els.mdResults.classList.remove('hidden')
  } catch (err) {
    els.mdSource.textContent = `Error: ${err.message}`
    els.mdRendered.innerHTML = ''
    els.mdResults.classList.remove('hidden')
  } finally {
    els.mdLoading.classList.add('hidden')
    els.mdFormatBtn.disabled = false
  }
}

els.mdFormatBtn.addEventListener('click', formatMarkdown)
// Cmd/Ctrl+Enter inside the textarea
els.mdInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    formatMarkdown()
  }
})

// === Copy buttons ===
function flashCopied(btn) {
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
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
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
}

document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = btn.dataset.target
    if (!target) return
    const el = document.getElementById(target)
    if (!el) return
    const text = el.textContent || ''
    if (!text) return
    if (await copyText(text)) flashCopied(btn)
  })
})

/**
 * Copy the rendered preview as rich content. The previous version wrote
 * `innerHTML` as plain text, so pasting anywhere produced literal
 * `<h1>...</h1>` strings — useless. Instead we write a ClipboardItem
 * carrying BOTH `text/html` (rich) and `text/plain` (the markdown source
 * we already have on screen, since the user typically wants the markdown
 * when pasting into a code editor and the rendered version when pasting
 * into Notes / Slack / docs).
 *
 * Fallback for browsers without ClipboardItem support: select the
 * rendered div and run `document.execCommand('copy')` — same path the
 * user was taking manually, captures rich text the same way Cmd+C does.
 */
async function copyRendered() {
  const rendered = els.mdRendered
  const html = rendered.innerHTML
  if (!html) return false
  const md = els.mdSource?.textContent || rendered.innerText || ''

  // Preferred path — secure context + Clipboard API supports multiple
  // MIME types. Pastes formatted in rich-text targets, markdown in plain.
  if (window.isSecureContext && typeof ClipboardItem !== 'undefined'
      && navigator.clipboard && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([md], { type: 'text/plain' }),
        }),
      ])
      return true
    } catch {
      // fall through to execCommand
    }
  }

  // Fallback: programmatic selection + execCommand. Whatever was selected
  // before is preserved.
  try {
    const sel = window.getSelection()
    const prev = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
    const range = document.createRange()
    range.selectNodeContents(rendered)
    sel.removeAllRanges()
    sel.addRange(range)
    const ok = document.execCommand('copy')
    sel.removeAllRanges()
    if (prev) sel.addRange(prev)
    return ok
  } catch {
    return false
  }
}

if (els.mdCopyHtml) {
  els.mdCopyHtml.title = 'Copy formatted (rich text + markdown fallback)'
  els.mdCopyHtml.addEventListener('click', async () => {
    if (await copyRendered()) flashCopied(els.mdCopyHtml)
  })
}
