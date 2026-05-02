const http = require('http')
const crypto = require('crypto')

// Spotify OAuth configuration
const SPOTIFY_REDIRECT = 'http://127.0.0.1:8080'
const SPOTIFY_SCOPE = 'user-read-private user-read-email user-read-playback-state user-modify-playback-state playlist-read-private playlist-modify-public playlist-modify-private user-library-read streaming'

// Store for Spotify credentials
let spotifyCredentials = null
let pendingSpotifyAuth = null // { clientId, clientSecret, resolve }
let spotifyCallbackServer = null
let spotifyAuthState = null

// HTML templates for the external-browser OAuth callback pages
function spotifyAuthHtml(title, message) {
  return `<html><head><style>
    body { display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif; background: #191414; color: white; }
    .center { text-align: center; }
  </style></head><body>
    <div class="center"><h1>${title}</h1><p>${message}</p></div></body></html>`
}

// Generate random state for CSRF protection
function generateRandomString(length) {
  return crypto.randomBytes(length).toString('hex')
}

// Get Spotify authorization URL
function getSpotifyAuthUrl(clientId) {
  spotifyAuthState = generateRandomString(16)
  return `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT)}&scope=${encodeURIComponent(SPOTIFY_SCOPE)}&state=${spotifyAuthState}`
}

// Exchange code for tokens
async function exchangeSpotifyToken(clientId, clientSecret, code) {
  try {
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
    return tokenData
  } catch (err) {
    throw err
  }
}

// Ensure the Spotify access token is valid, refreshing if necessary
async function ensureValidToken() {
  if (!spotifyCredentials) return
  if (Date.now() < spotifyCredentials.tokenExpiry - 60000) return // 1 min buffer

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
}

// IPC handler to proxy Spotify API calls (avoids CORS in renderer)
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

// IPC handler to transfer playback to a specific device (makes it active)
async function spotifyTransferPlayback(_event, deviceId) {
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
      body: JSON.stringify({ device_ids: [deviceId], play: false })
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

// IPC handler to start playback of a specific track via Spotify Web API
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

// IPC handler to start Spotify OAuth flow
async function spotifyAuth(_event, clientId, clientSecret) {
  return new Promise((resolve) => {
    // Close any existing callback server to prevent EADDRINUSE
    if (spotifyCallbackServer) {
      spotifyCallbackServer.close()
      spotifyCallbackServer = null
    }

    const authUrl = getSpotifyAuthUrl(clientId)

    // Store credentials for when callback comes in
    pendingSpotifyAuth = { clientId, clientSecret, resolve }

    // Open browser for user to authorize
    const { shell } = require('electron')
    shell.openExternal(authUrl)

    // Start callback server
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`)

      // Handle Spotify error redirect (user denied access, etc.)
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

        // Verify CSRF state parameter
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
            <head>
              <style>
                body { display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif; background: #191414; color: white; }
                .center { text-align: center; }
              </style>
            </head>
            <body>
              <div class="center">
                <h1>Spotify Connected!</h1>
                <p>You can close this window and return to the app.</p>
              </div>
            </body>
          </html>
        `)

        // Exchange code for tokens
        exchangeSpotifyToken(clientId, clientSecret, code)
          .then((tokenData) => {
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
    server.listen(8080, () => {
      console.log('Spotify callback server listening on port 8080')
    })

    // Timeout after 2 minutes
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

// IPC handler to get stored credentials
function getSpotifyCredentials() {
  return spotifyCredentials
}

function registerSpotifyIpcs(ipcMain) {
  ipcMain.handle('spotify-api', spotifyApi)
  ipcMain.handle('spotify-transfer-playback', spotifyTransferPlayback)
  ipcMain.handle('spotify-play-track', spotifyPlayTrack)
  ipcMain.handle('spotify-auth', spotifyAuth)
  ipcMain.handle('get-spotify-credentials', getSpotifyCredentials)
}

module.exports = { registerSpotifyIpcs }
