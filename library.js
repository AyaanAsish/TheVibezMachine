// VARIABLES
let libraryPath = null
let currentPlaylistData = null

// LOAD LIBRARY
async function loadLibrary() {
  console.log('[library.js] loadLibrary called, libraryPath:', libraryPath)
  const libraryGrid = document.querySelector('#library .library-grid')
  const tracklistContainer = document.querySelector('#library .library-tracklist')
  const albumInfo = document.querySelector('#library .library-album-info')

  if (!libraryGrid) {
    console.log('[library.js] libraryGrid not found!')
    return
  }

  // Hide tracklist and album info, show grid
  tracklistContainer.style.display = 'none'
  albumInfo.style.display = 'none'
  libraryGrid.style.display = 'grid'
  libraryGrid.classList.remove('hide-grid')
  libraryGrid.innerHTML = ''

  // Error handling
  if (!libraryPath) {
    const msg = document.createElement('p')
    msg.className = 'empty-message'
    msg.textContent = 'No library path set. Go to Settings to add a folder.'
    libraryGrid.appendChild(msg)
    return
  }

  const result = await window.electronAPI.scanFolder(libraryPath)
  if (!result) {
    const msg = document.createElement('p')
    msg.className = 'empty-message'
    msg.textContent = 'Error scanning folder.'
    libraryGrid.appendChild(msg)
    return
  }

  // If there are subfolders, treat each as a playlist
  if (result.folders.length > 0) {
    for (const folder of result.folders) {
      const folderResult = await window.electronAPI.scanFolder(folder.path)
      if (folderResult && folderResult.audioFiles.length > 0) {
        createPlaylistCard(libraryGrid, folder.name, folderResult.audioFiles, folderResult.coverImage)
      }
    }
  } else if (result.audioFiles.length > 0) {
    const playlistName = libraryPath.split('/').pop()
    createPlaylistCard(libraryGrid, playlistName, result.audioFiles, result.coverImage)
  } else {
    const msg = document.createElement('p')
    msg.className = 'empty-message'
    msg.textContent = 'No audio files found.'
    libraryGrid.appendChild(msg)
  }
}

// Playlist Card
function createPlaylistCard(container, name, audioFiles, coverImage) {
  const card = document.createElement('div')
  card.className = 'playlist-card'

  // Image
  const coverImg = document.createElement('div')
  coverImg.className = 'playlist-cover'

  if (coverImage) {
    const img = document.createElement('img')
    img.src = 'file://' + coverImage
    img.alt = name
    coverImg.appendChild(img)
  } else { // No image
    coverImg.innerHTML = '<div class="no-cover">🎵</div>'
  }

  // Playlist Info
  const info = document.createElement('div')
  info.className = 'playlist-info'
  const artistName = name.split('|')[1] || 'No Author'
  info.innerHTML = `<span class="playlist-name">${name.split('|')[0]}</span><span class="playlist-artist">${artistName}</span>`

  // Handle Click
  card.addEventListener('click', function(e) {
    e.preventDefault()
    e.stopPropagation()
    console.log('[library.js] Playlist card clicked:', name)
    loadPlaylist(name, audioFiles, coverImage)
  })

  // Append
  card.appendChild(coverImg)
  card.appendChild(info)
  container.appendChild(card)
}

// LOAD PLAYLIST
function loadPlaylist(name, audioFiles, coverImage) {
  console.log('[library.js] loadPlaylist called, name:', name, 'files:', audioFiles.length)

  currentPlaylistData = { name, audioFiles, coverImage }

  const libraryGrid = document.querySelector('#library .library-grid')
  const tracklistContainer = document.querySelector('#library .library-tracklist')
  const albumInfo = document.querySelector('#library .library-album-info')

  if (!tracklistContainer || !albumInfo) return

  // Hide grid, show and clear tracklist and album info
  libraryGrid.style.display = 'none'
  libraryGrid.classList.add('hide-grid')
  tracklistContainer.style.display = 'flex'
  albumInfo.style.display = 'flex'
  tracklistContainer.replaceChildren()
  albumInfo.replaceChildren()

  // Add back button
  const backBtn = document.createElement('div')
  backBtn.className = 'library-back-btn'
  backBtn.textContent = '← Back to Library'
  backBtn.addEventListener('click', () => {
    loadLibrary()
  })
  tracklistContainer.appendChild(backBtn)

  // Add tracks
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

  // Setup album info
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

// Play Track
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