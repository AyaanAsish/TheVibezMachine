// VARIABLES
let currentPlaylistData = null

function escapeHtml(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}

// Cache container references once
const libraryGrid = document.querySelector('#library .library-grid')
const libraryTracklist = document.querySelector('#library .library-tracklist')
const libraryAlbumInfo = document.querySelector('#library .library-album-info')

// LOAD LIBRARY (reads all paths from DB, scans each)
async function loadLibrary() {
  if (!libraryGrid) return

  libraryTracklist?.classList.add('hidden')
  libraryAlbumInfo?.classList.add('hidden')
  libraryGrid.classList.remove('hidden')
  libraryGrid.classList.remove('hide-grid')
  libraryGrid.replaceChildren()

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
    img.src = window.toFileUrl(coverImage)
    img.alt = name
    coverImg.appendChild(img)
  } else {
    coverImg.innerHTML = '<div class="no-cover">🎵</div>'
  }

  const info = document.createElement('div')
  info.className = 'playlist-info'
  const parts = name.split(' - ')
  const hasAuthor = parts.length > 1
  const artistName = hasAuthor ? parts[0] : 'No Author'
  const albumName = hasAuthor ? parts.slice(1).join(' - ') : name
  info.innerHTML = `<span class="playlist-name">${escapeHtml(albumName)}</span><span class="playlist-artist">${escapeHtml(artistName)}</span>`

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
    ? window.toFileUrl(coverImage)
    : '';

  if (!libraryTracklist || !libraryAlbumInfo) return

  libraryGrid?.classList.add('hidden')
  libraryGrid?.classList.add('hide-grid')
  libraryTracklist.classList.remove('hidden')
  libraryAlbumInfo.classList.remove('hidden')
  libraryTracklist.replaceChildren()
  libraryAlbumInfo.replaceChildren()

  const backBtn = document.createElement('div')
  backBtn.className = 'library-back-btn'
  backBtn.textContent = '← Back to Library'
  backBtn.addEventListener('click', () => {
    loadLibrary()
  })
  libraryTracklist.appendChild(backBtn)

  audioFiles.forEach((file, index) => {
    const track = document.createElement('div')
    track.className = 'tracklist-item'
    const trackName = file.name.replace(/\.[^/.]+$/, '')
    track.innerHTML = `<span class="track-number">${index + 1}</span><span class="track-title">${escapeHtml(trackName)}</span>`
    track.addEventListener('click', () => {
      playTrack(index)
    })
    libraryTracklist.appendChild(track)
  })

  const infoCard = document.createElement('div')
  infoCard.className = 'album-info-card'

  if (coverImage) {
    infoCard.innerHTML = `
      <img src="${window.toFileUrl(coverImage)}" alt="${escapeHtml(name)}" class="album-cover-large">
      <div class="album-name">${escapeHtml(name)}</div>
      <div class="album-artist">${audioFiles.length} tracks</div>
      <button class="playlist-play-btn">Play</button>
    `
  } else {
    infoCard.innerHTML = `
      <div class="album-cover-large no-cover">🎵</div>
      <div class="album-name">${escapeHtml(name)}</div>
      <div class="album-artist">${audioFiles.length} tracks</div>
      <button class="playlist-play-btn">Play</button>
    `
  }

  libraryAlbumInfo.appendChild(infoCard)

  const playBtn = infoCard.querySelector('.playlist-play-btn')
  playBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    playTrack(0)
  })
}

// Play Track
function playTrack(index) {
  if (!currentPlaylistData) return

  // Restore the local cover - the Explore tab may have overwritten
  // currentPlaylistCover while the user was browsing.
  window.currentPlaylistCover = currentPlaylistData.coverImage
    ? window.toFileUrl(currentPlaylistData.coverImage)
    : '';
  if (window.updatePlayerCover) window.updatePlayerCover(window.currentPlaylistCover);

  window.playerQueue = currentPlaylistData.audioFiles.map(f => f.path)
  window.loadPlayerTrack(index)

  if (window.highlightTracklistItems) {
    window.highlightTracklistItems('.tracklist-item', index)
  } else {
    document.querySelectorAll('.tracklist-item').forEach((t, i) => {
      t.classList.toggle('active', i === index)
    })
  }
}

// Save path to DB and reload library
window.setLibraryPath = async (path) => {
  const result = await window.electronAPI.scanFolder(path)
  if (!result) {
    window.showToast('Folder not found - check the path is correct', 'error')
    return
  }
  await window.electronAPI.dbAddPath(path)
  await loadLibrary()
  const hasAudio = result.audioFiles.length > 0 || result.folders.length > 0
  if (hasAudio) {
    window.showToast('Library path added', 'success')
  } else {
    window.showToast('No music files found in this folder', 'error')
  }
}

// Auto-load library from DB on startup
loadLibrary()
