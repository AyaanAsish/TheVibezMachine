const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { app, shell } = require('electron')

const TOKEN_FILE = path.join(app.getPath('userData'), '.spotify-auth.json')
let spotifyCredentials = null

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
      spotifyCredentials = {
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiry: data.tokenExpiry
      }
      console.log('[spotifyAuth] Loaded tokens from disk')
    }
  } catch (e) {
    console.error('[spotifyAuth] Failed to load tokens:', e.message)
    spotifyCredentials = null
  }
}

function saveTokens() {
  try {
    if (spotifyCredentials) {
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(spotifyCredentials, null, 2))
    } else if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE)
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

function onAuthSuccess(cb) {
  onAuthSuccessCallback = cb
}

function spotifyAuthHtml(title, message) {
  return `<html><head><style>
    body { display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif; background: #191414; color: white; }
    .center { text-align: center; }
  </style></head><body>
    <div class="center"><h1>${title}</h1><p>${message}</p></div></body></html>`
}

function generateRandomString(length) {
  return crypto.randomBytes(length).toString('hex')
}

function getSpotifyAuthUrl(clientId) {
  spotifyAuthState = generateRandomString(16)
  return `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT)}&scope=${encodeURIComponent(SPOTIFY_SCOPE)}&state=${spotifyAuthState}`
}

async function exchangeSpotifyToken(clientId, clientSecret, code) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
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
    throw new Error(`Token exchange failed: ${response.status}`)
  }

  const tokenData = await response.json()
  spotifyCredentials = {
    clientId,
    clientSecret,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    tokenExpiry: Date.now() + (tokenData.expires_in * 1000)
  }
  saveTokens()
  return tokenData
}

async function ensureValidToken() {
  if (!spotifyCredentials) return
  if (Date.now() < spotifyCredentials.tokenExpiry - 60000) return

  const { clientId, clientSecret, refreshToken } = spotifyCredentials
  const response = await fetch('https://accounts.spotify.com/api/token', {
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
    throw new Error('Token refresh failed: ' + response.status)
  }

  const tokenData = await response.json()
  spotifyCredentials.accessToken = tokenData.access_token
  spotifyCredentials.tokenExpiry = Date.now() + (tokenData.expires_in * 1000)
  if (tokenData.refresh_token) {
    spotifyCredentials.refreshToken = tokenData.refresh_token
  }
  saveTokens()
}

async function spotifyApi(_event, endpoint) {
  if (!spotifyCredentials) {
    return { success: false, error: 'Not authenticated with Spotify' }
  }

  try {
    await ensureValidToken()
    const res = await fetch('https://api.spotify.com/v1' + endpoint, {
      headers: { 'Authorization': 'Bearer ' + spotifyCredentials.accessToken }
    })
    if (!res.ok) {
      const errBody = await res.text()
      return { success: false, error: `Spotify API error ${res.status}: ${errBody}` }
    }
    const data = await res.json()
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

async function spotifyTransferPlayback(_event, deviceId, shouldPlay = false) {
  if (!spotifyCredentials) {
    return { success: false, error: 'Not authenticated with Spotify' }
  }
  try {
    await ensureValidToken()
    const res = await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + spotifyCredentials.accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ device_ids: [deviceId], play: shouldPlay })
    })
    if (res.status === 204 || res.status === 202) {
      return { success: true }
    }
    const err = await res.text()
    return { success: false, error: `Spotify API error ${res.status}: ${err}` }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

async function spotifyPlayTrack(_event, uri, deviceId) {
  if (!spotifyCredentials) {
    return { success: false, error: 'Not authenticated with Spotify' }
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
    return { success: false, error: `Spotify API error ${res.status}: ${err}` }
  } catch (err) {
    return { success: false, error: err.message }
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

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`)

      if (url.searchParams.has('error')) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(spotifyAuthHtml('Authorization Failed', url.searchParams.get('error')))
        if (pendingSpotifyAuth) {
          const pending = pendingSpotifyAuth
          pendingSpotifyAuth = null
          spotifyCallbackServer = null
          server.close()
          pending.resolve({ success: false, error: url.searchParams.get('error') })
        }
        return
      }

      if (url.pathname === '/' && url.searchParams.has('code')) {
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')

        if (state !== spotifyAuthState) {
          res.writeHead(403, { 'Content-Type': 'text/html' })
          res.end(spotifyAuthHtml('Security Error', 'Invalid state parameter.'))
          if (pendingSpotifyAuth) {
            const pending = pendingSpotifyAuth
            pendingSpotifyAuth = null
            spotifyCallbackServer = null
            server.close()
            pending.resolve({ success: false, error: 'Invalid state parameter' })
          }
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
          <html>
            <head><style>
              body { display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif; background: #191414; color: white; }
              .center { text-align: center; }
            </style></head>
            <body>
              <div class="center">
                <h1>Spotify Connected!</h1>
                <p>You can close this window and return to the app.</p>
              </div>
            </body>
          </html>
        `)

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
              spotifyCallbackServer = null
            }, 2000)
            pendingSpotifyAuth = null
          })
      } else {
        res.writeHead(404)
        res.end('Not found - expected /?code=...')
      }
    })

    server.on('error', (err) => {
      console.error('Spotify callback server error:', err.message)
      if (pendingSpotifyAuth) {
        const pending = pendingSpotifyAuth
        pendingSpotifyAuth = null
        pending.resolve({ success: false, error: 'Callback server error: ' + err.message })
      }
      spotifyCallbackServer = null
    })

    spotifyCallbackServer = server
    server.listen(8080, '127.0.0.1', () => {
      console.log('Spotify callback server listening on port 8080')
    })

    setTimeout(() => {
      if (pendingSpotifyAuth) {
        server.close()
        spotifyCallbackServer = null
        pendingSpotifyAuth = null
        resolve({ success: false, error: 'Timeout - user did not authorize' })
      }
    }, 120000)
  })
}

async function getSpotifyCredentials() {
  await ensureValidToken()
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
  try {
    spotifyCredentials = null
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE)
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
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

module.exports = { registerSpotifyIpcs, getSpotifyCredentialsRaw, onAuthSuccess, ensureValidToken }
