const audio = new Audio();
let queue = [];
let current = 0;

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
  current = index;
  audio.src = queue[index];
  audio.play();
  updateTrackName();
  highlightActive();
}

// --- Controls ---
document.getElementById("btn-play").addEventListener("click", () => {
  audio.paused ? audio.play() : audio.pause();
});

document.getElementById("btn-prev").addEventListener("click", () => {
  if (current > 0) loadTrack(current - 1);
});

document.getElementById("btn-next").addEventListener("click", () => {
  if (current < queue.length - 1) loadTrack(current + 1);
});

let previousVolume = 1;

document.getElementById("btn-mute").addEventListener("click", () => {
  const btn = document.getElementById("btn-mute");
  btn.classList.toggle("muted");
  if (audio.volume > 0) {
    previousVolume = audio.volume;
    audio.volume = 0;
    document.getElementById("btn-mute").style.backgroundImage = "url('assets/images/volume_off.png')";
  } else {
    audio.volume = previousVolume;
    document.getElementById("btn-mute").style.backgroundImage = "url('assets/images/volume_on.png')";
  }
});

audio.addEventListener("ended", () => {
  if (current < queue.length - 1) loadTrack(current + 1);
});

function renderPlaylist() {
  const list = document.getElementById("playlist");
  if (!list) return;
  list.innerHTML = "";
  queue.forEach((f, i) => {
    const li = document.createElement("li");
    li.textContent = f.split(/[\\/]/).pop();
    li.addEventListener("click", () => loadTrack(i)); // li and i exist here
    list.appendChild(li);
  });
}

// --- Progress bar ---
const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");

audio.addEventListener("timeupdate", () => {
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  progressFill.style.width = pct + "%";
  document.getElementById("current-time").textContent = fmt(audio.currentTime);
  document.getElementById("duration").textContent = fmt(audio.duration || 0);
  document.getElementById("btn-play").textContent = audio.paused ? "▶" : "⏸";
});

progressBar.addEventListener("click", (e) => {
  const ratio = e.offsetX / progressBar.offsetWidth;
  audio.currentTime = ratio * audio.duration;
});

// --- Volume ---
document.getElementById("volume").addEventListener("input", (e) => {
  audio.volume = e.target.value;
});

function highlightActive() {
  document.querySelectorAll("#playlist li").forEach((li, i) => {
    li.classList.toggle("active", i === current);
  });
}

function updateTrackName() {
  const name = queue[current].split(/[\\/]/).pop();
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
