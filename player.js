const audio = new Audio();
let localQueue = [];
let localCurrent = 0;

// Helper to get active queue (window.playerQueue takes precedence)
function getActiveQueue() {
  return (window.playerQueue && window.playerQueue.length > 0) ? window.playerQueue : localQueue;
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
  localQueue = result.files.filter((f) =>
    audioExt.some((ext) => f.toLowerCase().endsWith(ext)),
  );
  if (!localQueue.length) return;

  localCurrent = 0;
  loadTrack(localCurrent);
});

function loadTrack(index) {
  const activeQueue = getActiveQueue();
  localCurrent = index;
  if (activeQueue.length > 0) {
    audio.src = activeQueue[index];
    audio.play();
    updateTrackName();
    highlightActive();
  }
}

// --- Controls ---
document.getElementById("btn-play").addEventListener("click", () => {
  if (window.isSpotifyPlayback) {
    window.spotifyTogglePlay();
  } else {
    audio.paused ? audio.play() : audio.pause();
  }
});

document.getElementById("btn-prev").addEventListener("click", () => {
  if (window.isSpotifyPlayback) {
    window.spotifyPreviousTrack();
  } else if (localCurrent > 0) {
    loadTrack(localCurrent - 1);
  }
});

document.getElementById("btn-next").addEventListener("click", () => {
  if (window.isSpotifyPlayback) {
    window.spotifyNextTrack();
  } else {
    const activeQueue = getActiveQueue();
    if (localCurrent < activeQueue.length - 1) loadTrack(localCurrent + 1);
  }
});

let previousVolume = 1;

document.getElementById("btn-mute").addEventListener("click", () => {
  const btn = document.getElementById("btn-mute");
  const slider = document.getElementById("volume");
  btn.classList.toggle("muted");
  if (audio.volume > 0) {
    previousVolume = audio.volume;
    audio.volume = 0;
    slider.value = 0;
    if (window.isSpotifyPlayback) window.spotifySetVolume(0);
  } else {
    audio.volume = previousVolume;
    slider.value = previousVolume;
    if (window.isSpotifyPlayback) window.spotifySetVolume(previousVolume);
  }
});

audio.addEventListener("ended", () => {
  if (window.isSpotifyPlayback) return;
  if (localCurrent < getActiveQueue().length - 1) loadTrack(localCurrent + 1);
});

// Removed: renderPlaylist() - footer playlist element doesn't exist in HTML

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
    const durationMs = window.spotifyPlaybackState.track_window.current_track.duration_ms;
    window.spotifySeek(Math.floor(ratio * durationMs));
  } else {
    audio.currentTime = ratio * audio.duration;
  }
});

// --- Volume ---
document.getElementById("volume").addEventListener("input", (e) => {
  const val = e.target.value;
  if (window.isSpotifyPlayback) {
    window.spotifySetVolume(val);
  }
  audio.volume = val;
});

function highlightActive() {
  // Highlight library tracklist
  document.querySelectorAll(".tracklist-item").forEach((li, i) => {
    li.classList.toggle("active", i === localCurrent);
  });
}

function updateTrackName() {
  const activeQueue = getActiveQueue();
  let name = activeQueue[localCurrent]?.split(/[\\/]/).pop() || "No track loaded";
  name = name.replace(/\.[^/.]+$/, "");
  document.getElementById("track-name").textContent = name;
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

// --- Spotify OAuth ---
document.getElementById("spotifyConnect").addEventListener("click", async () => {
  const clientId = document.getElementById("spotifyClientId").value.trim();
  const clientSecret = document.getElementById("spotifyClientSecret").value.trim();

  if (!clientId) {
    alert("Please enter your Spotify Client ID");
    return;
  }

  if (!clientSecret) {
    alert("Please enter your Spotify Client Secret");
    return;
  }

  console.log("[player.js] spotifyConnect clicked");

  // This opens browser and starts callback server, resolves when token exchange completes
  const result = await window.electronAPI.spotifyAuth(clientId, clientSecret);

  if (result.success) {
    console.log("[player.js] Spotify connected successfully!");
    alert("Spotify connected successfully!");
  } else {
    console.error("[player.js] Spotify auth failed:", result.error);
    alert("Failed to connect to Spotify: " + result.error);
  }
});

// --- Expose for library.js ---
window.loadPlayerTrack = (index) => {
  const activeQueue = getActiveQueue();
  localCurrent = index;
  if (activeQueue.length > 0) {
    audio.src = activeQueue[index];
    audio.play();
    updateTrackName();
    highlightActive();
  }
};

window.renderPlaylist = function() {
  const activeQueue = getActiveQueue();
  window.playerQueue = activeQueue;
};
