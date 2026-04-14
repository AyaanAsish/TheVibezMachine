let libraryPath = null

async function loadLibrary() {
  console.log('[library.js] loadLibrary called, libraryPath:', libraryPath)
  const container = document.querySelector('#library .items')
  if (!container) {
    console.log('[library.js] container not found!')
    return
  }

  container.innerHTML = ''

  if (!libraryPath) {
    container.innerHTML = '<p class="empty-message">No library path set. Go to Settings to add a folder.</p>'
    return
  }

  const result = await window.electronAPI.scanFolder(libraryPath)
  if (!result) {
    container.innerHTML = '<p class="empty-message">Error scanning folder.</p>'
    return
  }

  const audioExt = ['.mp3', '.wav', '.flac', '.ogg', '.m4a']

  // If there are subfolders, treat each as a playlist
  if (result.folders.length > 0) {
    for (const folder of result.folders) {
      const folderResult = await window.electronAPI.scanFolder(folder.path)
      if (folderResult && folderResult.audioFiles.length > 0) {
        createPlaylistCard(container, folder.name, folderResult.audioFiles, folderResult.coverImage)
      }
    }
  } else if (result.audioFiles.length > 0) {
    // No subfolders, treat the folder itself as a single playlist
    const playlistName = libraryPath.split('/').pop()
    createPlaylistCard(container, playlistName, result.audioFiles, result.coverImage)
  } else {
    container.innerHTML = '<p class="empty-message">No audio files found.</p>'
  }
}

function createPlaylistCard(container, name, audioFiles, coverImage) {
  const card = document.createElement('div')
  card.className = 'playlist-card'

  const coverImg = document.createElement('div')
  coverImg.className = 'playlist-cover'

  if (coverImage) {
    const img = document.createElement('img')
    img.src = 'file://' + coverImage
    img.alt = name
    coverImg.appendChild(img)
  } else {
    coverImg.innerHTML = '<div class="no-cover">🎵</div>'
  }

  const info = document.createElement('div')
  info.className = 'playlist-info'
  info.innerHTML = `<span class="playlist-name">${name}</span>`

  card.appendChild(coverImg)
  card.appendChild(info)

  card.addEventListener('click', () => {
    loadPlaylist(audioFiles)
  })

  container.appendChild(card)
}

function loadPlaylist(audioFiles) {
  const audio = new Audio()
  window.currentPlaylist = audioFiles.map(f => f.path)
  window.currentTrackIndex = 0

  if (window.currentPlaylist.length > 0) {
    audio.src = window.currentPlaylist[0]
    audio.play()
    updateTrackName()
    if (typeof renderPlaylist === 'function') {
      renderPlaylist()
    }
  }
}

function updateTrackName() {
  const name = window.currentPlaylist?.[window.currentTrackIndex]?.split(/[\\/]/).pop() || 'No track loaded'
  document.getElementById('track-name').textContent = name
}

window.setLibraryPath = (path) => {
  console.log('[library.js] setLibraryPath called with:', path)
  libraryPath = path
  loadLibrary()
}