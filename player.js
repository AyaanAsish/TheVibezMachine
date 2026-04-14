const path = require('path');

const audio = new Audio()
let queue = []      // array of file paths
let current = 0    // index into queue
let path = path.join('/Library')

// Load the dbManager script
require('./dbManager.js');


// --- File loading ---
document.getElementById('btn-open').addEventListener('click', async () => {
  path = getFolderPath()
})

async function getFolderPath() {
  const options = {
    properties: ['openDirectory'], // Specify that we want to open a directory (folder)
  };

  try {
    const result = await dialog.showOpenDialog({ properties: options.properties });
    if (result.canceled) return; // User canceled the dialog

    const filePaths = result.filePaths;
    return filePaths
  } catch (error) {
    console.error('Error opening dialog:', error);
  }
}

async function listFolderContents(filePath) {
  try {
    const entries = await fs.promises.readdir(filePath, { withFileTypes: true });

    // Filter out directories and files
    const folders = entries.filter(entry => entry.isDirectory());
    const files = entries.filter(entry => !entry.isDirectory());

    if(folders.length == 0){
      const dbManager = window.dbManager;
      await new Promise((resolve, reject) => {
        dbManager.insertItem(filepath);
        resolve();
      });

      document.getElementById('queryButton').addEventListener('click', async () => {
        const dbManager = window.dbManager;

        // Query the first item from the database
        try {
          const result = await new Promise((resolve, reject) => {
            dbManager.queryItems(resolve);
          });

          console.log("First Database Item:", result ? result.name : "No items found");
        } catch (error) {
          console.error('Error querying database:', error.message);
        }
      });

    }

    return { folders, files };
  } catch (error) {
    console.error('Error reading directory:', error);
    throw error;
  }
}

function loadTrack(index) {
  current = index
  // file:// protocol lets the renderer load local files
  audio.src = path +
  audio.play()
  updateTrackName()
  highlightActive()
}

// --- Controls ---
document.getElementById('btn-play').addEventListener('click', () => {QQwwwwwwwwwwww∑∑az
  audio.paused ? audio.play() : audio.pause()
})

document.getElementById('btn-prev').addEventListener('click', () => {
  if (current > 0) loadTrack(current - 1)
})

document.getElementById('btn-next').addEventListener('click', () => {
  if (current < queue.length - 1) loadTrack(current + 1)
})

audio.addEventListener('ended', () => {
  if (current < queue.length - 1) loadTrack(current + 1)
})

// --- Progress bar ---
const progressBar = document.getElementById('progress-bar')
const progressFill = document.getElementById('progress-fill')

audio.addEventListener('timeupdate', () => {
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0
  progressFill.style.width = pct + '%'
  document.getElementById('current-time').textContent = fmt(audio.currentTime)
  document.getElementById('duration').textContent = fmt(audio.duration || 0)
  document.getElementById('btn-play').textContent = audio.paused ? '▶' : '⏸'
})

progressBar.addEventListener('click', (e) => {
  const ratio = e.offsetX / progressBar.offsetWidth
  audio.currentTime = ratio * audio.duration
})

// --- Volume ---
document.getElementById('volume').addEventListener('input', (e) => {
  audio.volume = e.target.value
})

// --- Playlist UI ---
function renderPlaylist() {
  const ul = document.getElementById('playlist')
  ul.innerHTML = ''
  queue.forEach((path, i) => {
    const li = document.createElement('li')
    li.textContent = path.split(/[\\/]/).pop()  // just the filename
    li.addEventListener('click', () => loadTrack(i))
    ul.appendChild(li)
  })
}

function highlightActive() {
  document.querySelectorAll('#playlist li').forEach((li, i) => {
    li.classList.toggle('active', i === current)
  })
}

function updateTrackName() {
  const name = queue[current].split(/[\\/]/).pop()
  document.getElementById('track-name').textContent = name
}

function fmt(s) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60).toString().padStart(2, '0')
  return `${m}:${sec}`
}
