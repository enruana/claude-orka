// Server URL config (chrome.storage.local)
const DEFAULT_SERVER_URL = 'https://localhost:3456'

function getServerUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get('serverUrl', (result) => {
      resolve(result.serverUrl || DEFAULT_SERVER_URL)
    })
  })
}

function setServerUrl(url) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ serverUrl: url }, resolve)
  })
}

// IndexedDB storage for audio recordings
const DB_NAME = 'orka-recordings'
const DB_VERSION = 1
const STORE_NAME = 'recordings'

let db = null

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) { resolve(db); return }

    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { db = request.result; resolve(db) }
    request.onupgradeneeded = (event) => {
      const database = event.target.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }
  })
}

function generateRecordingName() {
  return 'orka-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

async function saveRecording(blob, duration, customName) {
  const database = await openDB()
  const id = 'rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9)

  const recording = {
    id,
    name: customName || generateRecordingName(),
    blob,
    duration: duration || 0,
    createdAt: Date.now(),
    size: blob.size,
    transcriptionStatus: 'pending',
  }

  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.add(recording)
    request.onsuccess = () => resolve(recording)
    request.onerror = () => reject(request.error)
  })
}

async function getRecordings() {
  const database = await openDB()

  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('createdAt')
    const request = index.openCursor(null, 'prev')

    const recordings = []
    request.onsuccess = (event) => {
      const cursor = event.target.result
      if (cursor) {
        recordings.push(cursor.value)
        cursor.continue()
      } else {
        resolve(recordings)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

async function getRecording(id) {
  const database = await openDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], 'readonly')
    const request = tx.objectStore(STORE_NAME).get(id)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

async function updateRecording(id, updates) {
  const database = await openDB()
  const recording = await getRecording(id)
  if (!recording) throw new Error('Recording not found')

  const updated = Object.assign({}, recording, updates)
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], 'readwrite')
    const request = tx.objectStore(STORE_NAME).put(updated)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

async function deleteRecording(id) {
  const database = await openDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], 'readwrite')
    const request = tx.objectStore(STORE_NAME).delete(id)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hrs > 0) {
    return hrs + ':' + String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0')
  }
  return String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0')
}
