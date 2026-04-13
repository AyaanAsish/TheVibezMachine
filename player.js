const audio = new Audio()
let queue = []      // array of file paths
let current = 0    // index into queue

// --- Folder loading ---
document.getElementById('btn-open').addEventListener('click', async () => {
  const result = await window.electronAPI.openFolder()
  if (!result || !result.files.length) return

  // filter only audio files
  const audioExt = ['.mp3', '.wav', '.flac', '.ogg', '.m4a']
  queue = result.files.filter(f =>
    audioExt.some(ext => f.toLowerCase().endsWith(ext))
  )

  if (!queue.length) return

  current = 0
  renderPlaylist()
  loadTrack(current)
})

function loadTrack(index) {
  current = index
  // file:// protocol lets the renderer load local files
  audio.src = 'file://' + queue[index]
  audio.play()
  updateTrackName()
  highlightActive()
}

// --- Controls ---
document.getElementById('btn-play').addEventListener('click', () => {
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
