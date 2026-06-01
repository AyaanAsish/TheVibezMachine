const { contextBridge, ipcRenderer } = require("electron");

// Guard against duplicate listener registration
const pcmCbs = new Set();
const eventCbs = new Set();
const pollCbs = new Set();

contextBridge.exposeInMainWorld("electronAPI", {
  openFolder: () => ipcRenderer.invoke("open-folder"),
  scanFolder: (folderPath) => ipcRenderer.invoke("scan-folder", folderPath),
  dbAddPath: (folderPath) => ipcRenderer.invoke("db-add-path", folderPath),
  dbGetPaths: () => ipcRenderer.invoke("db-get-paths"),
  dbClearLibrary: () => ipcRenderer.invoke("db-clear-library"),
  // Spotify OAuth
  spotifyAuth: (clientId, clientSecret) =>
    ipcRenderer.invoke("spotify-auth", clientId, clientSecret),
  getSpotifyCredentials: () => ipcRenderer.invoke("get-spotify-credentials"),
  spotifyApi: (endpoint) => ipcRenderer.invoke("spotify-api", endpoint),
  spotifyPlayTrack: (uri, deviceId, uris) =>
    ipcRenderer.invoke("spotify-play-track", uri, deviceId, uris),
  spotifyTransferPlayback: (deviceId, shouldPlay) =>
    ipcRenderer.invoke("spotify-transfer-playback", deviceId, shouldPlay),
  spotifyDisconnect: () => ipcRenderer.invoke("spotify-disconnect"),
  // Librespot control
  librespotPause: () => ipcRenderer.invoke("librespot-pause"),
  librespotPlay: (positionMs, trackUri, uris) => ipcRenderer.invoke("librespot-play", positionMs, trackUri, uris),
  librespotNext: () => ipcRenderer.invoke("librespot-next"),
  librespotPrev: () => ipcRenderer.invoke("librespot-prev"),
  librespotSeek: (positionMs) =>
    ipcRenderer.invoke("librespot-seek", typeof positionMs === 'number' && isFinite(positionMs) && positionMs >= 0 ? Math.floor(positionMs) : 0),
  getLibrespotDeviceId: () => ipcRenderer.invoke("get-librespot-device-id"),
  reconnectLibrespot: () => ipcRenderer.invoke("reconnect-librespot"),
  getTheme: () => ipcRenderer.invoke("get-theme"),
  setTheme: (themeName) => ipcRenderer.invoke("set-theme", themeName),
  // Librespot PCM / events / poll
  onSpotifyPcm: (callback) => {
    if (pcmCbs.has(callback)) return;
    pcmCbs.add(callback);
    ipcRenderer.on("spotify-pcm-batch", (_, buffers) => {
      for (let i = 0; i < buffers.length; i++) {
        try { callback(buffers[i]); } catch (e) { console.error('[preload] onSpotifyPcm error:', e); }
      }
    });
  },
  onSpotifyEvent: (callback) => {
    if (eventCbs.has(callback)) return;
    eventCbs.add(callback);
    ipcRenderer.on("spotify-event", (_, event) => {
      try { callback(event); } catch (e) { console.error('[preload] onSpotifyEvent error:', e); }
    });
  },
  onSpotifyPoll: (callback) => {
    if (pollCbs.has(callback)) return;
    pollCbs.add(callback);
    ipcRenderer.on("spotify-poll", (_, result) => {
      try { callback(result); } catch (e) { console.error('[preload] onSpotifyPoll error:', e); }
    });
  },
});