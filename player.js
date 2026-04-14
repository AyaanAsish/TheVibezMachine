const audio = new Audio()
let queue = []
let current = 0

// --- Folder loading ---
document.getElementById('btn-open').addEventListener('click', async () => {
  const result = await window.electronAPI.openFolder()
  if (!result || !result.files.length) return

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
  audio.src = queue[index]
  audio.play()
}

function renderPlaylist() {
  const list = document.getElementById('playlist')
  if (!list) return
  list.innerHTML = ''
  queue.forEach((f, i) => {
    const li = document.createElement('li')
    li.textContent = f.split('/').pop()  // just the filename
    li.addEventListener('click', () => {
      current = i
      loadTrack(current)
    })
    list.appendChild(li)
  })
}
