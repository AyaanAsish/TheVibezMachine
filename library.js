let libraryPath = null
let currentPlaylistData = null

async function loadLibrary() {
  console.log('[library.js] loadLibrary called, libraryPath:', libraryPath)
  const container = document.querySelector('#library .library-tracklist')
  const albumInfo = document.querySelector('#library .library-album-info')
  if (!container) {
    console.log('[library.js] container not found!')
    return
  }

  // Clear playlist view if any
  if (albumInfo) albumInfo.innerHTML = ''
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
  info.innerHTML = `<span class="playlist-name">${name.split('-')[0]}</span><span class="playlist-artist">${name.split('-')[1]}</span>`

  card.appendChild(coverImg)
  card.appendChild(info)

  card.addEventListener('click', () => {
    loadPlaylist(name, audioFiles, coverImage)
  })

  container.appendChild(card)
}

function loadPlaylist(name, audioFiles, coverImage) {
  console.log('[library.js] loadPlaylist called, name:', name, 'files:', audioFiles.length)

  currentPlaylistData = { name, audioFiles, coverImage }

  const tracklistContainer = document.querySelector('#library .library-tracklist')
  const albumInfo = document.querySelector('#library .library-album-info')

  if (!tracklistContainer || !albumInfo) return

  // Show tracklist on left (65%)
  tracklistContainer.innerHTML = ''

  // Add back button
  const backBtn = document.createElement('div')
  backBtn.className = 'library-back-btn'
  backBtn.innerHTML = '← Back to Library'
  backBtn.addEventListener('click', () => {
    loadLibrary()
  })
  tracklistContainer.appendChild(backBtn)

  audioFiles.forEach((file, index) => {
    const track = document.createElement('div')
    track.className = 'tracklist-item'
    const trackName = file.name.replace(/\.[^/.]+$/, '')
    track.innerHTML = `<span class="track-number">${index + 1}</span><span class="track-title">${trackName}</span>`
    track.addEventListener('click', () => {
      playTrack(index)
    })
    tracklistContainer.appendChild(track)
  })

  // Show album info on right (35%)
  albumInfo.innerHTML = ''
  const infoCard = document.createElement('div')
  infoCard.className = 'album-info-card'

  if (coverImage) {
    infoCard.innerHTML = `
      <img src="file://${coverImage}" alt="${name}" class="album-cover-large">
      <div class="album-name">${name}</div>
      <div class="album-artist">${audioFiles.length} tracks</div>
      <button class="playlist-play-btn">Play</button>
    `
  } else {
    infoCard.innerHTML = `
      <div class="album-cover-large no-cover">🎵</div>
      <div class="album-name">${name}</div>
      <div class="album-artist">${audioFiles.length} tracks</div>
      <button class="playlist-play-btn">Play</button>
    `
  }

  albumInfo.appendChild(infoCard)

  // Add play button listener
  const playBtn = infoCard.querySelector('.playlist-play-btn')
  playBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    playTrack(0)
  })
}

function playTrack(index) {
  if (!currentPlaylistData) return

  window.playerQueue = currentPlaylistData.audioFiles.map(f => f.path)
  window.currentTrackIndex = index
  window.loadPlayerTrack(index)
  window.renderPlaylist()

  // Highlight active track
  const tracks = document.querySelectorAll('.tracklist-item')
  tracks.forEach((t, i) => {
    t.classList.toggle('active', i === index)
  })
}

window.setLibraryPath = (path) => {
  console.log('[library.js] setLibraryPath called with:', path)
  libraryPath = path
  loadLibrary()
}