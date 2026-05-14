// At the top of player.js
const audio = new Audio();
audio.crossOrigin = "anonymous";
let queue = [];
let current = 0;
let audioSource = null;

// Convert a local filesystem path to a file:// URL so the HTML5 Audio element
// can load it when the app is served from http://127.0.0.1:3000.
function toFileUrl(p) {
  if (!p) return "";
  if (
    p.startsWith("file://") ||
    p.startsWith("http://") ||
    p.startsWith("https://")
  )
    return p;
  const normalized = p.replace(/\\/g, "/");
  return "file:///" + normalized.replace(/^\/+/, "");
}

/**
 * THE AUTO-CONNECTOR
 * This function handles the "wiring" and ensures it only happens once.
 */
let localAudioConnected = false;

function ensureAudioConnection() {
  if (!window.myVisualizer || !window.visualizerAudioContext) {
    console.warn("[Player] Waiting for Visualizer to initialize...");
    return false;
  }

  if (!audioSource) {
    try {
      audioSource =
        window.visualizerAudioContext.createMediaElementSource(audio);
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
  console.log("[player.js] btn-open clicked");
  const result = await window.electronAPI.openFolder();
  console.log("[player.js] openFolder result:", result);
  if (!result || !result.files.length) return;

  // Set the library path and update the path textarea
  document.getElementById("path").value = result.folder;
  console.log("[player.js] calling setLibraryPath with:", result.folder);
  window.setLibraryPath(result.folder);

  const audioExt = [".mp3", ".wav", ".flac", ".ogg", ".m4a"];
  queue = result.files.filter((f) =>
    audioExt.some((ext) => f.toLowerCase().endsWith(ext)),
  );
  if (!queue.length) return;

  current = 0;
  renderPlaylist();
  loadTrack(current);
});

function loadTrack(index) {
  if (window.disconnectLocalAudio) window.disconnectLocalAudio();

  const activeQueue = getActiveQueue();
  current = index;

  if (window.isSpotifyPlayback) {
    window.lastLocalSwitchTime = Date.now();
    if (window.stopSpotifyAudio) window.stopSpotifyAudio();
    if (window.electronAPI?.librespotPause) window.electronAPI.librespotPause();
    window.isSpotifyPlayback = false;
    window.spotifyIsPlaying = false;
    window.spotifyPositionMs = 0;
    stopSpotifyPositionTicker();
  }

  audio.pause();
  audio.src = "";
  audio.load();

  if (activeQueue.length > 0) {
    audio.src = toFileUrl(activeQueue[index]);

    // We try to connect here, but the Play Button click is the "real" trigger
    ensureAudioConnection();

    audio
      .play()
      .then(() => {
        // Double-check resume after play starts
        if (
          window.visualizerAudioContext &&
          window.visualizerAudioContext.state === "suspended"
        ) {
          window.visualizerAudioContext.resume();
        }
      })
      .catch((err) => console.error("Playback error:", err));

    updateTrackName();
    highlightActive();
  }
}

// --- Controls ---
document.getElementById("btn-play").addEventListener("click", async () => {
  if (window.isSpotifyPlayback) {
    if (window.spotifyStatePending) return;
    if (window.startSpotifyAudio) window.startSpotifyAudio();

    const wasPlaying = window.spotifyIsPlaying;
    const target = wasPlaying ? "pause" : "play";
    window.spotifyStatePending = target;

    // Optimistic UI update
    window.spotifyIsPlaying = !wasPlaying;
    document
      .getElementById("btn-play")
      .classList.toggle("paused", !window.spotifyIsPlaying);

    const ipcFn = wasPlaying
      ? window.electronAPI.librespotPause
      : window.electronAPI.librespotPlay;
    const result = await ipcFn();

    window.spotifyStatePending = null;

    if (result && result.state) {
      const actualPlaying = result.state === "playing";
      if (actualPlaying !== window.spotifyIsPlaying) {
        window.spotifyIsPlaying = actualPlaying;
        document
          .getElementById("btn-play")
          .classList.toggle("paused", !actualPlaying);
      }
    }
    return;
  }

  ensureAudioConnection();

  if (audio.paused) {
    audio.play();
  } else {
    audio.pause();
  }
});

document.getElementById("btn-prev").addEventListener("click", () => {
  if (window.isSpotifyPlayback) {
    if (window.startSpotifyAudio) window.startSpotifyAudio();
    const q = window.spotifyQueue;
    const idx = window.spotifyCurrentIndex;
    if (q && Array.isArray(q) && idx != null && idx > 0 && q[idx - 1]?.uri) {
      window.spotifyCurrentIndex = idx - 1;
      window.spotifyPlayTrack(q[idx - 1].uri);
    } else {
      window.electronAPI.librespotPrev();
    }
    return;
  }

  const activeQueue = getActiveQueue();
  if (current > 0) loadTrack(current - 1);
});

document.getElementById("btn-next").addEventListener("click", () => {
  if (window.isSpotifyPlayback) {
    if (window.startSpotifyAudio) window.startSpotifyAudio();
    const q = window.spotifyQueue;
    const idx = window.spotifyCurrentIndex;
    if (
      q &&
      Array.isArray(q) &&
      idx != null &&
      idx < q.length - 1 &&
      q[idx + 1]?.uri
    ) {
      window.spotifyCurrentIndex = idx + 1;
      window.spotifyPlayTrack(q[idx + 1].uri);
    } else {
      window.electronAPI.librespotNext();
    }
    return;
  }

  const activeQueue = getActiveQueue();
  if (current < activeQueue.length - 1) loadTrack(current + 1);
});

let previousVolume = 1;
window.spotifyPositionMs = 0;
window.spotifyDurationMs = 0;

document.getElementById("btn-mute").addEventListener("click", () => {
  const btn = document.getElementById("btn-mute");
  btn.classList.toggle("muted");
  const newVol = btn.classList.contains("muted") ? 0 : previousVolume;

  if (window.isSpotifyPlayback) {
    if (window.setSpotifyVolume) window.setSpotifyVolume(newVol);
    return;
  }

  if (audio.volume > 0) {
    previousVolume = audio.volume;
    audio.volume = 0;
  } else {
    audio.volume = previousVolume;
  }
});

audio.addEventListener("ended", () => {
  const activeQueue = getActiveQueue();
  if (current < activeQueue.length - 1) loadTrack(current + 1);
});

function renderPlaylist() {
  const activeQueue = getActiveQueue();
  window.playerQueue = activeQueue;
  const list = document.getElementById("playlist");
  if (!list) return;
  list.innerHTML = "";
  activeQueue.forEach((f, i) => {
    const li = document.createElement("li");
    li.textContent = f.replace(/\\/g, "/").split("/").pop();
    li.addEventListener("click", () => loadTrack(i));
    list.appendChild(li);
  });
}

// --- Progress bar ---
const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");

audio.addEventListener("play", () => {
  if (window.isSpotifyPlayback) return;
  document.getElementById("btn-play").classList.add("paused");
});

audio.addEventListener("pause", () => {
  if (window.isSpotifyPlayback) return;
  document.getElementById("btn-play").classList.remove("paused");
});

audio.addEventListener("timeupdate", () => {
  if (window.isSpotifyPlayback) return;
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  progressFill.style.width = pct + "%";
  document.getElementById("current-time").textContent = fmt(audio.currentTime);
  document.getElementById("duration").textContent = fmt(audio.duration || 0);
});

progressBar.addEventListener("click", (e) => {
  const ratio = e.offsetX / progressBar.offsetWidth;
  if (window.isSpotifyPlayback) {
    if (window.startSpotifyAudio) window.startSpotifyAudio();
    const duration = window.spotifyDurationMs || 1;
    window.electronAPI.librespotSeek(Math.floor(ratio * duration));
    return;
  }
  audio.currentTime = ratio * audio.duration;
});

// --- Volume ---
document.getElementById("volume").addEventListener("input", (e) => {
  const val = parseFloat(e.target.value);
  previousVolume = val;
  if (window.isSpotifyPlayback) {
    if (window.setSpotifyVolume) window.setSpotifyVolume(val);
    return;
  }
  audio.volume = val;
});

function highlightActive() {
  // Highlight footer playlist
  document.querySelectorAll("#playlist li").forEach((li, i) => {
    li.classList.toggle("active", i === current);
  });

  // Highlight library tracklist
  document.querySelectorAll(".tracklist-item").forEach((li, i) => {
    li.classList.toggle("active", i === current);
  });
}

function updateTrackName() {
  const activeQueue = getActiveQueue();
  const rawName =
    activeQueue[current]?.replace(/\\/g, "/").split("/").pop() ||
    "No track loaded";
  const name = rawName.replace(/\.[^/.]+$/, "");
  const ele = document.getElementById("track-name");
  ele.textContent = name;

  // Add/Remove scrolling animation
  if (ele.scrollWidth > ele.clientWidth) {
    ele.classList.add("scroll-animation");
  } else ele.classList.remove("scroll-animation");
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
  const pathInput = document.getElementById("path").value.trim();
  console.log("[player.js] applyPath clicked, input:", pathInput);
  if (pathInput) {
    window.setLibraryPath(pathInput);
  }
});

// --- Settings: Clear Library ---
document.getElementById("clearLibrary").addEventListener("click", async () => {
  await window.electronAPI.dbClearLibrary();
  document.getElementById("path").value = "";
  loadLibrary();
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
      alert("Please enter both Spotify Client ID and Client Secret.");
      return;
    }

    try {
      const result = await window.electronAPI.spotifyAuth(
        clientId,
        clientSecret,
      );
      if (result.success) {
        alert("Spotify connected!");
        document.getElementById("spotifyClientSecret").value = "";
      } else {
        alert(
          "Spotify connection failed: " + (result.error || "Unknown error"),
        );
      }
    } catch (e) {
      alert("Spotify connection error: " + e.message);
    }
  });

// --- Settings: Spotify Disconnect ---
document
  .getElementById("spotifyDisconnect")
  .addEventListener("click", async () => {
    try {
      const result = await window.electronAPI.spotifyDisconnect();
      if (result.success) {
        alert(
          "Spotify disconnected. Please reconnect with your Client ID and Secret to refresh permissions.",
        );
      } else {
        alert("Failed to disconnect: " + (result.error || "Unknown error"));
      }
    } catch (e) {
      alert("Disconnect error: " + e.message);
    }
  });

// --- Spotify position ticker ---
let spotifyPositionInterval = null;

function startSpotifyPositionTicker() {
  if (spotifyPositionInterval) return;
  spotifyPositionInterval = setInterval(() => {
    if (!window.isSpotifyPlayback || !window.spotifyIsPlaying) return;
    window.spotifyPositionMs += 200;
    const duration = window.spotifyDurationMs || 1;
    const pct = (window.spotifyPositionMs / duration) * 100;
    const fill = document.getElementById("progress-fill");
    const curTime = document.getElementById("current-time");
    const durEl = document.getElementById("duration");
    if (fill) fill.style.width = pct + "%";
    if (curTime) curTime.textContent = fmt(window.spotifyPositionMs / 1000);
    if (durEl) durEl.textContent = fmt(duration / 1000);
  }, 200);
}

function stopSpotifyPositionTicker() {
  if (spotifyPositionInterval) {
    clearInterval(spotifyPositionInterval);
    spotifyPositionInterval = null;
  }
}

// --- Global Spotify play ---
window.spotifyPlayTrack = async (uri) => {
  console.log("[player.js] spotifyPlayTrack called with uri:", uri);

  window.pauseLocalAudio();
  if (window.disconnectLocalAudio) window.disconnectLocalAudio();

  if (window.isSpotifyPlayback) {
    if (window.flushSpotifyBuffers) window.flushSpotifyBuffers();
  } else {
    if (window.stopSpotifyAudio) window.stopSpotifyAudio();
    window.isSpotifyPlayback = true;
  }

  if (window.startSpotifyAudio) {
    window.startSpotifyAudio();
  } else {
    console.error("[player.js] window.startSpotifyAudio is MISSING");
  }

  window.spotifyPositionMs = 0;
  startSpotifyPositionTicker();

  const deviceId = await window.electronAPI.getLibrespotDeviceId();
  console.log("[player.js] Librespot device ID:", deviceId);

  if (!deviceId) {
    console.error("[player.js] No librespot device ID available");
    window.lastLocalSwitchTime = Date.now();
    window.isSpotifyPlayback = false;
    window.spotifyIsPlaying = false;
    if (window.stopSpotifyAudio) window.stopSpotifyAudio();
    stopSpotifyPositionTicker();
    return;
  }

  const xfer = await window.electronAPI.spotifyTransferPlayback(deviceId, true);
  console.log("[player.js] Transfer result:", xfer);

  await new Promise((r) => setTimeout(r, 1500));

  const result = await window.electronAPI.spotifyPlayTrack(uri, deviceId);
  console.log("[player.js] Play result:", result);

  if (!result.success) {
    console.error("[player.js] Failed to play Spotify track:", result.error);
    window.lastLocalSwitchTime = Date.now();
    window.isSpotifyPlayback = false;
    window.spotifyIsPlaying = false;
    if (window.stopSpotifyAudio) window.stopSpotifyAudio();
    stopSpotifyPositionTicker();
  }
};

// --- Expose for library.js ---
window.loadPlayerTrack = loadTrack;
window.renderPlaylist = renderPlaylist;
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
