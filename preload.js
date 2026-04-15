const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke('open-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath)
})