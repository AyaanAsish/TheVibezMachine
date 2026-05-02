const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke('open-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  // Spotify OAuth
  spotifyAuth: (clientId, clientSecret) => ipcRenderer.invoke('spotify-auth', clientId, clientSecret),
  getSpotifyCredentials: () => ipcRenderer.invoke('get-spotify-credentials'),
  spotifyApi: (endpoint) => ipcRenderer.invoke('spotify-api', endpoint),
  spotifyPlayTrack: (uri, deviceId) => ipcRenderer.invoke('spotify-play-track', uri, deviceId),
  spotifyTransferPlayback: (deviceId) => ipcRenderer.invoke('spotify-transfer-playback', deviceId),
  spotifyGetDevices: () => ipcRenderer.invoke('spotify-get-devices')
})