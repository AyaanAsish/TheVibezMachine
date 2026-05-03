const { app, BrowserWindow, ipcMain, dialog, screen, shell, components, session } = require('electron')
const fs = require('fs')
const path = require('path')
const http = require('http')
const url = require('url')
const { registerSpotifyIpcs } = require('./spotifyAuth')

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
      let contentType = mimeTypes[ext] || 'application/octet-stream'
      if (contentType.startsWith('text/')) {
        contentType += '; charset=utf-8'
      }
      res.writeHead(200, {
        'Content-Type': contentType,
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
    minWidth: width/2,
    minHeight: 700,
    title: 'TheVibezMachine',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webSecurity: false,
      backgroundThrottling: false,
    },
  });

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
  // We use a fixed port (3000) so the origin is stable for Spotify allowlisting.
  try {
    const FIXED_PORTS = [3000, 3001, 3002]
    let port = null

    appServer = serveStatic(__dirname)
    for (const p of FIXED_PORTS) {
    try {
      await new Promise((resolve, reject) => {
        appServer.listen(p, '127.0.0.1', (err) => {
          if (err) reject(err)
          else resolve(p)
        })
      })
      port = p
      break
    } catch (err) {
      console.log(`[main] Port ${p} is in use, trying next...`)
    }
  }

  if (!port) {
    console.error('[main] All fixed ports (3000-3002) are in use. Falling back to random port.')
    console.error('[main] WARNING: Spotify streaming may not work if the origin port changes.')
    try {
      port = await new Promise((resolve, reject) => {
        appServer.listen(0, '127.0.0.1', (err) => {
          if (err) reject(err)
          else resolve(appServer.address().port)
        })
      })
    } catch (err) {
      console.error('[main] Failed to start local server:', err)
      createWindow(null)
      return
    }
  }

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

registerSpotifyIpcs(ipcMain)
