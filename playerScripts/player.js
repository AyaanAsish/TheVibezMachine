// At the top of player.js
const audio = new Audio();
let queue = [];
let current = 0;
let audioSource = null;
let localAudioConnected = false;

// Cache frequently-accessed DOM elements
const btnPlay = document.getElementById('btn-play');
const progressFillEl = document.getElementById('progress-fill');
const currentTimeEl = document.getElementById('current-time');
const durationEl = document.getElementById('duration');
const toastEl = document.getElementById('toast');
const btnMute = document.getElementById('btn-mute');
const trackNameEl = document.getElementById('track-name');
const pathInput = document.getElementById('path');

function updatePlayerCover(url) {
  const container = document.getElementById('player-cover');
  if (!container) return;
  if (url) {
    container.innerHTML = `<img src="${url}" alt="Album cover" />`;
  } else {
    container.innerHTML = '<span class="no-cover">🎵</span>';
  }
}
window.updatePlayerCover = updatePlayerCover;

// --- Unified Playback State ---
const PlaybackState = {
  mode: null, // 'local' | 'spotify' | null
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  pendingPromise: null,
  lastSwitchTime: 0,
  advanceLock: false,
  previousVolume: 1,
  isDeviceActive: false,
  lastUserActionTime: 0,

  setMode(mode) {
    if (this.mode === mode) return;
    const oldMode = this.mode;
    this.mode = mode;
    this.lastSwitchTime = Date.now();

    if (oldMode === 'spotify' && mode !== 'spotify') {
      this.isDeviceActive = false;
      if (window.stopSpotifyAudio) window.stopSpotifyAudio();
      if (window.electronAPI?.librespotPause) {
        window.electronAPI.librespotPause().catch(() => {});
      }
    }
    if (oldMode === 'local' && mode !== 'local') {
      audio.pause();
      audio.src = '';
      audio.load();
      if (window.disconnectLocalAudio) window.disconnectLocalAudio();
    }

    window.isSpotifyPlayback = mode === 'spotify';
  },

  setPlaying(playing) {
    this.isPlaying = playing;
    if (btnPlay) {
      btnPlay.classList.toggle('paused', playing);
    }
  },

  setTrackInfo(name, cover) {
    if (trackNameEl) {
      trackNameEl.textContent = name || 'No track loaded';
      if (trackNameEl.scrollWidth > trackNameEl.clientWidth) {
        trackNameEl.classList.add('scroll-animation');
      } else {
        trackNameEl.classList.remove('scroll-animation');
      }
    }
    updatePlayerCover(cover !== undefined ? cover : window.currentPlaylistCover || '');
  },

  setProgress(positionMs, durationMs) {
    if (durationMs != null) this.durationMs = durationMs;
    if (positionMs != null) this.positionMs = positionMs;
    const dur = this.durationMs || 1;
    const pct = dur > 0 ? (this.positionMs / dur) * 100 : 0;
    if (progressFillEl) progressFillEl.style.width = pct + '%';
    if (currentTimeEl) currentTimeEl.textContent = fmt(this.positionMs / 1000);
    if (durationEl) durationEl.textContent = fmt(dur / 1000);
  },

  reset() {
    this.setMode(null);
    this.setPlaying(false);
    this.setTrackInfo('No track loaded', null);
    this.setProgress(0, 0);
    this.pendingPromise = null;
    this.advanceLock = false;
    this.isDeviceActive = false;
    stopSpotifyPositionTicker();
  },

  async advance(delta) {
    if (this.advanceLock) return;
    this.advanceLock = true;
    try {
      if (this.mode === 'spotify') {
        const q = window.spotifyQueue;
        const idx = window.spotifyCurrentIndex;
        const newIdx = (idx != null) ? idx + delta : null;
        if (q && Array.isArray(q) && newIdx != null && newIdx >= 0 && newIdx < q.length && q[newIdx]?.uri) {
          window.spotifyCurrentIndex = newIdx;
          // Update cover to the new track's album art
          const newTrack = q[newIdx];
          if (newTrack.albumImage) {
            window.currentPlaylistCover = newTrack.albumImage;
            if (window.updatePlayerCover) window.updatePlayerCover(newTrack.albumImage);
          }
          await window.spotifyPlayTrack(q[newIdx].uri);
        } else if (delta > 0) {
          await window.electronAPI.librespotNext();
        } else {
          await window.electronAPI.librespotPrev();
        }
      } else {
        const activeQueue = getActiveQueue();
        const newIdx = current + delta;
        if (newIdx >= 0 && newIdx < activeQueue.length) {
          loadTrack(newIdx);
        }
      }
    } finally {
      this.advanceLock = false;
    }
  },

  setVolume(val) {
    if (val === 0) {
      btnMute?.classList.add('muted');
    } else {
      this.previousVolume = val;
      btnMute?.classList.remove('muted');
    }

    if (this.mode === 'spotify') {
      if (window.setSpotifyVolume) window.setSpotifyVolume(val);
    } else {
      audio.volume = val;
    }
  }
};
window.PlaybackState = PlaybackState;

// Click-to-toggle player popup
const footerEl = document.querySelector('footer');
const triggerEl = document.getElementById('footer-trigger');
triggerEl.addEventListener('click', (e) => {
  e.stopPropagation();
  footerEl.classList.toggle('player-visible');
});
document.addEventListener('click', (e) => {
  if (!footerEl.contains(e.target) && !triggerEl.contains(e.target)) {
    footerEl.classList.remove('player-visible');
  }
});

// Convert a local filesystem path to a file:// URL
function toFileUrl(p) {
  if (!p) return "";
  if (
    p.startsWith("file://") ||
    p.startsWith("http://") ||
    p.startsWith("https://")
  )
    return p;
  const normalized = p.replace(/\\/g, "/");
  const stripped = normalized.replace(/^\/+/, "");
  const encoded = stripped.split("/").map(s => encodeURIComponent(s)).join("/");
  return "file:///" + encoded;
}

function ensureAudioConnection() {
  if (!window.myVisualizer || !window.visualizerAudioContext) {
    console.warn("[Player] Waiting for Visualizer to initialize...");
    return false;
  }

  if (!audioSource) {
    try {
      audioSource = window.visualizerAudioContext.createMediaElementSource(audio);
      window.localAudioSource = audioSource;
    } catch (e) {
      console.error("[Player] Connection error:", e);
      return false;
    }
  }

  if (!localAudioConnected) {
    try {
      audioSource.connect(window.visualizerAudioContext.destination);
      localAudioConnected = true;
    } catch (_) {}
  }

  window.myVisualizer.connectAudio(audioSource);

  if (window.visualizerAudioContext.state === "suspended") {
    window.visualizerAudioContext.resume();
  }

  return true;
}

function getActiveQueue() {
  return window.playerQueue && window.playerQueue.length > 0
    ? window.playerQueue
    : queue;
}

// --- Folder loading ---
document.getElementById("btn-open").addEventListener("click", async () => {
  const result = await window.electronAPI.openFolder();
  if (!result || !result.files.length) return;

  pathInput.value = result.folder;
  window.setLibraryPath(result.folder);

  const audioExt = window.AUDIO_EXTENSIONS || [".mp3", ".wav", ".flac", ".ogg", ".m4a"];
  queue = result.files.filter((f) => {
    const name = f.replace(/\\/g, "/").split("/").pop();
    return !name.startsWith("._") && audioExt.some((ext) => f.toLowerCase().endsWith(ext));
  });
  if (!queue.length) return;

  current = 0;
  window.playerQueue = queue;
  loadTrack(current);
});

function loadTrack(index) {
  const activeQueue = getActiveQueue();
  if (index < 0 || index >= activeQueue.length) return;

  PlaybackState.setMode('local');
  current = index;

  audio.pause();
  audio.src = "";

  if (window.disconnectLocalAudio) window.disconnectLocalAudio();

  audio.src = toFileUrl(activeQueue[index]);
  ensureAudioConnection();

  audio
    .play()
    .then(() => {
      if (
        window.visualizerAudioContext &&
        window.visualizerAudioContext.state === "suspended"
      ) {
        window.visualizerAudioContext.resume();
      }
    })
    .catch((err) => console.error("Playback error:", err));

  const rawName = activeQueue[index]?.replace(/\\/g, "/").split("/").pop() || "No track loaded";
  const name = rawName.replace(/\.[^/.]+$/, "");
  PlaybackState.setTrackInfo(name, window.currentPlaylistCover || '');
  PlaybackState.setPlaying(true);
  highlightActive();
}

// --- Controls ---
document.getElementById("btn-play").addEventListener("click", async () => {
  if (PlaybackState.mode === 'spotify') {
    if (PlaybackState.pendingPromise) return;
    if (window.startSpotifyAudio) window.startSpotifyAudio();

    const wasPlaying = PlaybackState.isPlaying;

    // Optimistic UI: toggle immediately so the app feels responsive.
    // The audio graph in librespot-renderer.js reads PlaybackState.isPlaying
    // directly, so audio will follow this immediately.
    PlaybackState.lastUserActionTime = Date.now();
    PlaybackState.setPlaying(!wasPlaying);

    // Fire IPC in the background
    const ipcFn = wasPlaying
      ? window.electronAPI.librespotPause
      : window.electronAPI.librespotPlay;

    PlaybackState.pendingPromise = ipcFn();

    let result;
    try {
      result = await PlaybackState.pendingPromise;
    } catch (e) {
      console.error("[Player] IPC error:", e);
      result = { success: false, error: e.message };
    } finally {
      PlaybackState.pendingPromise = null;
    }

    // Reconcile with IPC result. Librespot events are ground truth,
    // but we use the IPC return for faster error recovery.
    if (!result.success) {
      console.warn('[Player] IPC failed, reverting optimistic state');
      PlaybackState.setPlaying(wasPlaying);
    } else if (result.state) {
      const actualPlaying = result.state === 'playing';
      if (actualPlaying !== PlaybackState.isPlaying) {
        PlaybackState.setPlaying(actualPlaying);
      }
    }
    return;
  }

  ensureAudioConnection();

  if (audio.paused) {
    audio.play().catch((err) => console.error("Playback error:", err));
  } else {
    audio.pause();
  }
  PlaybackState.setPlaying(audio.paused === false);
});

document.getElementById("btn-prev").addEventListener("click", () => {
  PlaybackState.advance(-1);
});

document.getElementById("btn-next").addEventListener("click", () => {
  PlaybackState.advance(1);
});

btnMute.addEventListener("click", () => {
  const isMuted = btnMute.classList.contains("muted");
  const newVol = isMuted ? PlaybackState.previousVolume : 0;
  PlaybackState.setVolume(newVol);
});

audio.addEventListener("ended", () => {
  const activeQueue = getActiveQueue();
  if (current < activeQueue.length - 1) loadTrack(current + 1);
});

audio.addEventListener("play", () => {
  if (PlaybackState.mode === 'local') PlaybackState.setPlaying(true);
});

audio.addEventListener("pause", () => {
  if (PlaybackState.mode === 'local') PlaybackState.setPlaying(false);
});

// --- Progress bar ---
const progressBar = document.getElementById("progress-bar");

audio.addEventListener("timeupdate", () => {
  if (PlaybackState.mode === 'spotify') return;
  PlaybackState.setProgress(audio.currentTime * 1000, (audio.duration || 0) * 1000);
});

progressBar.addEventListener("click", (e) => {
  const ratio = e.offsetX / progressBar.offsetWidth;
  if (PlaybackState.mode === 'spotify') {
    if (window.startSpotifyAudio) window.startSpotifyAudio();
    const duration = PlaybackState.durationMs || 1;
    const newPos = Math.floor(ratio * duration);

    // Immediate visual feedback
    PlaybackState.positionMs = newPos;
    PlaybackState.setProgress(null, null);
    // Reset the sample-based anchor so the ticker shows the seek position
    if (window.resetSpotifyPositionAnchor) window.resetSpotifyPositionAnchor(newPos);

    // Flush old PCM so we don't hear stale audio after the seek
    if (window.flushSpotifyBuffers) window.flushSpotifyBuffers();

    window.electronAPI.librespotSeek(newPos).catch(() => {});
    return;
  }
  audio.currentTime = ratio * audio.duration;
});

// --- Volume ---
document.getElementById("volume").addEventListener("input", (e) => {
  const val = parseFloat(e.target.value);
  PlaybackState.setVolume(val);
});

function highlightActive() {
  if (window.highlightTracklistItems) {
    window.highlightTracklistItems('.tracklist-item', current);
  }
}

function fmt(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${sec}`;
}

// --- Settings: Apply Path ---
document.getElementById("applyPath").addEventListener("click", () => {
  const pathValue = pathInput.value.trim();
  if (!pathValue) {
    showToast("Enter a folder path first", "error");
    return;
  }
  window.setLibraryPath(pathValue);
});

// --- Settings: Clear Library ---
document.getElementById("clearLibrary").addEventListener("click", async () => {
  await window.electronAPI.dbClearLibrary();
  pathInput.value = "";
  loadLibrary();
  showToast("Library cleared", "success");
});

// --- Settings: Spotify Connect ---
document
  .getElementById("spotifyConnect")
  .addEventListener("click", async () => {
    const clientId = document.getElementById("spotifyClientId").value.trim();
    const clientSecret = document
      .getElementById("spotifyClientSecret")
      .value.trim();

    if (!clientId || !clientSecret) {
      showToast("Enter both Client ID and Secret", "error");
      return;
    }

    try {
      const result = await window.electronAPI.spotifyAuth(
        clientId,
        clientSecret,
      );
      if (result.success) {
        showToast("Spotify connected", "success");
        document.getElementById("spotifyClientSecret").value = "";
      } else {
        showToast("Connection failed — " + (result.error || "Unknown error"), "error");
      }
    } catch (e) {
      showToast("Connection error — " + e.message, "error");
    }
  });

// --- Settings: Spotify Disconnect ---
document
  .getElementById("spotifyDisconnect")
  .addEventListener("click", async () => {
    try {
      const result = await window.electronAPI.spotifyDisconnect();
      if (result.success) {
        showToast("Spotify disconnected", "success");
      } else {
        showToast("Failed to disconnect — " + (result.error || "Unknown error"), "error");
      }
    } catch (e) {
      showToast("Disconnect error — " + e.message, "error");
    }
  });

// --- Spotify position ticker (sample-based) ---
let spotifyPositionInterval = null;

function startSpotifyPositionTicker() {
  if (spotifyPositionInterval) return;
  spotifyPositionInterval = setInterval(() => {
    if (PlaybackState.mode !== 'spotify' || !PlaybackState.isPlaying) return;
    if (window.getSpotifyPosition) {
      const pos = window.getSpotifyPosition();
      if (pos != null) {
        PlaybackState.positionMs = pos;
        PlaybackState.setProgress(null, null);
      }
    }
  }, 50);
}

function stopSpotifyPositionTicker() {
  if (spotifyPositionInterval) {
    clearInterval(spotifyPositionInterval);
    spotifyPositionInterval = null;
  }
}

// --- Toast notification ---
let toastTimer = null;
function showToast(msg, type = 'success') {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.className = 'toast-visible toast-' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('toast-visible');
    toastEl.classList.add('toast-hidden');
  }, 4000);
}
window.showToast = showToast;

// --- Global Spotify play ---
window.spotifyPlayTrack = async (uri) => {
  if (!uri) {
    showToast("No track selected");
    return;
  }

  // Prevent overlapping play calls (rapid track clicks)
  if (PlaybackState.pendingPromise) {
    return;
  }

  // Always flush old PCM so the previous track doesn't bleed in
  if (window.flushSpotifyBuffers) window.flushSpotifyBuffers();

  PlaybackState.setMode('spotify');
  PlaybackState.positionMs = 0;
  if (window.resetSpotifyPositionAnchor) window.resetSpotifyPositionAnchor(0);
  PlaybackState.lastUserActionTime = Date.now();
  startSpotifyPositionTicker();

  if (window.startSpotifyAudio) {
    window.startSpotifyAudio();
  } else {
    console.error("[player.js] window.startSpotifyAudio is MISSING");
  }

  // Set playing state immediately — the user explicitly requested playback.
  // The audio graph in librespot-renderer reads this directly.
  PlaybackState.setPlaying(true);

  const deviceId = await window.electronAPI.getLibrespotDeviceId();

  if (!deviceId) {
    showToast("Spotify playback unavailable — no device connected");
    PlaybackState.reset();
    return;
  }

  // If the device is already active, skip the expensive transfer step
  if (!PlaybackState.isDeviceActive) {
    let xfer = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      xfer = await window.electronAPI.spotifyTransferPlayback(deviceId, true);
      if (xfer.success) break;
      if (attempt < 2) {
        showToast("Spotify device not ready, retrying…");
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    if (!xfer.success) {
      showToast("Spotify transfer failed — " + (xfer.error || "check your connection"));
      PlaybackState.reset();
      return;
    }
    PlaybackState.isDeviceActive = true;
  }

  PlaybackState.pendingPromise = window.electronAPI.spotifyPlayTrack(uri, deviceId);
  let result;
  try {
    result = await PlaybackState.pendingPromise;
  } catch (e) {
    console.error("[player.js] Play IPC error:", e);
    result = { success: false, error: e.message };
  } finally {
    PlaybackState.pendingPromise = null;
  }

  if (!result.success) {
    showToast("Spotify playback failed — " + (result.error || "unknown error"));
    PlaybackState.reset();
  }
};

// --- Expose for library.js and librespot-renderer.js ---
window.loadPlayerTrack = loadTrack;
window.pauseLocalAudio = () => {
  audio.pause();
};
window.disconnectLocalAudio = () => {
  if (audioSource) {
    try {
      audioSource.disconnect();
      localAudioConnected = false;
    } catch (_) {}
  }
  if (audioSource && window.myVisualizer) {
    try {
      window.myVisualizer.disconnectAudio(audioSource);
    } catch (_) {}
  }
};
window.startSpotifyPositionTicker = startSpotifyPositionTicker;
window.fmt = fmt;
window.toFileUrl = toFileUrl;
