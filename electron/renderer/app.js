/**
 * Claude Orka - Electron Renderer
 * GitKraken-inspired UI for managing Claude sessions
 */

// ===== STATE =====
const state = {
  projectPath: '',
  sessions: [],
  currentSession: null,
  currentFilter: 'all',
  selectedNode: null, // {type: 'main'|'fork', data: {...}}
  zoom: 1.0,
}

// ===== DOM ELEMENTS =====
const $el = {
  // Header
  projectPath: document.getElementById('project-path'),
  refreshBtn: document.getElementById('refresh-btn'),
  newSessionBtn: document.getElementById('new-session-btn'),

  // Left sidebar
  sessionsList: document.getElementById('sessions-list'),
  filterTabs: document.querySelectorAll('.filter-tab'),

  // Center graph
  graphCanvas: document.getElementById('graph-canvas'),
  graphEmpty: document.getElementById('graph-empty'),
  currentSessionTitle: document.getElementById('current-session-title'),
  zoomInBtn: document.getElementById('zoom-in-btn'),
  zoomOutBtn: document.getElementById('zoom-out-btn'),
  zoomResetBtn: document.getElementById('zoom-reset-btn'),

  // Right details panel
  detailsEmpty: document.getElementById('details-empty'),
  detailsMain: document.getElementById('details-main'),
  detailsFork: document.getElementById('details-fork'),
  detailsSession: document.getElementById('details-session'),

  // Command modal
  commandModal: document.getElementById('command-modal'),
  commandInput: document.getElementById('command-input'),
  commandTargetLabel: document.getElementById('command-target-label'),
  commandSendBtn: document.getElementById('command-send-btn'),
  commandCancelBtn: document.getElementById('command-cancel-btn'),

  // Toast
  toastContainer: document.getElementById('toast-container'),
}

// ===== CONSTANTS =====
const COLORS = {
  main: '#00d9ff', // Cyan vibrante como GitKraken
  forks: ['#ff1b8d', '#af52de', '#00d26a', '#ffa500', '#5ac8fa'], // Colores vibrantes
  active: '#00d26a',
  saved: '#606060',
  merged: '#af52de',
}

const NODE_RADIUS = 6
const NODE_SPACING = 50
const FORK_OFFSET = 150
const COMMITS_PER_BRANCH = 4 // Número de commits a mostrar por branch

// ===== UTILITIES =====
function formatDate(dateStr) {
  if (!dateStr) return 'N/A'
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div')
  toast.className = `toast ${type}`
  toast.innerHTML = `
    <div class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</div>
    <div class="toast-content">
      <div class="toast-message">${message}</div>
    </div>
  `
  $el.toastContainer.appendChild(toast)

  setTimeout(() => toast.remove(), 4000)
}

function askUser(message, defaultValue = '') {
  return new Promise((resolve) => {
    const dialog = document.createElement('div')
    dialog.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center; z-index: 10000;
    `
    dialog.innerHTML = `
      <div style="background: #1e1e1e; padding: 24px; border-radius: 8px; min-width: 400px; border: 1px solid #363636;">
        <h3 style="margin: 0 0 16px 0; color: #e8e8e8; font-size: 16px;">${message}</h3>
        <input type="text" id="dialog-input" value="${defaultValue}"
          style="width: 100%; padding: 8px 12px; background: #141414; border: 1px solid #363636; border-radius: 4px; color: #e8e8e8; font-size: 13px; margin-bottom: 16px;" />
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button id="dialog-cancel" style="padding: 6px 12px; background: #252525; color: #e8e8e8; border: 1px solid #363636; border-radius: 4px; cursor: pointer; font-size: 12px;">Cancel</button>
          <button id="dialog-ok" style="padding: 6px 12px; background: #4a9eff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">OK</button>
        </div>
      </div>
    `
    document.body.appendChild(dialog)

    const input = dialog.querySelector('#dialog-input')
    const okBtn = dialog.querySelector('#dialog-ok')
    const cancelBtn = dialog.querySelector('#dialog-cancel')

    input.focus()
    input.select()

    okBtn.onclick = () => { resolve(input.value); dialog.remove() }
    cancelBtn.onclick = () => { resolve(''); dialog.remove() }
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { resolve(input.value); dialog.remove() }
      if (e.key === 'Escape') { resolve(''); dialog.remove() }
    }
  })
}

function confirmAction(message) {
  return new Promise((resolve) => {
    const dialog = document.createElement('div')
    dialog.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center; z-index: 10000;
    `
    dialog.innerHTML = `
      <div style="background: #1e1e1e; padding: 24px; border-radius: 8px; min-width: 400px; border: 1px solid #363636;">
        <h3 style="margin: 0 0 16px 0; color: #e8e8e8; font-size: 16px;">${message}</h3>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button id="dialog-no" style="padding: 6px 12px; background: #252525; color: #e8e8e8; border: 1px solid #363636; border-radius: 4px; cursor: pointer; font-size: 12px;">No</button>
          <button id="dialog-yes" style="padding: 6px 12px; background: #ff5757; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Yes</button>
        </div>
      </div>
    `
    document.body.appendChild(dialog)

    const yesBtn = dialog.querySelector('#dialog-yes')
    const noBtn = dialog.querySelector('#dialog-no')

    yesBtn.onclick = () => { resolve(true); dialog.remove() }
    noBtn.onclick = () => { resolve(false); dialog.remove() }
  })
}

// ===== SESSIONS LIST (Left Sidebar) =====
function renderSessionsList() {
  const filtered = state.sessions.filter(s => {
    if (state.currentFilter === 'all') return true
    return s.status === state.currentFilter
  })

  if (filtered.length === 0) {
    $el.sessionsList.innerHTML = '<div class="loading">No sessions found</div>'
    return
  }

  $el.sessionsList.innerHTML = filtered.map((session, idx) => `
    <div class="session-item ${state.currentSession?.id === session.id ? 'selected' : ''}"
         data-session-id="${session.id}">
      <div class="session-item-header">
        <div class="session-item-icon">🌿</div>
        <div class="session-item-name">${session.name}</div>
        <div class="session-item-status status-${session.status}"></div>
      </div>
      <div class="session-item-meta">
        <span>${session.forks.length} fork${session.forks.length !== 1 ? 's' : ''}</span>
        <span>${formatDate(session.main.createdAt)}</span>
      </div>
    </div>
  `).join('')

  // Attach click listeners
  $el.sessionsList.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', () => {
      const sessionId = item.dataset.sessionId
      selectSession(sessionId)
    })
  })
}

function selectSession(sessionId) {
  state.currentSession = state.sessions.find(s => s.id === sessionId)
  state.selectedNode = null

  renderSessionsList()
  renderGraph()
  showDetailsEmpty()

  if (state.currentSession) {
    $el.currentSessionTitle.textContent = state.currentSession.name
    $el.graphEmpty.classList.add('hidden')
  }
}

// ===== GRAPH VISUALIZATION (Center Canvas) =====
function renderGraph() {
  if (!state.currentSession) {
    $el.graphEmpty.classList.remove('hidden')
    return
  }

  $el.graphEmpty.classList.add('hidden')
  const canvas = $el.graphCanvas
  const ctx = canvas.getContext('2d')

  // Set canvas size
  canvas.width = canvas.offsetWidth
  canvas.height = canvas.offsetHeight

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const session = state.currentSession
  const centerX = canvas.width / 2
  const startY = 80

  // Calcular cuántos commits totales mostrar
  const totalHeight = session.forks.length > 0
    ? (session.forks.length + 1) * COMMITS_PER_BRANCH * NODE_SPACING
    : COMMITS_PER_BRANCH * NODE_SPACING

  // Array para almacenar todos los nodos clickeables
  const allNodes = []

  // ===== DIBUJAR MAIN BRANCH =====
  const mainCommits = []
  for (let i = 0; i < COMMITS_PER_BRANCH + session.forks.length; i++) {
    const y = startY + i * NODE_SPACING
    mainCommits.push({ x: centerX, y, type: 'main', data: session.main })
  }

  // Dibujar línea principal
  ctx.strokeStyle = COLORS.main
  ctx.lineWidth = 2 * state.zoom
  ctx.beginPath()
  ctx.moveTo(centerX, mainCommits[0].y)
  ctx.lineTo(centerX, mainCommits[mainCommits.length - 1].y + NODE_SPACING)
  ctx.stroke()

  // Dibujar commits de main
  mainCommits.forEach((commit, idx) => {
    const isHead = idx === 0
    drawNode(ctx, commit.x, commit.y, session.status, COLORS.main, isHead)
    if (isHead) {
      allNodes.push(commit)
    }
  })

  // Label de Main
  ctx.fillStyle = '#e8e8e8'
  ctx.font = `bold ${11 * state.zoom}px -apple-system, sans-serif`
  ctx.textAlign = 'left'
  ctx.fillText('main', centerX + 15, mainCommits[0].y + 4)

  // ===== DIBUJAR FORKS =====
  session.forks.forEach((fork, idx) => {
    const isLeft = idx % 2 === 0
    const forkX = isLeft ? centerX - FORK_OFFSET : centerX + FORK_OFFSET
    const color = COLORS.forks[idx % COLORS.forks.length]

    // Punto de ramificación en main (después de algunos commits)
    const branchPointIdx = Math.min(idx + 1, mainCommits.length - 1)
    const branchPoint = mainCommits[branchPointIdx]

    // Crear commits para el fork
    const forkCommits = []
    for (let i = 0; i < COMMITS_PER_BRANCH; i++) {
      const y = branchPoint.y + i * NODE_SPACING
      forkCommits.push({
        x: forkX,
        y,
        type: 'fork',
        data: fork,
        color
      })
    }

    // Dibujar curva de ramificación desde main hasta el primer commit del fork
    ctx.strokeStyle = color
    ctx.lineWidth = 2 * state.zoom
    ctx.beginPath()
    ctx.moveTo(branchPoint.x, branchPoint.y)

    // Bezier curve para transición suave
    const cp1x = branchPoint.x
    const cp1y = branchPoint.y + NODE_SPACING / 3
    const cp2x = forkCommits[0].x
    const cp2y = branchPoint.y + NODE_SPACING * 0.7
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, forkCommits[0].x, forkCommits[0].y)
    ctx.stroke()

    // Dibujar línea del fork
    if (forkCommits.length > 1) {
      ctx.beginPath()
      ctx.moveTo(forkCommits[0].x, forkCommits[0].y)
      ctx.lineTo(forkCommits[forkCommits.length - 1].x, forkCommits[forkCommits.length - 1].y)
      ctx.stroke()
    }

    // Si el fork está merged, dibujar línea de vuelta a main
    if (fork.mergedToMain) {
      const lastForkCommit = forkCommits[forkCommits.length - 1]
      const mergeTargetIdx = branchPointIdx + COMMITS_PER_BRANCH
      const mergeTarget = mainCommits[Math.min(mergeTargetIdx, mainCommits.length - 1)]

      ctx.strokeStyle = color
      ctx.globalAlpha = 0.5
      ctx.setLineDash([5, 5])
      ctx.beginPath()
      ctx.moveTo(lastForkCommit.x, lastForkCommit.y)

      const mcp1x = lastForkCommit.x
      const mcp1y = lastForkCommit.y + NODE_SPACING / 3
      const mcp2x = mergeTarget.x
      const mcp2y = mergeTarget.y - NODE_SPACING / 3
      ctx.bezierCurveTo(mcp1x, mcp1y, mcp2x, mcp2y, mergeTarget.x, mergeTarget.y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }

    // Dibujar commits del fork
    forkCommits.forEach((commit, commitIdx) => {
      const isHead = commitIdx === 0
      drawNode(ctx, commit.x, commit.y, fork.status, color, isHead)
      if (isHead) {
        allNodes.push(commit)
      }
    })

    // Label del fork
    ctx.fillStyle = '#e8e8e8'
    ctx.font = `bold ${11 * state.zoom}px -apple-system, sans-serif`
    ctx.textAlign = isLeft ? 'right' : 'left'
    const labelX = isLeft ? forkCommits[0].x - 15 : forkCommits[0].x + 15
    ctx.fillText(fork.name, labelX, forkCommits[0].y + 4)
  })

  // Store nodes for click detection
  canvas.nodes = allNodes
}

function drawNode(ctx, x, y, status, color, isHead = false) {
  const radius = (isHead ? NODE_RADIUS * 1.3 : NODE_RADIUS) * state.zoom

  // Outer circle (branch color)
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()

  // Outline más grueso para HEAD
  ctx.strokeStyle = '#141414'
  ctx.lineWidth = isHead ? 3 : 2
  ctx.stroke()

  // Inner circle for status indicator (solo en HEAD)
  if (isHead && (status === 'saved' || status === 'merged')) {
    ctx.beginPath()
    ctx.arc(x, y, radius / 2.5, 0, Math.PI * 2)
    ctx.fillStyle = status === 'saved' ? COLORS.saved : COLORS.merged
    ctx.fill()
  }

  // Highlight ring para HEAD activo
  if (isHead && status === 'active') {
    ctx.beginPath()
    ctx.arc(x, y, radius + 3, 0, Math.PI * 2)
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.globalAlpha = 0.5
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}

// ===== DETAILS PANEL (Right Sidebar) =====
function showDetailsEmpty() {
  $el.detailsEmpty.classList.remove('hidden')
  $el.detailsMain.classList.remove('active')
  $el.detailsFork.classList.remove('active')
  $el.detailsSession.classList.remove('active')
}

function showMainDetails() {
  if (!state.currentSession) return

  $el.detailsEmpty.classList.add('hidden')
  $el.detailsMain.classList.add('active')
  $el.detailsFork.classList.remove('active')
  $el.detailsSession.classList.remove('active')

  const session = state.currentSession
  const main = session.main

  // Update main details
  document.getElementById('main-session-name').textContent = session.name
  document.getElementById('main-created').textContent = formatDate(main.createdAt)
  document.getElementById('main-tmux').textContent = session.tmuxSessionName
  document.getElementById('main-status').className = `status-indicator status-${session.status}`

  // Context (only if saved)
  const contextRow = document.getElementById('main-context-row')
  if (main.contextPath) {
    contextRow.style.display = 'block'
    document.getElementById('main-context').textContent = main.contextPath
  } else {
    contextRow.style.display = 'none'
  }

  // Button states
  document.getElementById('main-resume-btn').disabled = session.status === 'active'
  document.getElementById('main-close-btn').disabled = session.status === 'saved'
}

function showForkDetails(fork) {
  if (!fork) return

  $el.detailsEmpty.classList.add('hidden')
  $el.detailsMain.classList.remove('active')
  $el.detailsFork.classList.add('active')
  $el.detailsSession.classList.remove('active')

  // Update fork details
  document.getElementById('fork-name').textContent = fork.name
  document.getElementById('fork-id').textContent = fork.id
  document.getElementById('fork-created').textContent = formatDate(fork.createdAt)
  document.getElementById('fork-pane').textContent = fork.tmuxPaneId || 'N/A'
  document.getElementById('fork-status').className = `status-indicator status-${fork.status}`

  // Context (only if saved)
  const contextRow = document.getElementById('fork-context-row')
  if (fork.contextPath) {
    contextRow.style.display = 'block'
    document.getElementById('fork-context').textContent = fork.contextPath
  } else {
    contextRow.style.display = 'none'
  }

  // Merged info
  const mergedRow = document.getElementById('fork-merged-row')
  if (fork.mergedToMain) {
    mergedRow.style.display = 'block'
    document.getElementById('fork-merged').textContent = `Yes (${formatDate(fork.mergedAt)})`
  } else {
    mergedRow.style.display = 'none'
  }

  // Button states
  document.getElementById('fork-export-btn').disabled = fork.status !== 'active'
  document.getElementById('fork-merge-btn').disabled = fork.status !== 'active' || !fork.contextPath
  document.getElementById('fork-resume-btn').disabled = fork.status === 'active'
  document.getElementById('fork-close-btn').disabled = fork.status !== 'active'
}

// ===== EVENT HANDLERS =====

// Canvas click - detect node clicks
$el.graphCanvas.addEventListener('click', (e) => {
  if (!$el.graphCanvas.nodes) return

  const rect = $el.graphCanvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top

  const clickedNode = $el.graphCanvas.nodes.find(node => {
    const dx = x - node.x
    const dy = y - node.y
    const clickRadius = NODE_RADIUS * 1.5 * state.zoom + 5
    return Math.sqrt(dx * dx + dy * dy) <= clickRadius
  })

  if (clickedNode) {
    state.selectedNode = clickedNode
    if (clickedNode.type === 'main') {
      showMainDetails()
    } else {
      showForkDetails(clickedNode.data)
    }
  }
})

// Filter tabs
$el.filterTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    $el.filterTabs.forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    state.currentFilter = tab.dataset.filter
    renderSessionsList()
  })
})

// Zoom controls
$el.zoomInBtn.addEventListener('click', () => {
  state.zoom = Math.min(state.zoom + 0.1, 2.0)
  renderGraph()
})

$el.zoomOutBtn.addEventListener('click', () => {
  state.zoom = Math.max(state.zoom - 0.1, 0.5)
  renderGraph()
})

$el.zoomResetBtn.addEventListener('click', () => {
  state.zoom = 1.0
  renderGraph()
})

// Header buttons
$el.newSessionBtn.addEventListener('click', createSession)
$el.refreshBtn.addEventListener('click', loadSessions)

// Main branch actions
document.getElementById('main-resume-btn').addEventListener('click', () => resumeSession(state.currentSession.id))
document.getElementById('main-close-btn').addEventListener('click', () => closeSession(state.currentSession.id))
document.getElementById('new-fork-btn').addEventListener('click', () => createFork(state.currentSession.id))
document.getElementById('send-command-main-btn').addEventListener('click', () => openCommandModal('main'))

// Fork actions
document.getElementById('fork-export-btn').addEventListener('click', () => exportFork())
document.getElementById('fork-merge-btn').addEventListener('click', () => mergeFork())
document.getElementById('fork-resume-btn').addEventListener('click', () => resumeFork())
document.getElementById('fork-close-btn').addEventListener('click', () => closeFork())
document.getElementById('send-command-fork-btn').addEventListener('click', () => openCommandModal('fork'))
document.getElementById('fork-delete-btn').addEventListener('click', () => deleteFork())

// Session details actions
document.getElementById('session-detail-resume-btn').addEventListener('click', () => resumeSession(state.currentSession.id))
document.getElementById('session-detail-close-btn').addEventListener('click', () => closeSession(state.currentSession.id))
document.getElementById('session-detail-delete-btn').addEventListener('click', () => deleteSession(state.currentSession.id))

// Command modal
document.querySelector('.modal-close').addEventListener('click', closeCommandModal)
$el.commandCancelBtn.addEventListener('click', closeCommandModal)
$el.commandSendBtn.addEventListener('click', sendCommand)

// ===== API CALLS =====

async function loadSessions() {
  try {
    const result = await window.orka.getSessions()
    if (result.success) {
      state.sessions = result.data
      renderSessionsList()
      if (state.currentSession) {
        state.currentSession = state.sessions.find(s => s.id === state.currentSession.id)
        renderGraph()
      }
    }
  } catch (error) {
    showToast(`Error loading sessions: ${error.message}`, 'error')
  }
}

async function createSession() {
  const name = await askUser('Enter session name (optional):', '')
  try {
    const result = await window.orka.createSession(name || undefined, true)
    if (result.success) {
      showToast('Session created!', 'success')
      await loadSessions()
      selectSession(result.data.id)
    } else {
      showToast(result.error, 'error')
    }
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error')
  }
}

async function resumeSession(sessionId) {
  try {
    const result = await window.orka.resumeSession(sessionId, true)
    if (result.success) {
      showToast('Session resumed!', 'success')
      await loadSessions()
    } else {
      showToast(result.error, 'error')
    }
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error')
  }
}

async function closeSession(sessionId) {
  const confirmed = await confirmAction('Close this session? Context will be saved.')
  if (!confirmed) return

  try {
    const result = await window.orka.closeSession(sessionId)
    if (result.success) {
      showToast('Session closed and saved!', 'success')
      await loadSessions()
    } else {
      showToast(result.error, 'error')
    }
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error')
  }
}

async function deleteSession(sessionId) {
  const confirmed = await confirmAction('Delete this session? This cannot be undone.')
  if (!confirmed) return

  try {
    const result = await window.orka.deleteSession(sessionId)
    if (result.success) {
      showToast('Session deleted!', 'success')
      state.currentSession = null
      state.selectedNode = null
      await loadSessions()
      showDetailsEmpty()
      $el.graphEmpty.classList.remove('hidden')
    } else {
      showToast(result.error, 'error')
    }
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error')
  }
}

async function createFork(sessionId) {
  const name = await askUser('Enter fork name (optional):', '')
  try {
    const result = await window.orka.createFork(sessionId, name || undefined)
    if (result.success) {
      showToast('Fork created!', 'success')
      await loadSessions()
      renderGraph()
    } else {
      showToast(result.error, 'error')
    }
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error')
  }
}

async function exportFork() {
  if (!state.selectedNode || state.selectedNode.type !== 'fork') return

  try {
    const result = await window.orka.export(state.currentSession.id, state.selectedNode.data.id)
    if (result.success) {
      showToast(`Context exported: ${result.data}`, 'success')
      await loadSessions()
      renderGraph()
    } else {
      showToast(result.error, 'error')
    }
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error')
  }
}

async function mergeFork() {
  if (!state.selectedNode || state.selectedNode.type !== 'fork') return

  const confirmed = await confirmAction('Merge this fork to main?')
  if (!confirmed) return

  try {
    const result = await window.orka.merge(state.currentSession.id, state.selectedNode.data.id)
    if (result.success) {
      showToast('Fork merged to main!', 'success')
      await loadSessions()
      renderGraph()
    } else {
      showToast(result.error, 'error')
    }
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error')
  }
}

async function resumeFork() {
  if (!state.selectedNode || state.selectedNode.type !== 'fork') return

  try {
    const result = await window.orka.resumeFork(state.currentSession.id, state.selectedNode.data.id)
    if (result.success) {
      showToast('Fork resumed!', 'success')
      await loadSessions()
      renderGraph()
    } else {
      showToast(result.error, 'error')
    }
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error')
  }
}

async function closeFork() {
  if (!state.selectedNode || state.selectedNode.type !== 'fork') return

  const confirmed = await confirmAction('Close this fork? Context will be saved.')
  if (!confirmed) return

  try {
    const result = await window.orka.closeFork(state.currentSession.id, state.selectedNode.data.id)
    if (result.success) {
      showToast('Fork closed and saved!', 'success')
      await loadSessions()
      renderGraph()
    } else {
      showToast(result.error, 'error')
    }
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error')
  }
}

async function deleteFork() {
  if (!state.selectedNode || state.selectedNode.type !== 'fork') return

  const confirmed = await confirmAction('Delete this fork? This cannot be undone.')
  if (!confirmed) return

  try {
    const result = await window.orka.deleteFork(state.currentSession.id, state.selectedNode.data.id)
    if (result.success) {
      showToast('Fork deleted!', 'success')
      state.selectedNode = null
      await loadSessions()
      renderGraph()
      showDetailsEmpty()
    } else {
      showToast(result.error, 'error')
    }
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error')
  }
}

// Command modal
let commandTarget = null

function openCommandModal(target) {
  commandTarget = target
  if (target === 'main') {
    $el.commandTargetLabel.textContent = 'Main Branch'
  } else if (state.selectedNode) {
    $el.commandTargetLabel.textContent = `Fork: ${state.selectedNode.data.name}`
  }
  $el.commandModal.classList.add('active')
  $el.commandInput.value = ''
  $el.commandInput.focus()
}

function closeCommandModal() {
  $el.commandModal.classList.remove('active')
  commandTarget = null
}

async function sendCommand() {
  const command = $el.commandInput.value.trim()
  if (!command) return

  try {
    let result
    if (commandTarget === 'main') {
      result = await window.orka.sendCommand(state.currentSession.id, '', command)
    } else if (state.selectedNode) {
      result = await window.orka.sendCommand(state.currentSession.id, state.selectedNode.data.id, command)
    }

    if (result.success) {
      showToast('Command sent!', 'success')
      closeCommandModal()
    } else {
      showToast(result.error, 'error')
    }
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error')
  }
}

// ===== INITIALIZATION =====
async function init() {
  try {
    const result = await window.orka.initialize()
    if (result.success) {
      state.projectPath = result.data
      $el.projectPath.textContent = result.data
      await loadSessions()
    } else {
      showToast('Failed to initialize: ' + result.error, 'error')
    }
  } catch (error) {
    showToast('Error initializing: ' + error.message, 'error')
  }
}

// Start the app
init()

// Handle window resize
window.addEventListener('resize', () => {
  if (state.currentSession) {
    renderGraph()
  }
})
