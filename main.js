const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const fs = require('fs')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
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
  return { files }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
