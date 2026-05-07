const { startConnectDeviceWithCredentials, loginWithAccessToken, setLogLevel } = require('@lox-audioserver/node-librespot')
const { getSpotifyCredentialsRaw, ensureValidToken } = require('./spotifyAuth')
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const DEVICE_ID_FILE = path.join(app.getPath('userData'), '.spotify-device-id.json')

let librespotHost = null
let currentWindow = null
let deviceId = null
let librespotCredentials = null
let mainSpotifyIsPlaying = false

function loadOrCreateDeviceId() {
  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      const data = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'))
      if (data.deviceId) return data.deviceId
    }
  } catch (_) {}
  const id = 'thevibezmachine-' + Math.random().toString(36).substring(2, 15)
  try {
    fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ deviceId: id }))
  } catch (_) {}
  return id
}

async function initLibrespot(win) {
  currentWindow = win
  const creds = getSpotifyCredentialsRaw()
  if (!creds || !creds.accessToken || !creds.clientId) {
    console.log('[librespot-main] No credentials available, skipping init')
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

  try {
    setLogLevel('info')

    const loginResult = await loginWithAccessToken(freshCreds.accessToken, 'TheVibezMachine')
    console.log('[librespot-main] Login success for user:', loginResult.username)
    librespotCredentials = loginResult.credentialsJson

    const credsFile = path.join(app.getPath('userData'), '.spotify-librespot-creds.json')
    fs.writeFileSync(credsFile, librespotCredentials)

    console.log('[librespot-main] Starting Connect device with deviceId:', deviceId)
    librespotHost = await startConnectDeviceWithCredentials(
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
        if (event.type === 'playing') {
          mainSpotifyIsPlaying = true
        } else if (event.type === 'paused' || event.type === 'stopped' || event.type === 'end_of_track') {
          mainSpotifyIsPlaying = false
        }

        if (event.type === 'health' || event.type === 'metric') {
          if (currentWindow && !currentWindow.isDestroyed()) {
            currentWindow.webContents.send('spotify-event', event)
          }
          return
        }
        console.log('[librespot-main] Event:', event.type, event)
        if (currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.webContents.send('spotify-event', event)
        }
      },
      (log) => {
        console.log('[librespot]', log.level, `[${log.scope}]`, log.message)
      }
    )
    console.log('[librespot-main] Connect device started successfully:', deviceId)
  } catch (err) {
    console.error('[librespot-main] Failed to start Connect device:', err)
  }
}

function stopLibrespot() {
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

function registerLibrespotIpcs(ipcMain) {
  ipcMain.handle('librespot-pause', () => {
    if (!librespotHost) return { success: false, error: 'Not connected', state: mainSpotifyIsPlaying ? 'playing' : 'paused' }
    if (!mainSpotifyIsPlaying) return { success: true, state: 'paused' }
    try {
      librespotHost.pause()
      return { success: true, state: 'paused' }
    } catch (e) {
      return { success: false, error: e.message, state: mainSpotifyIsPlaying ? 'playing' : 'paused' }
    }
  })

  ipcMain.handle('librespot-play', () => {
    if (!librespotHost) return { success: false, error: 'Not connected', state: mainSpotifyIsPlaying ? 'playing' : 'paused' }
    if (mainSpotifyIsPlaying) return { success: true, state: 'playing' }
    try {
      librespotHost.play()
      return { success: true, state: 'playing' }
    } catch (e) {
      return { success: false, error: e.message, state: mainSpotifyIsPlaying ? 'playing' : 'paused' }
    }
  })

  ipcMain.handle('librespot-next', () => {
    if (!librespotHost) return { success: false, error: 'Not connected', state: mainSpotifyIsPlaying ? 'playing' : 'paused' }
    try {
      librespotHost.next()
      return { success: true, state: mainSpotifyIsPlaying ? 'playing' : 'paused' }
    } catch (e) {
      return { success: false, error: e.message, state: mainSpotifyIsPlaying ? 'playing' : 'paused' }
    }
  })

  ipcMain.handle('librespot-prev', async () => {
    const creds = getSpotifyCredentialsRaw()
    if (!creds) return { success: false, error: 'Not authenticated', state: mainSpotifyIsPlaying ? 'playing' : 'paused' }
    try {
      await ensureValidToken()
      const res = await fetch('https://api.spotify.com/v1/me/player/previous', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + creds.accessToken }
      })
      if (res.status === 204 || res.status === 202) {
        return { success: true, state: mainSpotifyIsPlaying ? 'playing' : 'paused' }
      }
      const err = await res.text()
      return { success: false, error: `Spotify API error ${res.status}: ${err}`, state: mainSpotifyIsPlaying ? 'playing' : 'paused' }
    } catch (err) {
      return { success: false, error: err.message, state: mainSpotifyIsPlaying ? 'playing' : 'paused' }
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

  ipcMain.handle('librespot-set-volume', (_event, volume) => {
    if (currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.webContents.send('librespot-volume', volume)
    }
    return { success: true }
  })

  ipcMain.handle('get-librespot-device-id', () => {
    return getLibrespotDeviceId()
  })
}

module.exports = { initLibrespot, stopLibrespot, getLibrespotDeviceId, registerLibrespotIpcs }
