const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require('electron')
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
        preload: path.join(__dirname, 'preload.js')
    }
  })

  win.loadFile('index.html')
}

app.whenReady().then(createWindow)

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
const SPOTIFY_SCOPE = 'user-read-private user-read-email user-read-playback-state user-modify-playback-state playlist-read-private playlist-modify-public playlist-modify-private'

// Store for Spotify credentials
let spotifyCredentials = null
let pendingSpotifyAuth = null // { clientId, clientSecret, resolve }

// Generate random state for CSRF protection
function generateRandomString(length) {
  return crypto.randomBytes(length).toString('hex')
}

// Get Spotify authorization URL
function getSpotifyAuthUrl(clientId) {
  const state = generateRandomString(16)
  return `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT)}&scope=${encodeURIComponent(SPOTIFY_SCOPE)}&state=${state}`
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
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      tokenExpiry: Date.now() + (tokenData.expires_in * 1000)
    }
    return tokenData
  } catch (err) {
    throw err
  }
}

// IPC handler to start Spotify OAuth flow
ipcMain.handle('spotify-auth', async (event, clientId, clientSecret) => {
  return new Promise((resolve) => {
    const authUrl = getSpotifyAuthUrl(clientId)

    // Store credentials for when callback comes in
    pendingSpotifyAuth = { clientId, clientSecret, resolve }

    // Open browser for user to authorize
    shell.openExternal(authUrl)

    // Start callback server
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`)

      if (url.pathname === '/' && url.searchParams.has('code')) {
        const code = url.searchParams.get('code')

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
            setTimeout(() => server.close(), 2000)
            pendingSpotifyAuth = null
            resolve({ success: true, ...tokenData })
          })
          .catch((err) => {
            setTimeout(() => server.close(), 2000)
            pendingSpotifyAuth = null
            resolve({ success: false, error: err.message })
          })
      } else {
        res.writeHead(404)
        res.end('Not found - expected /?code=...')
      }
    })

    server.listen(8080, () => {
      console.log('Spotify callback server listening on port 8080')
    })

    // Timeout after 2 minutes
    setTimeout(() => {
      if (pendingSpotifyAuth) {
        server.close()
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

app.on('closed', () => {
  app.quit()
})
