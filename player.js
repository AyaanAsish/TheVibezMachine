// At the top of player.js
const audio = new Audio();
audio.crossOrigin = "anonymous";
let queue = [];
let current = 0;
let audioSource = null;

// Convert a local filesystem path to a file:// URL so the HTML5 Audio element
// can load it when the app is served from http://127.0.0.1:3000.
function toFileUrl(p) {
  if (!p) return '';
  if (p.startsWith('file://') || p.startsWith('http://') || p.startsWith('https://')) return p;
  return 'file://' + p;
}

/**
 * THE AUTO-CONNECTOR
 * This function handles the "wiring" and ensures it only happens once.
 */
function ensureAudioConnection() {
  // 1. Check if the visualizer is actually ready
  if (!window.myVisualizer || !window.visualizerAudioContext) {
    console.warn("[Player] Waiting for Visualizer to initialize...");
    return false;
  }

  // 2. Create the source if it doesn't exist
  if (!audioSource) {
    try {
      audioSource =
        window.visualizerAudioContext.createMediaElementSource(audio);

      // 3. Connect to Speakers (createMediaElementSource doesn't auto-play)
      audioSource.connect(window.visualizerAudioContext.destination);

      console.log("[Player] Audio source created.");
    } catch (e) {
      console.error("[Player] Connection error:", e);
      return false;
    }
  }

  // 4. Always reconnect to Butterchurn so it analyzes the local audio
  // (needed when switching back from Spotify which uses a different source)
  window.myVisualizer.connectAudio(audioSource);

  // 5. Always try to wake up the context
  if (window.visualizerAudioContext.state === "suspended") {
    window.visualizerAudioContext.resume();
  }

  return true;
}

function connectToVisualizer() {
  ensureAudioConnection();
}

function getActiveQueue() {
  return window.playerQueue && window.playerQueue.length > 0 ? window.playerQueue : queue;
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
  const activeQueue = getActiveQueue();
  current = index;

  // Switching to local playback: pause Spotify and reset flag
  if (window.isSpotifyPlayback) {
    if (window.spotifyPause) window.spotifyPause();
    window.isSpotifyPlayback = false;
  }

  if (activeQueue.length > 0) {
    audio.src = toFileUrl(activeQueue[index]);

    // We try to connect here, but the Play Button click is the "real" trigger
    connectToVisualizer();

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
document.getElementById("btn-play").addEventListener("click", () => {
  if (window.isSpotifyPlayback) {
    window.spotifyTogglePlay();
    return;
  }

  connectToVisualizer();

  if (audio.paused) {
    audio.play();
  } else {
    audio.pause();
  }
});

document.getElementById("btn-prev").addEventListener("click", () => {
  if (window.isSpotifyPlayback) {
    window.spotifyPreviousTrack();
    return;
  }

  const activeQueue = getActiveQueue();
  if (current > 0) loadTrack(current - 1);
});

document.getElementById("btn-next").addEventListener("click", () => {
  if (window.isSpotifyPlayback) {
    window.spotifyNextTrack();
    return;
  }

  const activeQueue = getActiveQueue();
  if (current < activeQueue.length - 1) loadTrack(current + 1);
});

let previousVolume = 1;

document.getElementById("btn-mute").addEventListener("click", () => {
  if (window.isSpotifyPlayback) {
    const btn = document.getElementById("btn-mute");
    btn.classList.toggle("muted");
    const newVol = btn.classList.contains("muted") ? 0 : previousVolume;
    window.spotifySetVolume(newVol);
    return;
  }

  const btn = document.getElementById("btn-mute");
  btn.classList.toggle("muted");
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
    li.textContent = f.split("/").pop();
    li.addEventListener("click", () => loadTrack(i));
    list.appendChild(li);
  });
}

// --- Progress bar ---
const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");

audio.addEventListener("timeupdate", () => {
  if (window.isSpotifyPlayback) return;
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  progressFill.style.width = pct + "%";
  document.getElementById("current-time").textContent = fmt(audio.currentTime);
  document.getElementById("duration").textContent = fmt(audio.duration || 0);
  document.getElementById("btn-play").textContent = audio.paused ? "▶" : "⏸";
});

progressBar.addEventListener("click", (e) => {
  const ratio = e.offsetX / progressBar.offsetWidth;
  if (window.isSpotifyPlayback && window.spotifyPlaybackState) {
    const duration = window.spotifyPlaybackState.track_window.current_track.duration_ms || 1;
    window.spotifySeek(Math.floor(ratio * duration));
    return;
  }
  audio.currentTime = ratio * audio.duration;
});

// --- Volume ---
document.getElementById("volume").addEventListener("input", (e) => {
  const val = parseFloat(e.target.value);
  if (window.isSpotifyPlayback) {
    window.spotifySetVolume(val);
    previousVolume = val;
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
  const rawName = activeQueue[current]?.split("/").pop() || "No track loaded";
  const name = rawName.replace(/\.[^/.]+$/, '');
  const ele = document.getElementById("track-name");
  ele.textContent = name;

  // Add/Remove scrolling animation
  if (ele.scrollWidth > ele.clientWidth) {
    ele.classList.add('scroll-animation');
  }
  else ele.classList.remove('scroll-animation');
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

// --- Settings: Spotify Connect ---
document.getElementById("spotifyConnect").addEventListener("click", async () => {
  const clientId = document.getElementById("spotifyClientId").value.trim();
  const clientSecret = document.getElementById("spotifyClientSecret").value.trim();

  if (!clientId || !clientSecret) {
    alert("Please enter both Spotify Client ID and Client Secret.");
    return;
  }

  try {
    const result = await window.electronAPI.spotifyAuth(clientId, clientSecret);
    if (result.success) {
      alert("Spotify connected!");
      document.getElementById("spotifyClientSecret").value = "";
    } else {
      alert("Spotify connection failed: " + (result.error || "Unknown error"));
    }
  } catch (e) {
    alert("Spotify connection error: " + e.message);
  }
});

// --- Settings: Spotify Disconnect ---
document.getElementById("spotifyDisconnect").addEventListener("click", async () => {
  try {
    const result = await window.electronAPI.spotifyDisconnect();
    if (result.success) {
      alert("Spotify disconnected. Please reconnect with your Client ID and Secret to refresh permissions.");
    } else {
      alert("Failed to disconnect: " + (result.error || "Unknown error"));
    }
  } catch (e) {
    alert("Disconnect error: " + e.message);
  }
});

// --- Expose for library.js ---
window.loadPlayerTrack = loadTrack;
window.renderPlaylist = renderPlaylist;
window.pauseLocalAudio = () => {
  audio.pause();
  audio.src = '';
};
