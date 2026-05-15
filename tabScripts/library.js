// VARIABLES
let currentPlaylistData = null

// LOAD LIBRARY (reads all paths from DB, scans each)
async function loadLibrary() {
  const libraryGrid = document.querySelector('#library .library-grid')
  const tracklistContainer = document.querySelector('#library .library-tracklist')
  const albumInfo = document.querySelector('#library .library-album-info')

  if (!libraryGrid) return

  tracklistContainer.classList.add('hidden')
  albumInfo.classList.add('hidden')
  libraryGrid.classList.remove('hidden')
  libraryGrid.classList.remove('hide-grid')
  libraryGrid.innerHTML = ''

  const paths = await window.electronAPI.dbGetPaths()

  if (!paths || paths.length === 0) {
    return
  }

  let hasPlaylists = false

  for (const libraryPath of paths) {
    const result = await window.electronAPI.scanFolder(libraryPath)
    if (!result) continue

    if (result.folders.length > 0) {
      for (const folder of result.folders) {
        const folderResult = await window.electronAPI.scanFolder(folder.path)
        if (folderResult && folderResult.audioFiles.length > 0) {
          createPlaylistCard(libraryGrid, folder.name, folderResult.audioFiles, folderResult.coverImage)
          hasPlaylists = true
        }
      }
    } else if (result.audioFiles.length > 0) {
      const playlistName = libraryPath.replace(/\\/g, '/').split('/').pop()
      createPlaylistCard(libraryGrid, playlistName, result.audioFiles, result.coverImage)
      hasPlaylists = true
    }
  }

  if (!hasPlaylists) {
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

  const coverImg = document.createElement('div')
  coverImg.className = 'playlist-cover'

  if (coverImage) {
    const img = document.createElement('img')
    img.src = 'file:///' + coverImage.replace(/\\/g, '/').replace(/^\/+/, '')
    img.alt = name
    coverImg.appendChild(img)
  } else {
    coverImg.innerHTML = '<div class="no-cover">🎵</div>'
  }

  const info = document.createElement('div')
  info.className = 'playlist-info'
  const artistName = name.split(' - ')[0] || 'No Author'
  info.innerHTML = `<span class="playlist-name">${name.split(' - ')[1] || name}</span><span class="playlist-artist">${artistName}</span>`

  card.addEventListener('click', function(e) {
    e.preventDefault()
    e.stopPropagation()
    loadPlaylist(name, audioFiles, coverImage)
  })

  card.appendChild(coverImg)
  card.appendChild(info)
  container.appendChild(card)
}

// LOAD PLAYLIST
function loadPlaylist(name, audioFiles, coverImage) {
  currentPlaylistData = { name, audioFiles, coverImage }
  window.currentPlaylistCover = coverImage
    ? 'file:///' + coverImage.replace(/\\/g, '/').replace(/^\/+/, '')
    : '';

  const libraryGrid = document.querySelector('#library .library-grid')
  const tracklistContainer = document.querySelector('#library .library-tracklist')
  const albumInfo = document.querySelector('#library .library-album-info')

  if (!tracklistContainer || !albumInfo) return

  libraryGrid.classList.add('hidden')
  libraryGrid.classList.add('hide-grid')
  tracklistContainer.classList.remove('hidden')
  albumInfo.classList.remove('hidden')
  tracklistContainer.replaceChildren()
  albumInfo.replaceChildren()

  const backBtn = document.createElement('div')
  backBtn.className = 'library-back-btn'
  backBtn.textContent = '← Back to Library'
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

  const infoCard = document.createElement('div')
  infoCard.className = 'album-info-card'

  if (coverImage) {
    infoCard.innerHTML = `
      <img src="file:///${coverImage.replace(/\\/g, '/').replace(/^\/+/, '')}" alt="${name}" class="album-cover-large">
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

  const tracks = document.querySelectorAll('.tracklist-item')
  tracks.forEach((t, i) => {
    t.classList.toggle('active', i === index)
  })
}

// Save path to DB and reload library
window.setLibraryPath = async (path) => {
  await window.electronAPI.dbAddPath(path)
  loadLibrary()
}

// Auto-load library from DB on startup
loadLibrary()
