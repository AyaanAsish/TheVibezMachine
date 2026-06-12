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
          const displayName = folderResult.meta?.name || folder.name
          createPlaylistCard(libraryGrid, displayName, folderResult.audioFiles, folderResult.coverImage, folder.path, folderResult.meta)
          hasPlaylists = true
        }
      }
    } else if (result.audioFiles.length > 0) {
      const playlistName = result.meta?.name || libraryPath.replace(/\\/g, '/').split('/').pop()
      createPlaylistCard(libraryGrid, playlistName, result.audioFiles, result.coverImage, libraryPath, result.meta)
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
function createPlaylistCard(container, name, audioFiles, coverImage, folderPath, meta) {
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
    coverImg.innerHTML = '<img src="assets/images/no_cover.png" alt="No cover" class="no-cover">'
  }

  const editBadge = document.createElement('span')
  editBadge.className = 'edit-badge'
  editBadge.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`
  coverImg.appendChild(editBadge)

  let artistName, albumName
  if (meta) {
    albumName = meta.name !== undefined ? meta.name : name
    artistName = (meta.author !== undefined && meta.author !== '') ? meta.author : 'No Author'
  } else {
    const parts = name.split(' - ')
    if (parts.length > 1) {
      artistName = parts[0]
      albumName = parts.slice(1).join(' - ')
    } else {
      artistName = 'No Author'
      albumName = name
    }
  }

  const info = document.createElement('div')
  info.className = 'playlist-info'

  const nameSpan = document.createElement('span')
  nameSpan.className = 'playlist-name'
  nameSpan.textContent = albumName

  const artistSpan = document.createElement('span')
  artistSpan.className = 'playlist-artist'
  artistSpan.textContent = artistName

  info.appendChild(nameSpan)
  info.appendChild(artistSpan)

  // Single-click vs double-click handling
  let clickTimer = null
  card.addEventListener('click', (e) => {
    if (card.dataset.editing) {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      return
    }
    if (clickTimer) {
      clearTimeout(clickTimer)
      clickTimer = null
      return
    }
    clickTimer = setTimeout(() => {
      clickTimer = null
      const currentName = nameSpan.childNodes[0]?.textContent?.trim() || nameSpan.textContent.trim()
      const currentArtist = artistSpan.textContent.trim()
      loadPlaylist(currentName, audioFiles, coverImage, currentArtist)
    }, 200)
  })

  card.addEventListener('dblclick', (e) => {
    if (clickTimer) {
      clearTimeout(clickTimer)
      clickTimer = null
    }
    startPlaylistEdit(card, nameSpan, artistSpan, folderPath)
  })

  card.appendChild(coverImg)
  card.appendChild(info)
  container.appendChild(card)
}

function startPlaylistEdit(card, nameSpan, artistSpan, folderPath) {
  if (nameSpan.isContentEditable) return

  card.dataset.editing = 'true'

  nameSpan.contentEditable = 'true'
  artistSpan.contentEditable = 'true'
  nameSpan.classList.add('editing')
  artistSpan.classList.add('editing')
  nameSpan.focus()

  const save = async () => {
    delete card.dataset.editing
    nameSpan.contentEditable = 'false'
    artistSpan.contentEditable = 'false'
    nameSpan.classList.remove('editing')
    artistSpan.classList.remove('editing')

    const newName = nameSpan.textContent.trim()
    const newAuthor = artistSpan.textContent.trim()

    try {
      await window.electronAPI.savePlaylistMeta(folderPath, newName, newAuthor)
    } catch (err) {
      console.error('Failed to save playlist meta:', err)
    }

    nameSpan.removeEventListener('blur', onBlur)
    artistSpan.removeEventListener('blur', onBlur)
    nameSpan.removeEventListener('keydown', onKey)
    artistSpan.removeEventListener('keydown', onKey)
  }

  const onBlur = () => {
    setTimeout(() => {
      const active = document.activeElement
      if (active !== nameSpan && active !== artistSpan) {
        save()
      }
    }, 0)
  }

  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      save()
    }
  }

  nameSpan.addEventListener('blur', onBlur)
  artistSpan.addEventListener('blur', onBlur)
  nameSpan.addEventListener('keydown', onKey)
  artistSpan.addEventListener('keydown', onKey)
}

// LOAD PLAYLIST
function loadPlaylist(name, audioFiles, coverImage, artist) {
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

  const artistLine = artist ? `${escapeHtml(artist)} · ${audioFiles.length} tracks` : `${audioFiles.length} tracks`

  if (coverImage) {
    infoCard.innerHTML = `
      <img src="${window.toFileUrl(coverImage)}" alt="${escapeHtml(name)}" class="album-cover-large">
      <div class="album-name">${escapeHtml(name)}</div>
      <div class="album-artist">${artistLine}</div>
      <button class="playlist-play-btn">Play</button>
    `
  } else {
    infoCard.innerHTML = `
      <img src="assets/images/no_cover.png" alt="No cover" class="album-cover-large no-cover">
      <div class="album-name">${escapeHtml(name)}</div>
      <div class="album-artist">${artistLine}</div>
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
