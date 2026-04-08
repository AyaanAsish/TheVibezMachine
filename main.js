const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
	preload: path.join(__dirname, 'preload.js')
    }
  })

  win.loadFile('index.html')
}

app.whenReady().then(createWindow)

ipcMain.handle('open-file', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a'] }],
    properties: ['openFile', 'multiSelections']
  })
  return filePaths
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
