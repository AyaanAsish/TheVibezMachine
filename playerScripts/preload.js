const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke('open-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  // Spotify OAuth
  spotifyAuth: (clientId, clientSecret) => ipcRenderer.invoke('spotify-auth', clientId, clientSecret),
  getSpotifyCredentials: () => ipcRenderer.invoke('get-spotify-credentials'),
  spotifyApi: (endpoint) => ipcRenderer.invoke('spotify-api', endpoint),
  spotifyPlayTrack: (uri, deviceId) => ipcRenderer.invoke('spotify-play-track', uri, deviceId),
  spotifyTransferPlayback: (deviceId, shouldPlay) => ipcRenderer.invoke('spotify-transfer-playback', deviceId, shouldPlay),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify-disconnect'),
  // Librespot control
  librespotPause: () => ipcRenderer.invoke('librespot-pause'),
  librespotPlay: () => ipcRenderer.invoke('librespot-play'),
  librespotNext: () => ipcRenderer.invoke('librespot-next'),
  librespotPrev: () => ipcRenderer.invoke('librespot-prev'),
  librespotSeek: (positionMs) => ipcRenderer.invoke('librespot-seek', positionMs),
  librespotSetVolume: (volume) => ipcRenderer.invoke('librespot-set-volume', volume),
  getLibrespotDeviceId: () => ipcRenderer.invoke('get-librespot-device-id'),
  // Librespot PCM / events
  onSpotifyPcm: (callback) => ipcRenderer.on('spotify-pcm', (_, buffer) => callback(buffer)),
  onSpotifyEvent: (callback) => ipcRenderer.on('spotify-event', (_, event) => callback(event))
})
