const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke('open-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  // Spotify OAuth
  spotifyAuth: (clientId, clientSecret) => ipcRenderer.invoke('spotify-auth', clientId, clientSecret),
  getSpotifyCredentials: () => ipcRenderer.invoke('get-spotify-credentials')
})