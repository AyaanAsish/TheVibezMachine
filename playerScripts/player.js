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
          await window.spotifyPlayTrack(q[newIdx].uri);
          window.spotifyCurrentIndex = newIdx;
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
        try { localStorage.setItem(window.spPausePosKey, JSON.stringify({ pos: Math.floor(pausePos), ts: Date.now() })); } catch (_) {}
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
      // --- RESUME: play from saved position ---
      let savedPause = null;
      if (window.spPausePosKey) {
        try {
          const raw = localStorage.getItem(window.spPausePosKey);
          if (raw) {
            const saved = JSON.parse(raw);
            // Only use saved position if it's recent (< 30 min old) and not zero
            if (saved.pos > 0 && Date.now() - saved.ts < 1800000) {
              savedPause = saved;
            }
          }
        } catch (_) {}
      }

      let resumePos = savedPause ? savedPause.pos : null;

      // Guard rails: discard saved position in scenarios that cause skips.
      // - Near end of track (< 10s remaining): seeking here can immediately
      //   trigger end_of_track and advance to the next song.
      // - Pause lasted longer than remaining track time: Spotify may have
      //   internally advanced the queue while we were paused.
      // - Very long pause (> 5 min): device may have been dropped; resuming
      //   from start is safer than risking a wrong-position resume.
      if (resumePos != null && PlaybackState.durationMs > 0) {
        const remaining = PlaybackState.durationMs - resumePos;
        const pauseDuration = Date.now() - savedPause.ts;
        if (remaining < 10000 || pauseDuration > remaining || pauseDuration > 300000) {
          resumePos = null;
        }
      }

      // Extract the track URI from the pause key so the main process can
      // use the explicit /v1/me/player/play endpoint with position_ms.
      // This is more reliable than generic play + separate seek.
      const trackUri = window.spPausePosKey ? window.spPausePosKey.replace('tvm-pause-', '') : null;

      // Raise prebuffer threshold so wrong-position PCM that arrives
      // during the IPC round-trip is absorbed silently.
      // Also set resume guard to prevent playing events from overwriting
      // the anchor until the seek has landed.
      if (window.setPrebufferThreshold) window.setPrebufferThreshold(8);
      if (window.setResumeGuard) window.setResumeGuard(true);

      if (resumePos != null) {
        if (window.resetSpotifyPositionAnchor) window.resetSpotifyPositionAnchor(resumePos);
        PlaybackState.setProgress(resumePos, null);
      }
      if (window.flushSpotifyBuffers) window.flushSpotifyBuffers();

      PlaybackState.setPlaying(true);

      const result = await window.electronAPI.librespotPlay(resumePos, trackUri).catch(e => {
        console.error("[Player] Play IPC error:", e);
        return { success: false, error: e.message };
      });

      // After IPC: set seek target to block unmuting until the position
      // is confirmed, flush stale PCM, reset threshold, and do a second
      // seek for safety. The resume guard stays up until the second seek
      // has time to land.
      if (resumePos != null && result?.success) {
        if (window.setResumeSeekTarget) window.setResumeSeekTarget(resumePos);
        if (window.flushSpotifyBuffers) window.flushSpotifyBuffers();
        if (window.resetPrebufferThreshold) window.resetPrebufferThreshold();
        if (window.resetSpotifyPositionAnchor) window.resetSpotifyPositionAnchor(resumePos);
        window.electronAPI.librespotSeek(resumePos).catch(() => {});
        // Release the resume guard after a short delay to let the second
        // seek's playing event arrive and be accepted.
        setTimeout(() => {
          if (window.setResumeGuard) window.setResumeGuard(false);
        }, 1500);
      } else if (!result?.success) {
        if (window.resetPrebufferThreshold) window.resetPrebufferThreshold();
        if (window.setResumeGuard) window.setResumeGuard(false);
        console.warn('[Player] Play IPC failed, reverting');
        PlaybackState.setPlaying(false);
      } else {
        if (window.resetPrebufferThreshold) window.resetPrebufferThreshold();
        if (window.setResumeGuard) window.setResumeGuard(false);
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

    PlaybackState.setProgress(newPos, null);
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
  PlaybackState.setPlaying(true);

  // Each track gets its own localStorage key for pause-position persistence
  window.spPausePosKey = 'tvm-pause-' + uri;

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

  const playPromise = window.electronAPI.spotifyPlayTrack(uri, deviceId);
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
