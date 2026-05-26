let librespot = null
try {
  librespot = require('@lox-audioserver/node-librespot')
} catch (err) {
  console.error('[librespot-main] Failed to load native module:', err.message)
}

const { getSpotifyCredentialsRaw, ensureValidToken, fetchWithTimeout } = require('./spotifyAuth')
const fs = require('fs/promises')
const path = require('path')
const { app } = require('electron')

const DEVICE_ID_FILE = path.join(app.getPath('userData'), '.spotify-device-id.json')
const CREDENTIALS_FILE = path.join(app.getPath('userData'), '.spotify-librespot-creds.json')
let librespotHost = null
let currentWindow = null
let deviceId = null
let pcmStopped = false
let pollTimer = null
let pollInProgress = false
let reconnectInProgress = false
let initInProgress = false
let lastReconnectFailTime = 0
const RECONNECT_COOLDOWN_MS = 60000
const NATIVE_TIMEOUT_MS = 15000

// PCM batching: buffer chunks and drain as a single IPC message every ~50ms
const PCM_BATCH_INTERVAL_MS = 25
const PCM_MAX_BUFFERED = 100
let pcmBatch = []
let pcmDrainTimer = null

function drainPcmBatch() {
  if (pcmBatch.length === 0) {
    pcmDrainTimer = null
    return
  }
  if (currentWindow && !currentWindow.isDestroyed()) {
    currentWindow.webContents.send('spotify-pcm-batch', pcmBatch)
  }
  pcmBatch = []
  if (!pcmStopped) {
    pcmDrainTimer = setTimeout(drainPcmBatch, PCM_BATCH_INTERVAL_MS)
    pcmDrainTimer.unref()
  } else {
    pcmDrainTimer = null
  }
}

function queuePcmChunk(chunk) {
  if (pcmStopped) return
  const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length)
  if (pcmBatch.length >= PCM_MAX_BUFFERED) {
    pcmBatch.shift()
  }
  pcmBatch.push(ab)
  if (!pcmDrainTimer) {
    pcmDrainTimer = setTimeout(drainPcmBatch, PCM_BATCH_INTERVAL_MS)
    pcmDrainTimer.unref()
  }
}

async function pollPlaybackState() {
  if (pollInProgress) return
  pollInProgress = true
  const creds = getSpotifyCredentialsRaw()
  if (!creds || !currentWindow || currentWindow.isDestroyed()) {
    pollInProgress = false
    return
  }
  try {
    await ensureValidToken()
    const res = await fetchWithTimeout('https://api.spotify.com/v1/me/player', {
      headers: { 'Authorization': 'Bearer ' + creds.accessToken }
    })
    if (res.status === 204) {
      if (currentWindow && !currentWindow.isDestroyed()) {
        currentWindow.webContents.send('spotify-poll', { success: true, data: null })
      }
      return
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After')
      const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 10000
      stopPlaybackPolling()
      pollTimer = setTimeout(() => {
        pollTimer = null
        startPlaybackPolling()
      }, delay)
      return
    }
    if (!res.ok) {
      const err = await res.text()
      console.warn('[librespot-main] Poll error:', res.status, err)
      return
    }
    const data = await res.json()
    if (currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.webContents.send('spotify-poll', { success: true, data })
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[librespot-main] Poll timed out')
    } else {
      console.warn('[librespot-main] Poll exception:', err.message)
    }
  } finally {
    pollInProgress = false
  }
}

function startPlaybackPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setInterval(pollPlaybackState, 5000)
}

function stopPlaybackPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

async function loadOrCreateDeviceId() {
  if (deviceId) return deviceId
  try {
    await fs.access(DEVICE_ID_FILE)
    const raw = await fs.readFile(DEVICE_ID_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (data.deviceId) {
      deviceId = data.deviceId
      return deviceId
    }
  } catch (_) {}
  const id = 'thevibezmachine-' + Math.random().toString(36).substring(2, 15)
  deviceId = id
  try {
    await fs.writeFile(DEVICE_ID_FILE, JSON.stringify({ deviceId: id }))
  } catch (e) {
    console.warn('[librespot-main] Failed to persist device ID:', e.message)
  }
  return id
}

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
      timer.unref()
    })
  ]).finally(() => clearTimeout(timer))
}

async function initLibrespot(win) {
  if (initInProgress) return
  initInProgress = true
  currentWindow = win
  const creds = getSpotifyCredentialsRaw()
  if (!creds || !creds.accessToken || !creds.clientId) {
    initInProgress = false
    return
  }

  try {
    await ensureValidToken()
  } catch (e) {
    console.error('[librespot-main] Token refresh failed:', e.message)
    initInProgress = false
    return
  }

  const freshCreds = getSpotifyCredentialsRaw()

  stopPlaybackPolling()

  if (librespotHost) {
    try {
      librespotHost.shutdown()
    } catch (_) {}
    librespotHost = null
  }

  deviceId = null
  pcmStopped = true
  deviceId = await loadOrCreateDeviceId()
  pcmStopped = false

  if (!librespot) {
    initInProgress = false
    return
  }

  try {
    librespot.setLogLevel('info')

    const loginResult = await withTimeout(
      librespot.loginWithAccessToken(freshCreds.accessToken, 'TheVibezMachine'),
      NATIVE_TIMEOUT_MS
    )

    await fs.writeFile(CREDENTIALS_FILE, loginResult.credentialsJson, { mode: 0o600 })

    librespotHost = await withTimeout(
      librespot.startConnectDeviceWithCredentials(
        CREDENTIALS_FILE,
        'TheVibezMachine',
        deviceId,
        (chunk) => {
          queuePcmChunk(chunk)
        },
        (event) => {
          if (event.type === 'health' || event.type === 'metric') {
            if (currentWindow && !currentWindow.isDestroyed()) {
              currentWindow.webContents.send('spotify-event', { type: event.type, keepalive: true })
            }
            return
          }
          if (currentWindow && !currentWindow.isDestroyed()) {
            currentWindow.webContents.send('spotify-event', event)
          }
        },
        null
      ),
      NATIVE_TIMEOUT_MS
    )
    lastReconnectFailTime = 0
    startPlaybackPolling()
    if (currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.webContents.send('spotify-event', { type: 'ready' })
    }
  } catch (err) {
    console.error('[librespot-main] Failed to start Connect device:', err.message || err)
    lastReconnectFailTime = Date.now()
    if (librespotHost) {
      try { librespotHost.shutdown() } catch (_) {}
      librespotHost = null
    }
  } finally {
    initInProgress = false
  }
}

function stopLibrespot() {
  stopPlaybackPolling()
  pcmStopped = true
  if (pcmDrainTimer) {
    clearTimeout(pcmDrainTimer)
    pcmDrainTimer = null
  }
  pcmBatch = []
  if (librespotHost) {
    try {
      librespotHost.shutdown()
    } catch (_) {}
    librespotHost = null
  }
  deviceId = null
  fs.unlink(CREDENTIALS_FILE).catch(() => {})
}

async function reconnectLibrespot() {
  if (reconnectInProgress || !currentWindow || currentWindow.isDestroyed()) return false
  if (Date.now() - lastReconnectFailTime < RECONNECT_COOLDOWN_MS) {
    console.warn('[librespot-main] Skipping reconnect — cooldown active')
    return false
  }
  reconnectInProgress = true
  console.log('[librespot-main] Attempting to reconnect Spotify Connect device...')
  try {
    await initLibrespot(currentWindow)
    if (librespotHost) {
      console.log('[librespot-main] Reconnection successful')
      return true
    }
    console.warn('[librespot-main] Reconnection failed — no librespot host')
    return false
  } catch (err) {
    console.error('[librespot-main] Reconnection error:', err.message)
    return false
  } finally {
    reconnectInProgress = false
  }
}

function getLibrespotDeviceId() {
  return deviceId
}

function clearReconnectCooldown() {
  lastReconnectFailTime = 0
}

async function spotifyApiPlayPause(action) {
  const creds = getSpotifyCredentialsRaw()
  if (!creds) return { success: false, error: 'Not authenticated' }
  if (!deviceId) return { success: false, error: 'No device ID' }
  try {
    await ensureValidToken()
    const url = 'https://api.spotify.com/v1/me/player/' + action + '?device_id=' + encodeURIComponent(deviceId)
    const options = {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + creds.accessToken }
    }
    const res = await fetchWithTimeout(url, options)
    if (res.status === 204 || res.status === 202) {
      return { success: true, state: action === 'play' ? 'playing' : 'paused' }
    }
    if (res.status === 404) {
      return { success: false, error: 'NO_ACTIVE_DEVICE', status: 404 }
    }
    const err = await res.text()
    return { success: false, error: `Spotify API error ${res.status}: ${err}` }
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, error: 'Request timed out' }
    return { success: false, error: err.message }
  }
}

async function spotifyApiSeek(positionMs) {
  const creds = getSpotifyCredentialsRaw()
  if (!creds) return { success: false, error: 'Not authenticated' }
  if (!deviceId) return { success: false, error: 'No device ID' }
  try {
    await ensureValidToken()
    const url = 'https://api.spotify.com/v1/me/player/seek?position_ms=' + Math.floor(positionMs) + '&device_id=' + encodeURIComponent(deviceId)
    const res = await fetchWithTimeout(url, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + creds.accessToken } })
    if (res.status === 204 || res.status === 202) {
      return { success: true }
    }
    if (res.status === 404) {
      return { success: false, error: 'NO_ACTIVE_DEVICE', status: 404 }
    }
    const err = await res.text()
    return { success: false, error: `Spotify API error ${res.status}: ${err}` }
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, error: 'Request timed out' }
    return { success: false, error: err.message }
  }
}

async function spotifyApiPlayTrack(trackUri, positionMs) {
  const creds = getSpotifyCredentialsRaw()
  if (!creds) return { success: false, error: 'Not authenticated' }
  if (!deviceId) return { success: false, error: 'No device ID' }
  try {
    await ensureValidToken()
    const url = 'https://api.spotify.com/v1/me/player/play?device_id=' + encodeURIComponent(deviceId)
    const body = {
      uris: [trackUri],
      position_ms: Math.floor(positionMs)
    }
    const res = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + creds.accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    if (res.status === 204 || res.status === 202) {
      return { success: true, state: 'playing' }
    }
    if (res.status === 404) {
      return { success: false, error: 'NO_ACTIVE_DEVICE', status: 404 }
    }
    const err = await res.text()
    return { success: false, error: `Spotify API error ${res.status}: ${err}` }
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, error: 'Request timed out' }
    return { success: false, error: err.message }
  }
}

function registerLibrespotIpcs(ipcMain) {
  ipcMain.handle('librespot-pause', async () => {
    let apiResult = await spotifyApiPlayPause('pause')

    // Auto-reconnect if the device was dropped (404 = no active device)
    if (apiResult.error === 'NO_ACTIVE_DEVICE') {
      const reconnected = await reconnectLibrespot()
      if (reconnected) {
        apiResult = await spotifyApiPlayPause('pause')
      }
    }

    if (apiResult.success) return apiResult
    if (!librespotHost) return { success: false, error: apiResult.error }
    try {
      librespotHost.pause()
      return { success: true, state: 'paused' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('librespot-play', async (_event, positionMs, trackUri) => {
    // When we know the track URI and a resume position, use the explicit
    // /v1/me/player/play endpoint with { uris, position_ms } in the body.
    // This is a single atomic call that starts playback at the exact
    // position, avoiding the race condition of play-then-seek or
    // seek-then-play where the track can skip before the seek lands.
    if (trackUri && positionMs != null) {
      let explicitResult = await spotifyApiPlayTrack(trackUri, positionMs)
      if (explicitResult.error === 'NO_ACTIVE_DEVICE') {
        const reconnected = await reconnectLibrespot()
        if (reconnected) {
          explicitResult = await spotifyApiPlayTrack(trackUri, positionMs)
        }
      }
      if (explicitResult.success) return explicitResult
      // Fall through to generic play as a last resort
      console.warn('[librespot-main] Explicit play with position failed, falling back to generic play:', explicitResult.error)
    }

    // Fallback: try seek-before-play. If the device is active and paused,
    // the seek may stick; if not, the play will at least get audio going.
    if (positionMs != null) {
      let seekResult = await spotifyApiSeek(positionMs)
      if (seekResult.error === 'NO_ACTIVE_DEVICE') {
        const reconnected = await reconnectLibrespot()
        if (reconnected) {
          seekResult = await spotifyApiSeek(positionMs)
        }
      }
      // Log seek failure but continue — play might still work
      if (!seekResult.success) {
        console.warn('[librespot-main] Pre-play seek failed:', seekResult.error)
      }
    }

    let apiResult = await spotifyApiPlayPause('play')

    if (apiResult.error === 'NO_ACTIVE_DEVICE') {
      const reconnected = await reconnectLibrespot()
      if (reconnected) {
        apiResult = await spotifyApiPlayPause('play')
      }
    }

    if (apiResult.success) return apiResult
    if (!librespotHost) return { success: false, error: apiResult.error }
    try {
      librespotHost.play()
      return { success: true, state: 'playing' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('librespot-next', async () => {
    if (!deviceId) return { success: false, error: 'No device ID' }
    const creds = getSpotifyCredentialsRaw()
    if (!creds) return { success: false, error: 'Not authenticated' }
    try {
      await ensureValidToken()
      const res = await fetchWithTimeout('https://api.spotify.com/v1/me/player/next?device_id=' + encodeURIComponent(deviceId), {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + creds.accessToken }
      })
      if (res.status === 204 || res.status === 202) {
        return { success: true }
      }
      if (res.status === 404 && librespotHost && typeof librespotHost.next === 'function') {
        try {
          librespotHost.next()
          return { success: true }
        } catch (e) {
          return { success: false, error: e.message }
        }
      }
      const err = await res.text()
      return { success: false, error: `Spotify API error ${res.status}: ${err}` }
    } catch (err) {
      if (err.name === 'AbortError') return { success: false, error: 'Request timed out' }
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('librespot-prev', async () => {
    if (!deviceId) return { success: false, error: 'No device ID' }
    const creds = getSpotifyCredentialsRaw()
    if (!creds) return { success: false, error: 'Not authenticated' }
    try {
      await ensureValidToken()
      const res = await fetchWithTimeout('https://api.spotify.com/v1/me/player/previous?device_id=' + encodeURIComponent(deviceId), {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + creds.accessToken }
      })
      if (res.status === 204 || res.status === 202) {
        return { success: true }
      }
      if (res.status === 404 && librespotHost && typeof librespotHost.prev === 'function') {
        try {
          librespotHost.prev()
          return { success: true }
        } catch (e) {
          return { success: false, error: e.message }
        }
      }
      const err = await res.text()
      return { success: false, error: `Spotify API error ${res.status}: ${err}` }
    } catch (err) {
      if (err.name === 'AbortError') return { success: false, error: 'Request timed out' }
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('librespot-seek', async (_event, positionMs) => {
    if (!deviceId) return { success: false, error: 'No device ID' }
    const creds = getSpotifyCredentialsRaw()
    if (!creds) return { success: false, error: 'Not authenticated' }
    try {
      await ensureValidToken()
      const res = await fetchWithTimeout('https://api.spotify.com/v1/me/player/seek?position_ms=' + Math.floor(positionMs) + '&device_id=' + encodeURIComponent(deviceId), {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + creds.accessToken
        }
      })
      if (res.status === 204 || res.status === 202) {
        return { success: true }
      }
      const err = await res.text()
      return { success: false, error: `Spotify API error ${res.status}: ${err}` }
    } catch (err) {
      if (err.name === 'AbortError') return { success: false, error: 'Request timed out' }
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-librespot-device-id', () => {
    return getLibrespotDeviceId()
  })

  ipcMain.handle('reconnect-librespot', async () => {
    const result = await reconnectLibrespot()
    return result ? { success: true } : { success: false, error: 'Reconnection failed' }
  })
}

module.exports = { initLibrespot, stopLibrespot, getLibrespotDeviceId, reconnectLibrespot, clearReconnectCooldown, registerLibrespotIpcs }