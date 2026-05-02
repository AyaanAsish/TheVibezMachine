const { app, BrowserWindow, ipcMain, dialog, screen, shell, components, session } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const http = require('http')

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize

  const win = new BrowserWindow({
    width: width,
    height: height,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        plugins: true
    }
  })

  win.loadFile('index.html')
}

app.whenReady().then(async () => {
  await components.whenReady()
  console.log('Widevine components ready:', components.status())

  // Mask User-Agent for Spotify domains to avoid CDN blocks on non-standard Electron builds
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    if (details.url && (details.url.includes('spotify.com') || details.url.includes('scdn.co'))) {
      details.requestHeaders['User-Agent'] = ua
    }
    callback({ cancel: false, requestHeaders: details.requestHeaders })
  })

  createWindow()
})

ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths.length) return null

  const folderPath = result.filePaths[0]
  const files = fs.readdirSync(folderPath).map(f => path.join(folderPath, f))
  return { folder: folderPath, files }
})

ipcMain.handle('scan-folder', async (event, folderPath) => {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true })
    const audioExt = ['.mp3', '.wav', '.flac', '.ogg', '.m4a']
    const imageExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

    const folders = []
    const audioFiles = []

    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name)
      if (entry.isDirectory()) {
        folders.push({ name: entry.name, path: fullPath })
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (audioExt.includes(ext)) {
          audioFiles.push({ name: entry.name, path: fullPath })
        }
      }
    }

    // Check for album cover
    let coverImage = null
    for (const entry of entries) {
      const name = entry.name.toLowerCase()
      if (imageExt.includes(path.extname(name).toLowerCase()) &&
          (name === 'cover.jpg' || name === 'cover.png' || name === 'folder.jpg' || name === 'folder.png' || name === 'album.jpg' || name === 'album.png')) {
        coverImage = path.join(folderPath, entry.name)
        break
      }
    }

    return { folderPath, folders, audioFiles, coverImage }
  } catch (err) {
    console.error('Error scanning folder:', err)
    return null
  }
})

// Spotify OAuth configuration
const SPOTIFY_REDIRECT = 'http://127.0.0.1:8080'
const SPOTIFY_SCOPE = 'user-read-private user-read-email user-read-playback-state user-modify-playback-state playlist-read-private playlist-modify-public playlist-modify-private user-library-read streaming'

// Store for Spotify credentials
let spotifyCredentials = null
let pendingSpotifyAuth = null // { clientId, clientSecret, resolve }
let spotifyCallbackServer = null
let spotifyAuthState = null

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
ipcMain.handle('spotify-api', async (event, endpoint) => {
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
})

// IPC handler to transfer playback to a specific device (makes it active)
ipcMain.handle('spotify-transfer-playback', async (event, deviceId) => {
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
})

// IPC handler to start playback of a specific track via Spotify Web API
ipcMain.handle('spotify-play-track', async (event, uri, deviceId) => {
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
})

// IPC handler to start Spotify OAuth flow
ipcMain.handle('spotify-auth', async (event, clientId, clientSecret) => {
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
    shell.openExternal(authUrl)

    // Start callback server
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`)

      // Handle Spotify error redirect (user denied access, etc.)
      if (url.searchParams.has('error')) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#191414;color:white;">
          <div style="text-align:center;"><h1>Authorization Failed</h1><p>${url.searchParams.get('error')}</p></div></body></html>`)
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
          res.end(`<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#191414;color:white;">
            <div style="text-align:center;"><h1>Security Error</h1><p>Invalid state parameter.</p></div></body></html>`)
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
            <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#191414;color:white;">
              <div style="text-align:center;">
                <h1>Spotify Connected!</h1>
                <p>You can close this window and return to the app.</p>
              </div>
            </body>
          </html>
        `)

        // Exchange code for tokens
        exchangeSpotifyToken(clientId, clientSecret, code)
          .then((tokenData) => {
            setTimeout(() => {
              server.close()
              spotifyCallbackServer = null
            }, 2000)
            pendingSpotifyAuth = null
            resolve({ success: true, ...tokenData })
          })
          .catch((err) => {
            setTimeout(() => {
              server.close()
              spotifyCallbackServer = null
            }, 2000)
            pendingSpotifyAuth = null
            resolve({ success: false, error: err.message })
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
})

// IPC handler to get stored credentials
ipcMain.handle('get-spotify-credentials', () => {
  return spotifyCredentials
})

app.on('window-all-closed', () => {
  app.quit()
})
