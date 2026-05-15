const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const http = require('http')
const url = require('url')
const { registerSpotifyIpcs, onAuthSuccess } = require('./spotifyScripts/spotifyAuth')
const { registerLibrespotIpcs, initLibrespot, stopLibrespot } = require('./spotifyScripts/librespot-main')
const libraryDb = require('./db')
process.env.LOX_LIBRESPOT_ADDON_PATH = path.join(__dirname, 'node_modules/@lox-audioserver/node-librespot/prebuilds/win32-x64/librespot_addon.node');

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
      res.end('Forbidden')
      return
    }

    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html')
      }
    } catch (_e) {}

    if (pathname === '/' || pathname === '') {
      filePath = path.join(root, 'index.html')
    }

    const ext = path.extname(filePath).toLowerCase()

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500)
        res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error')
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
    console.log(`[main] Loading app from http://127.0.0.1:${port}`)
    win.loadURL(`http://127.0.0.1:${port}`)
  } else {
    console.log('[main] Loading app from file://')
    win.loadFile('index.html')
  }

  return win
}

app.whenReady().then(async () => {
  console.log('[main] App ready. Platform:', process.platform, 'Arch:', process.arch)
  try {
    const FIXED_PORTS = [3000, 3001, 3002]
    let port = null

    appServer = serveStatic(__dirname)
    console.log('[main] Static server created for:', __dirname)
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

    createWindow(port)

    const allWindows = BrowserWindow.getAllWindows()
    if (allWindows.length > 0) {
      initLibrespot(allWindows[0])
    }
  } catch (err) {
    console.error('[main] Failed to start local server:', err)
    createWindow(null)
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
    let coverImage = null

    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name)
      if (entry.isDirectory()) {
        folders.push({ name: entry.name, path: fullPath })
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (audioExt.includes(ext)) {
          audioFiles.push({ name: entry.name, path: fullPath })
        }
        const name = entry.name.toLowerCase()
        if (!coverImage && imageExt.includes(path.extname(name).toLowerCase()) &&
            ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'album.jpg', 'album.png'].includes(name)) {
          coverImage = path.join(folderPath, entry.name)
        }
      }
    }

    return { folderPath, folders, audioFiles, coverImage }
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

registerSpotifyIpcs(ipcMain)
registerLibrespotIpcs(ipcMain)

onAuthSuccess(() => {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length > 0) initLibrespot(wins[0])
})
