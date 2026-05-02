const { app, BrowserWindow, ipcMain, dialog, screen, shell, components, session } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const http = require('http')
const url = require('url')

// Allow the Spotify Web Playback SDK to create its audio context without a user gesture
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// MIME types for the local static file server
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

function spotifyAuthHtml(title, message) {
  return `<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#191414;color:white;">
    <div style="text-align:center;"><h1>${title}</h1><p>${message}</p></div></body></html>`
}

function serveStatic(root) {
  return http.createServer((req, res) => {
    const parsed = url.parse(req.url)
    let pathname = decodeURIComponent(parsed.pathname)
    let filePath = path.resolve(path.join(root, pathname))

    // Prevent path traversal outside root
    if (!filePath.startsWith(path.resolve(root))) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html')
      }
    } catch (_e) { /* ignore */ }

    if (pathname === '/' || pathname === '') {
      filePath = path.join(root, 'index.html')
    }

    const ext = path.extname(filePath).toLowerCase()

    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404)
          res.end('Not found')
        } else {
          res.writeHead(500)
          res.end('Server error')
        }
        return
      }
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(data)
    })
  })
}

let appServer = null

function createWindow(port) {
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
        plugins: true,
        webSecurity: false
    }
  })

  if (port) {
    console.log(`[main] Loading app from http://127.0.0.1:${port}`)
    win.loadURL(`http://127.0.0.1:${port}`)
  } else {
    console.log('[main] Loading app from file://')
    win.loadFile('index.html')
  }

  return win
}

app.whenReady().then(async () => {
  // Start local HTTP server so the app loads from a secure context (localhost).
  // The Spotify Web Playback SDK requires EME/Widevine, which Chromium
  // blocks on file:// origins. Serving from http://127.0.0.1 fixes this.
  try {
    appServer = serveStatic(__dirname)
    const port = await new Promise((resolve, reject) => {
      appServer.listen(0, '127.0.0.1', (err) => {
        if (err) reject(err)
        else resolve(appServer.address().port)
      })
    })
    console.log(`[main] Local server running on http://127.0.0.1:${port}`)

    await components.whenReady()
    console.log('Widevine components ready:', components.status())

    // Allow encrypted-media for Spotify Web Playback SDK
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = ['encrypted-media', 'media', 'mediaKeySystemAccess']
      callback(allowed.includes(permission))
    })

    // Mask User-Agent for Spotify domains to avoid CDN blocks on non-standard Electron builds
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      if (details.url && (details.url.includes('spotify.com') || details.url.includes('scdn.co'))) {
        details.requestHeaders['User-Agent'] = ua
      }
      callback({ cancel: false, requestHeaders: details.requestHeaders })
    })

    createWindow(port)
  } catch (err) {
    console.error('[main] Failed to start local server:', err)
    console.log('[main] Falling back to file://')
    createWindow(null)
  }
})

app.on('window-all-closed', () => {
  if (appServer) appServer.close()
  app.quit()
})

ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths.length) return null

  const folderPath = result.filePaths[0]
  const files = fs.readdirSync(folderPath).map(f => path.join(folderPath, f))
  return { folder: folderPath, files }
})

ipcMain.handle('scan-folder', async (_event, folderPath) => {
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
ipcMain.handle('spotify-api', async (_event, endpoint) => {
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
ipcMain.handle('spotify-transfer-playback', async (_event, deviceId) => {
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
ipcMain.handle('spotify-play-track', async (_event, uri, deviceId) => {
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
ipcMain.handle('spotify-auth', async (_event, clientId, clientSecret) => {
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
})

// IPC handler to get stored credentials
ipcMain.handle('get-spotify-credentials', () => {
  return spotifyCredentials
})
