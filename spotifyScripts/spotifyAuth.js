const http = require('http')
const crypto = require('crypto')
const fs = require('fs/promises')
const fsSync = require('fs')
const path = require('path')
const { app, shell } = require('electron')

const TOKEN_FILE = path.join(app.getPath('userData'), '.spotify-auth.json')
const FETCH_TIMEOUT_MS = 15000
let spotifyCredentials = null
let refreshPromise = null

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function loadTokens() {
  try {
    if (fsSync.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fsSync.readFileSync(TOKEN_FILE, 'utf8'))
      if (!data.refreshToken || !data.accessToken || !data.clientId) {
        spotifyCredentials = null
        return
      }
      spotifyCredentials = {
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiry: data.tokenExpiry
      }
    }
  } catch (e) {
    console.error('[spotifyAuth] Failed to load tokens:', e.message)
    spotifyCredentials = null
  }
}

async function saveTokens() {
  try {
    if (spotifyCredentials) {
      await fs.writeFile(TOKEN_FILE, JSON.stringify(spotifyCredentials, null, 2))
    } else if (fsSync.existsSync(TOKEN_FILE)) {
      await fs.unlink(TOKEN_FILE)
    }
  } catch (e) {
    console.error('[spotifyAuth] Failed to save tokens:', e.message)
  }
}

loadTokens()

const SPOTIFY_REDIRECT = 'http://127.0.0.1:8080'
const SPOTIFY_SCOPE = 'user-read-private user-read-email user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-library-read streaming'

let pendingSpotifyAuth = null
let onAuthSuccessCallback = null
let spotifyCallbackServer = null
let spotifyAuthState = null
let reconnectLibrespotFn = null

function onAuthSuccess(cb) {
  onAuthSuccessCallback = cb
}

function setReconnectFn(fn) {
  reconnectLibrespotFn = fn
}

function friendlyApiError(status, body) {
  const b = String(body || '').toLowerCase()
  if (status === 401 || b.includes('invalid_client')) return 'Invalid Spotify credentials - check your Client ID and Secret'
  if (status === 403) return 'You don\'t have permission for this on Spotify'
  if (status === 404) return 'Spotify device not found - your network may be blocking Spotify'
  if (status === 429) return 'Too many requests - wait a moment and try again'
  if (status >= 500) return 'Spotify is having issues - try again in a moment'
  return 'Something went wrong - try again'
}

function spotifyAuthHtml(title, message) {
  return `<html><head><style>
    body { display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif; background: #191414; color: white; }
    .center { text-align: center; }
  </style></head><body>
    <div class="center"><h1>${escHtml(title)}</h1><p>${escHtml(message)}</p></div></body></html>`
}

function generateRandomString(length) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)
}

function getSpotifyAuthUrl(clientId) {
  spotifyAuthState = generateRandomString(16)
  return `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT)}&scope=${encodeURIComponent(SPOTIFY_SCOPE)}&state=${spotifyAuthState}`
}

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout))
}

async function exchangeSpotifyToken(clientId, clientSecret, code) {
  const response = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64')
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: SPOTIFY_REDIRECT
    })
  })

  if (!response.ok) {
    throw new Error(friendlyApiError(response.status, await response.text()))
  }

  const tokenData = await response.json()
  spotifyCredentials = {
    clientId,
    clientSecret,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    tokenExpiry: Date.now() + (tokenData.expires_in * 1000)
  }
  await saveTokens()
  return tokenData
}

async function ensureValidToken() {
  if (!spotifyCredentials) return
  if (Date.now() < spotifyCredentials.tokenExpiry - 60000) return
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    const { clientId, clientSecret, refreshToken } = spotifyCredentials
    const response = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    })

    if (!response.ok) {
      throw new Error(friendlyApiError(response.status, await response.text()))
    }

    const tokenData = await response.json()
    spotifyCredentials.accessToken = tokenData.access_token
    spotifyCredentials.tokenExpiry = Date.now() + (tokenData.expires_in * 1000)
    if (tokenData.refresh_token) {
      spotifyCredentials.refreshToken = tokenData.refresh_token
    }
    await saveTokens()
  })().finally(() => { refreshPromise = null })

  return refreshPromise
}

async function spotifyApi(_event, endpoint) {
  if (!spotifyCredentials) {
    return { success: false, error: 'Sign in to Spotify first' }
  }
  if (!endpoint) {
    return { success: false, error: 'Something went wrong - try again' }
  }

  try {
    await ensureValidToken()
    const res = await fetchWithTimeout('https://api.spotify.com/v1' + endpoint, {
      headers: { 'Authorization': 'Bearer ' + spotifyCredentials.accessToken }
    })
    if (!res.ok) {
      const errBody = await res.text()
      return { success: false, error: friendlyApiError(res.status, errBody) }
    }
    const data = await res.json()
    return { success: true, data }
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, error: 'Connection timed out - check your internet and try again' }
    return { success: false, error: 'Something went wrong - try again' }
  }
}

async function spotifyPut(endpoint, body, query) {
  if (!spotifyCredentials) {
    return { success: false, error: 'Sign in to Spotify first' }
  }
  try {
    await ensureValidToken()
    const res = await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + spotifyCredentials.accessToken,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    })
    if (res.status === 204 || res.status === 202) {
      return { success: true }
    }
    const err = await res.text()
    return { success: false, error: friendlyApiError(res.status, err) }
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, error: 'Connection timed out - check your internet and try again' }
    return { success: false, error: 'Something went wrong - try again' }
  }
}

async function spotifyTransferPlayback(_event, deviceId, shouldPlay = false) {
  if (!deviceId) {
    return { success: false, error: 'No Spotify device connected - try reconnecting' }
  }
  return spotifyPut('/me/player', { device_ids: [deviceId], play: shouldPlay })
}

async function spotifyPlayTrack(_event, uri, deviceId) {
  if (!spotifyCredentials) {
    return { success: false, error: 'Sign in to Spotify first' }
  }
  try {
    await ensureValidToken()
    const url = 'https://api.spotify.com/v1/me/player/play' + (deviceId ? '?device_id=' + encodeURIComponent(deviceId) : '')
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + spotifyCredentials.accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uris: [uri] })
    })
    if (res.status === 204 || res.status === 202) {
      return { success: true }
    }
    const err = await res.text()
    return { success: false, error: friendlyApiError(res.status, err) }
  } catch (err) {
    return { success: false, error: 'Something went wrong - try again' }
  }
}

async function spotifyAuth(_event, clientId, clientSecret) {
  return new Promise((resolve) => {
    if (spotifyCallbackServer) {
      spotifyCallbackServer.close()
      spotifyCallbackServer = null
    }

    const authUrl = getSpotifyAuthUrl(clientId)
    pendingSpotifyAuth = { clientId, clientSecret, resolve }
    shell.openExternal(authUrl)

    let authTimeoutId = null
    let resolved = false

    const server = http.createServer((req, res) => {
      let reqUrl
      try {
        reqUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1:8080'}`)
      } catch (_) {
        res.writeHead(400)
        res.end('Bad request')
        return
      }

      if (reqUrl.searchParams.has('error')) {
        const rawError = reqUrl.searchParams.get('error')
        const friendly = rawError === 'access_denied'
          ? 'Spotify access was denied - try connecting again'
          : 'Spotify login failed - try again'
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(spotifyAuthHtml('Authorization Failed', friendly))
        if (pendingSpotifyAuth) {
          const pending = pendingSpotifyAuth
          pendingSpotifyAuth = null
          spotifyCallbackServer = null
          if (authTimeoutId) clearTimeout(authTimeoutId)
          server.close()
          pending.resolve({ success: false, error: friendly })
        }
        return
      }

      if (reqUrl.pathname === '/' && reqUrl.searchParams.has('code')) {
        const code = reqUrl.searchParams.get('code')
        const state = reqUrl.searchParams.get('state')

        if (state !== spotifyAuthState) {
          res.writeHead(403, { 'Content-Type': 'text/html' })
          res.end(spotifyAuthHtml('Login Check Failed', 'Something went wrong during login - try connecting again'))
          if (pendingSpotifyAuth) {
            const pending = pendingSpotifyAuth
            pendingSpotifyAuth = null
            spotifyCallbackServer = null
            if (authTimeoutId) clearTimeout(authTimeoutId)
            server.close()
            pending.resolve({ success: false, error: 'Login check failed - try connecting again' })
          }
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(spotifyAuthHtml('Spotify Connected!', 'You can close this window and return to the app.'))

        pendingSpotifyAuth = null
        spotifyCallbackServer = null
        resolved = true
        if (authTimeoutId) clearTimeout(authTimeoutId)

        exchangeSpotifyToken(clientId, clientSecret, code)
          .then((tokenData) => {
            if (onAuthSuccessCallback) onAuthSuccessCallback()
            resolve({ success: true, ...tokenData })
          })
          .catch((err) => {
            resolve({ success: false, error: err.message })
          })
          .finally(() => {
            setTimeout(() => {
              server.close()
            }, 2000)
          })
      } else {
        res.writeHead(404)
        res.end('Page not found')
      }
    })

    server.on('error', (err) => {
      console.error('Spotify callback server error:', err.message)
      if (pendingSpotifyAuth) {
        const pending = pendingSpotifyAuth
        pendingSpotifyAuth = null
        if (authTimeoutId) clearTimeout(authTimeoutId)
        pending.resolve({ success: false, error: 'Could not start the login server - try again in a moment' })
      }
      spotifyCallbackServer = null
    })

    spotifyCallbackServer = server
    server.listen(8080, '127.0.0.1', () => {
    })

    authTimeoutId = setTimeout(() => {
      if (pendingSpotifyAuth && !resolved) {
        server.close()
        spotifyCallbackServer = null
        pendingSpotifyAuth = null
        resolve({ success: false, error: 'Spotify login timed out - try again' })
      }
    }, 120000)
  })
}

async function getSpotifyCredentials() {
  try { await ensureValidToken() } catch { return null }
  if (!spotifyCredentials) return null
  return {
    accessToken: spotifyCredentials.accessToken,
    refreshToken: spotifyCredentials.refreshToken,
    tokenExpiry: spotifyCredentials.tokenExpiry,
    clientId: spotifyCredentials.clientId
  }
}

function getSpotifyCredentialsRaw() {
  return spotifyCredentials
}

async function spotifyDisconnect() {
  if (pendingSpotifyAuth) {
    const pending = pendingSpotifyAuth
    pendingSpotifyAuth = null
    if (spotifyCallbackServer) {
      spotifyCallbackServer.close()
      spotifyCallbackServer = null
    }
    pending.resolve({ success: false, error: 'Disconnected during auth' })
  }
  try {
    spotifyCredentials = null
    if (fsSync.existsSync(TOKEN_FILE)) {
      await fs.unlink(TOKEN_FILE)
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: 'Could not disconnect from Spotify - try again' }
  }
}

function registerSpotifyIpcs(ipcMain) {
  ipcMain.handle('spotify-api', spotifyApi)
  ipcMain.handle('spotify-transfer-playback', spotifyTransferPlayback)
  ipcMain.handle('spotify-play-track', spotifyPlayTrack)
  ipcMain.handle('spotify-auth', spotifyAuth)
  ipcMain.handle('get-spotify-credentials', getSpotifyCredentials)
  ipcMain.handle('spotify-disconnect', spotifyDisconnect)
}

module.exports = { registerSpotifyIpcs, getSpotifyCredentialsRaw, onAuthSuccess, ensureValidToken, setReconnectFn, fetchWithTimeout }
