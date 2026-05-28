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

let lastCoverUrl = null;
window.nowPlayingCover = null;
function updatePlayerCover(url) {
  if (url === lastCoverUrl) return;
  lastCoverUrl = url;
  window.nowPlayingCover = url;
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
  lastTrackUri: null,
  coverLoadedFromApi: false,

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
    updateTriggerVisibility();
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
    updatePlayerCover(cover !== undefined ? cover : window.nowPlayingCover || '');
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
    this.lastTrackUri = null;
    this.coverLoadedFromApi = false;
    stopSpotifyPositionTicker();
    updateTriggerVisibility();
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
          const newTrack = q[newIdx];
          if (newTrack.albumImage) {
            if (window.updatePlayerCover) window.updatePlayerCover(newTrack.albumImage);
          }
          window.spotifyCurrentIndex = newIdx;
          await window.spotifyPlayTrack(q[newIdx].uri);
        } else if (q && q.length > 0) {
          // Queue exists but we're at the end (or beginning for prev).
          // Only call next/prev if we have an in-app queue — for remote
          // playback (empty/unknown queue), let Spotify manage its own queue.
          if (delta > 0) {
            await window.electronAPI.librespotNext();
          } else {
            await window.electronAPI.librespotPrev();
          }
        }
        // If no queue at all (pure remote playback), do nothing —
        // Spotify will advance on its own via the Connect session.
      } else {
        const activeQueue = getActiveQueue();
        const newIdx = current + delta;
        if (newIdx >= 0 && newIdx < activeQueue.length) {
          loadTrack(newIdx);
        }
      }
    } catch (e) {
      console.error('[Player] advance error:', e);
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

function updateTriggerVisibility() {
  const show = PlaybackState.mode !== null;
  triggerEl.classList.toggle('visible', show);
}

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
let folderDialogOpen = false;
document.getElementById("btn-open").addEventListener("click", async () => {
  if (folderDialogOpen) return;
  folderDialogOpen = true;
  try {
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
  } finally {
    folderDialogOpen = false;
  }
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
  PlaybackState.setTrackInfo(name, window.nowPlayingCover || window.currentPlaylistCover || '');
  PlaybackState.setPlaying(true);
  highlightActive();
}

// --- Controls ---
document.getElementById("btn-play").addEventListener("click", async () => {
  if (PlaybackState.mode === 'spotify') {
    const wasPlaying = PlaybackState.isPlaying;

    if (!wasPlaying && window.startSpotifyAudio) window.startSpotifyAudio();

    PlaybackState.lastUserActionTime = Date.now();

    if (wasPlaying) {
      // --- PAUSE: save position locally ---
      const pausePos = window.getSpotifyPosition?.() ?? PlaybackState.positionMs;
      PlaybackState.setPlaying(false);
      if (window.spPausePosKey && pausePos != null) {
        const pauseTs = Date.now();
        try { localStorage.setItem(window.spPausePosKey, JSON.stringify({ pos: Math.floor(pausePos), ts: pauseTs })); } catch (_) {}
        // Also save the unified pause state so resume has fresh data even if
        // the librespot 'paused' event is delayed or never arrives.
        const currentUri = window.PlaybackState.lastTrackUri || window.spPausePosKey.replace('tvm-pause-', '');
        const currentDuration = window.PlaybackState.durationMs || 0;
        try {
          localStorage.setItem('tvm-pause-state', JSON.stringify({
            uri: currentUri,
            pos: Math.floor(pausePos),
            durationMs: currentDuration,
            ts: pauseTs
          }));
        } catch (_) {}
        // Explicitly freeze the sample-based anchor so getSpotifyPosition()
        // stays stable while paused.
        if (window.resetSpotifyPositionAnchor) window.resetSpotifyPositionAnchor(pausePos);

        // Clean up old pause position entries (older than 12 hours)
        try {
          const cutoff = Date.now() - 43200000;
          const toRemove = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('tvm-pause-')) {
              try {
                const v = JSON.parse(localStorage.getItem(k));
                if (v.ts < cutoff) toRemove.push(k);
              } catch (_) {}
            }
          }
          toRemove.forEach(k => localStorage.removeItem(k));
        } catch (_) {}
      }

      const result = await window.electronAPI.librespotPause().catch(e => {
        console.error("[Player] Pause IPC error:", e);
        return { success: false, error: e.message };
      });
      if (!result.success) {
        console.warn('[Player] Pause IPC failed, reverting');
        PlaybackState.setPlaying(true);
      }
    } else {
      // --- RESUME: read the unified pause state and replay from there ---
      let resumeUri = null;
      let resumePos = 0;
      let resumeDuration = 0;
      let pauseTs = 0;
      try {
        const raw = localStorage.getItem('tvm-pause-state');
        if (raw) {
          const s = JSON.parse(raw);
          if (s.uri && Date.now() - s.ts < 1800000) {
            resumeUri = s.uri;
            resumePos = s.pos || 0;
            resumeDuration = s.durationMs || 0;
            pauseTs = s.ts || 0;
          }
        }
      } catch (_) {}

      // Fallback to whatever we think is playing if no pause state
      if (!resumeUri) {
        resumeUri = window.PlaybackState.lastTrackUri || null;
      }
      if (!resumeUri) {
        showToast("No track to resume", "error");
        PlaybackState.setPlaying(false);
        return;
      }

      // Ensure the audio graph is active before any API calls. After a long
      // pause the AudioContext may be suspended, which prevents the ticker
      // and PCM consumption from running.
      if (window.startSpotifyAudio) window.startSpotifyAudio();

      // Always ensure mode is spotify and ticker is running before API calls.
      // After a long pause the ticker may have been stopped and mode lost.
      PlaybackState.setMode('spotify');
      startSpotifyPositionTicker();

      // Tell the renderer what position we expect so it can block unmuting
      // until a playing event confirms the device is actually there. This
      // prevents the audible blip when the device ignores position_ms and
      // starts from 0, and prevents delayed events from previous playthroughs
      // from corrupting the position anchor.
      window.expectedResumePos = resumePos;
      window.expectedResumeUri = resumeUri;

      if (window.flushSpotifyBuffers) window.flushSpotifyBuffers(resumePos, 8);
      PlaybackState.setProgress(resumePos, null);
      PlaybackState.setPlaying(true);

      // Pass the in-app queue so Spotify keeps context across the resume.
      // Without this, the play() call resets the queue to a single track and
      // Spotify can no longer auto-advance when a track finishes.
      const q = window.spotifyQueue;
      const idx = window.spotifyCurrentIndex;
      const resumeQueueUris = (q && Array.isArray(q) && idx != null && idx >= 0 && idx < q.length)
        ? q.slice(idx).map(t => t.uri).filter(Boolean)
        : [resumeUri];

      // Atomic play: single endpoint with exact track + exact position.
      const result = await window.electronAPI.librespotPlay(resumePos, resumeUri, resumeQueueUris).catch(e => {
        console.error("[Player] Play IPC error:", e);
        return { success: false, error: e.message };
      });

      if (!result?.success) {
        window.expectedResumePos = null;
        window.expectedResumeUri = null;
        console.warn('[Player] Play IPC failed, reverting');
        PlaybackState.setPlaying(false);
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
  if (PlaybackState.mode !== 'local') return;
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

    // Flush old PCM and set the anchor atomically so the 50ms ticker
    // never reads a temporary 0 and snaps the UI to start.
    if (window.flushSpotifyBuffers) window.flushSpotifyBuffers(newPos);

    PlaybackState.setProgress(newPos, null);

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
    showToast("Type a folder path first, then click Apply", "error");
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
      showToast("Enter your Spotify Client ID and Secret to connect", "error");
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
        showToast(friendlySpotifyError(result.error), "error");
      }
    } catch (e) {
      showToast(friendlySpotifyError(e.message), "error");
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
        showToast("Could not disconnect from Spotify — try again", "error");
      }
    } catch (e) {
      showToast("Could not disconnect from Spotify — try again", "error");
    }
  });

// --- Spotify position ticker (sample-based) ---
let spotifyPositionInterval = null;
let lastPosSave = 0;

function startSpotifyPositionTicker() {
  if (spotifyPositionInterval) return;
  spotifyPositionInterval = setInterval(() => {
    if (PlaybackState.mode !== 'spotify' || !PlaybackState.isPlaying) return;
    if (window.getSpotifyPosition) {
      const pos = window.getSpotifyPosition();
      if (pos != null) {
        PlaybackState.positionMs = pos;
        PlaybackState.setProgress(null, null);
        // Constantly save position so resume always has a fresh value
        if (window.spPausePosKey && pos > 0 && Date.now() - lastPosSave > 1000) {
          lastPosSave = Date.now();
          try {
            localStorage.setItem(window.spPausePosKey, JSON.stringify({ pos: Math.floor(pos), ts: Date.now() }));
          } catch (_) {}
        }
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

// --- Friendly error messages ---
function friendlySpotifyError(msg) {
  if (!msg) return 'Something went wrong with Spotify'
  const m = msg.toLowerCase()
  if (m.includes('access_denied')) return 'Spotify access was denied — try connecting again'
  if (m.includes('invalid state')) return 'Login check failed — try connecting again'
  if (m.includes('token exchange') || m.includes('401') || m.includes('invalid_client'))
    return 'Invalid Spotify credentials — check your Client ID and Secret'
  if (m.includes('timed out') || m.includes('timeout') || m.includes('abort'))
    return 'Connection timed out — check your internet and try again'
  if (m.includes('eaddrinuse') || m.includes('callback server'))
    return 'Could not start the login server — try again in a moment'
  if (m.includes('not authenticated'))
    return 'Sign in to Spotify first'
  if (m.includes('403')) return 'You don\'t have permission for this on Spotify'
  if (m.includes('404')) return 'Spotify device not found — your network may be blocking Spotify'
  if (m.includes('429')) return 'Too many requests — wait a moment and try again'
  if (m.includes('no device')) return 'No Spotify device connected — try reconnecting'
  if (m.includes('no track uri') || m.includes('no api endpoint'))
    return 'Something went wrong — try again'
  return 'Something went wrong with Spotify — try again'
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
    return { success: false, error: 'play-in-progress' };
  }

  PlaybackState.pendingPromise = Promise.resolve();

  // Always flush old PCM so the previous track doesn't bleed in.
  // Pass 0 so the anchor is set immediately and the ticker never reads temp 0.
  if (window.flushSpotifyBuffers) window.flushSpotifyBuffers(0);

  PlaybackState.setMode('spotify');
  PlaybackState.positionMs = 0;
  PlaybackState.lastUserActionTime = Date.now();
  startSpotifyPositionTicker();

  if (window.startSpotifyAudio) {
    window.startSpotifyAudio();
  } else {
    console.error("[player.js] window.startSpotifyAudio is MISSING");
  }

  // Set playing state immediately — the user explicitly requested playback.
  PlaybackState.setPlaying(true);

  // Save initial pause state for this track so resume knows what to play.
  try {
    localStorage.setItem('tvm-pause-state', JSON.stringify({ uri, pos: 0, ts: Date.now() }));
  } catch (_) {}

  let deviceId;
  try {
    deviceId = await window.electronAPI.getLibrespotDeviceId();
  } catch (e) {
    showToast("Failed to get Spotify device ID — try reconnecting", "error");
    PlaybackState.reset();
    return { success: false, error: e.message };
  }

  if (!deviceId) {
    showToast("Spotify isn't connected — try reconnecting in Settings", "error");
    PlaybackState.reset();
    return;
  }

  // Transfer playback to our device (no-op if already active)
  if (!PlaybackState.isDeviceActive) {
    const xfer = await window.electronAPI.spotifyTransferPlayback(deviceId, true);

    if (!xfer.success) {
      const errMsg = (xfer.error && xfer.error.includes('404'))
        ? 'Spotify device not reachable — your network may be blocking Spotify'
        : friendlySpotifyError(xfer.error);
      showToast(errMsg, "error");
      PlaybackState.reset();
      return;
    }
    PlaybackState.isDeviceActive = true;
  }

  // Pass the full in-app queue (from current index onward) so Spotify
  // can auto-advance when a track finishes instead of getting stuck.
  const q = window.spotifyQueue;
  const idx = window.spotifyCurrentIndex;
  const queueUris = (q && Array.isArray(q) && idx != null && idx >= 0 && idx < q.length)
    ? q.slice(idx).map(t => t.uri).filter(Boolean)
    : [uri];

  const playPromise = window.electronAPI.spotifyPlayTrack(uri, deviceId, queueUris);
  PlaybackState.pendingPromise = playPromise;
  let result;
  try {
    result = await playPromise;
  } catch (e) {
    console.error("[player.js] Play IPC error:", e);
    result = { success: false, error: e.message };
  } finally {
    PlaybackState.pendingPromise = null;
  }

  if (!result.success) {
    showToast(friendlySpotifyError(result.error), "error");
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
