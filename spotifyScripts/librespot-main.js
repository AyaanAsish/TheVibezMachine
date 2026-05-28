let librespot = null
try {
  librespot = require('@lox-audioserver/node-librespot')
} catch (err) {
  console.error('[librespot-main] Failed to load native module:', err.message)
}

const { getSpotifyCredentialsRaw, ensureValidToken, spotifyPut } = require('./spotifyAuth')
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const DEVICE_ID_FILE = path.join(app.getPath('userData'), '.spotify-device-id.json')

let librespotHost = null
let currentWindow = null
let deviceId = null
let librespotCredentials = null
let pollInterval = null

async function pollPlaybackState() {
  const creds = getSpotifyCredentialsRaw()
  if (!creds || !currentWindow || currentWindow.isDestroyed()) return
  try {
    await ensureValidToken()
    const res = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { 'Authorization': 'Bearer ' + creds.accessToken }
    })
    if (res.status === 204) {
      currentWindow.webContents.send('spotify-poll', { success: true, data: null })
      return
    }
    if (res.status === 429) {
      return
    }
    if (!res.ok) {
      const err = await res.text()
      console.warn('[librespot-main] Poll error:', res.status, err)
      return
    }
    const data = await res.json()
    currentWindow.webContents.send('spotify-poll', { success: true, data })
  } catch (err) {
    console.warn('[librespot-main] Poll exception:', err.message)
  }
}

function startPlaybackPolling() {
  if (pollInterval) clearInterval(pollInterval)
  pollInterval = setInterval(pollPlaybackState, 5000)
}

function stopPlaybackPolling() {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

async function ensureDeviceActive() {
  const creds = getSpotifyCredentialsRaw()
  if (!creds) return { success: false, error: 'Not authenticated' }
  if (!deviceId) return { success: false, error: 'No device ID' }
  try {
    await ensureValidToken()
    const res = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { 'Authorization': 'Bearer ' + creds.accessToken }
    })
    if (res.status === 204) {
      // No active device — transfer to ours
      return spotifyPut('/me/player', { device_ids: [deviceId], play: false })
    }
    if (!res.ok) {
      const err = await res.text()
      return { success: false, error: `Spotify API error ${res.status}: ${err}` }
    }
    const data = await res.json()
    if (data.device && data.device.id === deviceId) {
      return { success: true }
    }
    // Active device is not ours — transfer
    return spotifyPut('/me/player', { device_ids: [deviceId], play: false })
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function loadOrCreateDeviceId() {
  if (deviceId) return deviceId
  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      const data = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'))
      if (data.deviceId) {
        deviceId = data.deviceId
        return deviceId
      }
    }
  } catch (_) {}
  const id = 'thevibezmachine-' + Math.random().toString(36).substring(2, 15)
  deviceId = id
  try {
    fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ deviceId: id }))
  } catch (_) {}
  return id
}

async function initLibrespot(win) {
  currentWindow = win
  const creds = getSpotifyCredentialsRaw()
  if (!creds || !creds.accessToken || !creds.clientId) {
    return
  }

  try {
    await ensureValidToken()
  } catch (e) {
    console.error('[librespot-main] Token refresh failed:', e.message)
    return
  }

  const freshCreds = getSpotifyCredentialsRaw()

  if (librespotHost) {
    try {
      librespotHost.shutdown()
    } catch (_) {}
    librespotHost = null
  }

  deviceId = loadOrCreateDeviceId()

  if (!librespot) {
    return
  }

  try {
    librespot.setLogLevel('info')

    const loginResult = await librespot.loginWithAccessToken(freshCreds.accessToken, 'TheVibezMachine')
    librespotCredentials = loginResult.credentialsJson

    const credsFile = path.join(app.getPath('userData'), '.spotify-librespot-creds.json')
    fs.writeFileSync(credsFile, librespotCredentials)

    librespotHost = await librespot.startConnectDeviceWithCredentials(
      credsFile,
      'TheVibezMachine',
      deviceId,
      (chunk) => {
        if (currentWindow && !currentWindow.isDestroyed()) {
          const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length)
          currentWindow.webContents.send('spotify-pcm', ab)
        }
      },
      (event) => {
        if (event.type === 'health' || event.type === 'metric') {
          if (currentWindow && !currentWindow.isDestroyed()) {
            currentWindow.webContents.send('spotify-event', event)
          }
          return
        }
        if (currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.webContents.send('spotify-event', event)
        }
      },
      null
    )
    startPlaybackPolling()
  } catch (err) {
    console.error('[librespot-main] Failed to start Connect device:', err)
  }
}

function stopLibrespot() {
  stopPlaybackPolling()
  if (librespotHost) {
    try {
      librespotHost.shutdown()
    } catch (_) {}
    librespotHost = null
  }
  deviceId = null
  librespotCredentials = null
}

function getLibrespotDeviceId() {
  return deviceId
}

async function spotifyApiPlayPause(action) {
  const creds = getSpotifyCredentialsRaw()
  if (!creds) return { success: false, error: 'Not authenticated' }
  if (!deviceId) return { success: false, error: 'No device ID' }
  try {
    await ensureValidToken()
    const url = 'https://api.spotify.com/v1/me/player/' + action + '?device_id=' + encodeURIComponent(deviceId)
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + creds.accessToken }
    })
    if (res.status === 204 || res.status === 202) {
      return { success: true, state: action === 'play' ? 'playing' : 'paused' }
    }
    if (res.status === 404) {
      return { success: false, error: 'NO_ACTIVE_DEVICE', status: 404 }
    }
    const err = await res.text()
    return { success: false, error: `Spotify API error ${res.status}: ${err}` }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function registerLibrespotIpcs(ipcMain) {
  ipcMain.handle('librespot-pause', async () => {
    const apiResult = await spotifyApiPlayPause('pause')
    if (apiResult.success) return apiResult
    if (!librespotHost) return { success: false, error: apiResult.error }
    try {
      librespotHost.pause()
      return { success: true, state: 'paused' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('librespot-play', async () => {
    const apiResult = await spotifyApiPlayPause('play')
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
    if (librespotHost && typeof librespotHost.next === 'function') {
      try {
        librespotHost.next()
        return { success: true }
      } catch (e) {
        return { success: false, error: e.message }
      }
    }
    const creds = getSpotifyCredentialsRaw()
    if (!creds) return { success: false, error: 'Not authenticated' }
    try {
      await ensureValidToken()
      const res = await fetch('https://api.spotify.com/v1/me/player/next', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + creds.accessToken }
      })
      if (res.status === 204 || res.status === 202) {
        return { success: true }
      }
      const err = await res.text()
      return { success: false, error: `Spotify API error ${res.status}: ${err}` }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('librespot-prev', async () => {
    if (librespotHost && typeof librespotHost.prev === 'function') {
      try {
        librespotHost.prev()
        return { success: true }
      } catch (e) {
        return { success: false, error: e.message }
      }
    }
    const creds = getSpotifyCredentialsRaw()
    if (!creds) return { success: false, error: 'Not authenticated' }
    try {
      await ensureValidToken()
      const res = await fetch('https://api.spotify.com/v1/me/player/previous', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + creds.accessToken }
      })
      if (res.status === 204 || res.status === 202) {
        return { success: true }
      }
      const err = await res.text()
      return { success: false, error: `Spotify API error ${res.status}: ${err}` }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('librespot-seek', async (_event, positionMs) => {
    const creds = getSpotifyCredentialsRaw()
    if (!creds) return { success: false, error: 'Not authenticated' }
    try {
      await ensureValidToken()
      const res = await fetch('https://api.spotify.com/v1/me/player/seek?position_ms=' + Math.floor(positionMs), {
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
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-librespot-device-id', () => {
    return getLibrespotDeviceId()
  })
}

module.exports = { initLibrespot, stopLibrespot, getLibrespotDeviceId, registerLibrespotIpcs }
