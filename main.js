const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron')
const fs = require('fs/promises')
const fsSync = require('fs')
const path = require('path')
const http = require('http')
const url = require('url')
const { registerSpotifyIpcs, onAuthSuccess, setReconnectFn } = require('./spotifyScripts/spotifyAuth')
const { registerLibrespotIpcs, initLibrespot, stopLibrespot, reconnectLibrespot, clearReconnectCooldown } = require('./spotifyScripts/librespot-main')

// Set DB path before requiring db.js so it uses the proper userData directory
process.env.DB_PATH = path.join(app.getPath('userData'), 'library.db')
const libraryDb = require('./DB/db')
const { AUDIO_EXTENSIONS } = require('./shared/constants')

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

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

    const relative = path.relative(path.resolve(root), filePath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.writeHead(403)
      res.end('Access denied')
      return
    }

    try {
      const stat = fsSync.statSync(filePath)
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html')
      }
    } catch (_e) {}

    if (pathname === '/' || pathname === '') {
      filePath = path.join(root, 'index.html')
    }

    // Temporary test endpoints
    if (pathname === '/api/test-play') {
      const wins = BrowserWindow.getAllWindows()
      if (wins.length > 0) {
        wins[0].webContents.executeJavaScript(`document.getElementById('btn-play').click()`)
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
      return
    }
    if (pathname === '/api/test-seek') {
      const wins = BrowserWindow.getAllWindows()
      if (wins.length > 0) {
        const q = new URLSearchParams(parsed.query || '')
        const pos = parseInt(q.get('pos') || '0', 10)
        wins[0].webContents.executeJavaScript(`
          if (window.flushSpotifyBuffers) window.flushSpotifyBuffers(${pos});
          if (window.PlaybackState) window.PlaybackState.setProgress(${pos}, null);
          if (window.electronAPI?.librespotSeek) window.electronAPI.librespotSeek(${pos}).catch(() => {});
        `)
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
      return
    }
    if (pathname === '/api/set-pause-state') {
      const wins = BrowserWindow.getAllWindows()
      if (wins.length > 0) {
        const q = new URLSearchParams(parsed.query || '')
        const pos = parseInt(q.get('pos') || '0', 10)
        const uri = q.get('uri') || ''
        const dur = parseInt(q.get('dur') || '0', 10)
        wins[0].webContents.executeJavaScript(`
          localStorage.setItem('tvm-pause-state', JSON.stringify({
            uri: '${uri}',
            pos: ${pos},
            durationMs: ${dur},
            ts: Date.now()
          }));
        `)
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
      return
    }

    const ext = path.extname(filePath).toLowerCase()

    fsSync.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500)
        res.end(err.code === 'ENOENT' ? 'File not found' : 'Something went wrong')
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
    minWidth: width / 2,
    minHeight: 700,
    title: 'TheVibezMachine',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "playerScripts/preload.js"),
      webSecurity: false,
      backgroundThrottling: false,
    },
  })

  if (port) {
    win.loadURL(`http://127.0.0.1:${port}`)
  } else {
    win.loadFile('index.html')
  }

  // Forward renderer console messages to main process so we can see them
  // when testing headlessly.
  win.webContents.on('console-message', (_event, _level, message, _line, _sourceId) => {
    console.log(`[Renderer] ${message}`)
  })

  return win
}

app.whenReady().then(async () => {
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
        // Port in use, try next
      }
    }

    if (!port) {
      console.error('[main] All fixed ports (3000-3002) are in use. Falling back to random port.')
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

    createWindow(port)

    const allWindows = BrowserWindow.getAllWindows()
    if (allWindows.length > 0) {
      initLibrespot(allWindows[0])
    }
  } catch (err) {
    console.error('[main] Failed to start local server:', err)
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(null)
    }
  }
})

app.on('window-all-closed', () => {
  libraryDb.close()
  stopLibrespot()
  if (appServer) appServer.close()
  app.quit()
})

ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths.length) return null

  const folderPath = result.filePaths[0]
  const entries = await fs.readdir(folderPath, { withFileTypes: true })
  const files = entries.map(e => path.join(folderPath, e.name))
  return { folder: folderPath, files }
})

ipcMain.handle('scan-folder', async (_event, folderPath, _userTriggered) => {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true })
    const imageExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

    const folders = []
    const audioFiles = []
    let coverImage = null

    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name)
      if (entry.isDirectory()) {
        folders.push({ name: entry.name, path: fullPath })
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (AUDIO_EXTENSIONS.includes(ext) && !entry.name.startsWith('._')) {
          audioFiles.push({ name: entry.name, path: fullPath })
        }
        const name = entry.name.toLowerCase()
        if (!coverImage && imageExt.includes(path.extname(name).toLowerCase()) &&
            ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'album.jpg', 'album.png'].includes(name)) {
          coverImage = path.join(folderPath, entry.name)
        }
      }
    }

    let meta = null
    try {
      const metaPath = path.join(folderPath, '.vibez-meta.json')
      const metaRaw = await fs.readFile(metaPath, 'utf8')
      meta = JSON.parse(metaRaw)
    } catch (_e) {
      // no meta file or invalid json
    }

    return { folderPath, folders, audioFiles, coverImage, meta }
  } catch (err) {
    console.error('Error scanning folder:', err)
    return null
  }
})

ipcMain.handle('db-add-path', (_event, folderPath) => {
  libraryDb.addPath(folderPath)
  return { success: true }
})

ipcMain.handle('db-get-paths', () => {
  return libraryDb.getAllPaths()
})

ipcMain.handle('db-clear-library', () => {
  libraryDb.clearAll()
  return { success: true }
})

ipcMain.handle('save-playlist-meta', async (_event, folderPath, name, author) => {
  try {
    const metaPath = path.join(folderPath, '.vibez-meta.json')
    await fs.writeFile(metaPath, JSON.stringify({ name, author }, null, 2), 'utf8')
    return { success: true }
  } catch (err) {
    console.error('Failed to save playlist meta:', err)
    return { success: false, error: err.message }
  }
})

ipcMain.handle('get-theme', async () => {
  const configPath = path.join(app.getPath('userData'), 'theme.json')
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return { themeName: 'Vibez Classic' }
  }
})

ipcMain.handle('set-theme', async (_event, themeName) => {
  const configPath = path.join(app.getPath('userData'), 'theme.json')
  await fs.writeFile(configPath, JSON.stringify({ themeName }), 'utf8')
  return { success: true }
})

ipcMain.handle('get-spacing', async () => {
  const configPath = path.join(app.getPath('userData'), 'spacing.json')
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return { presetName: 'Default' }
  }
})

ipcMain.handle('set-spacing', async (_event, payload) => {
  const configPath = path.join(app.getPath('userData'), 'spacing.json')
  if (typeof payload === 'object' && payload !== null && typeof payload.percent === 'number') {
    await fs.writeFile(configPath, JSON.stringify({ percent: payload.percent }), 'utf8')
  } else {
    await fs.writeFile(configPath, JSON.stringify({ presetName: payload }), 'utf8')
  }
  return { success: true }
})

registerSpotifyIpcs(ipcMain)
registerLibrespotIpcs(ipcMain)

setReconnectFn(reconnectLibrespot)

onAuthSuccess(() => {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length > 0) initLibrespot(wins[0])
  clearReconnectCooldown()
})
