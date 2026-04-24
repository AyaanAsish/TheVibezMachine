let libraryPath = null
let currentPlaylistData = null

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

  // Reset items container overflow for grid view
  const itemsContainer = document.querySelector('#library .items')
  if (itemsContainer) {
    itemsContainer.style.overflowY = 'hidden'
  }

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

function parsePlaylistName(name) {
  const parts = name.split('|');
  return {
    title: parts[0]?.trim() || name,
    artist: parts[1]?.trim() || 'No Author'
  };
}

function createPlaylistCard(container, name, audioFiles, coverImage) {
  const card = document.createElement('div');
  card.className = 'playlist-card';

  const coverImg = document.createElement('div');
  coverImg.className = 'playlist-cover';

  if (coverImage) {
    const img = document.createElement('img');
    img.src = 'file://' + coverImage;
    img.alt = name;
    coverImg.appendChild(img);
  } else {
    coverImg.innerHTML = '<div class="no-cover">🎵</div>';
  }

  const { title, artist } = parsePlaylistName(name);
  const info = document.createElement('div');
  info.className = 'playlist-info';
  info.innerHTML = `<span class="playlist-name">${title}</span><span class="playlist-artist">${artist}</span>`;

  card.appendChild(coverImg);
  card.appendChild(info);

  card.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    console.log('[library.js] Playlist card clicked:', name);
    loadPlaylist(name, audioFiles, coverImage);
  });

  container.appendChild(card);
}

function createAlbumInfoCard(coverImage, name, audioFiles) {
  const infoCard = document.createElement('div');
  infoCard.className = 'album-info-card';

  if (coverImage) {
    infoCard.innerHTML = `
      <img src="file://${coverImage}" alt="${name}" class="album-cover-large">
      <div class="album-name">${name}</div>
      <div class="album-artist">${audioFiles.length} tracks</div>
      <button class="playlist-play-btn">Play</button>
    `;
  } else {
    infoCard.innerHTML = `
      <div class="album-cover-large no-cover">🎵</div>
      <div class="album-name">${name}</div>
      <div class="album-artist">${audioFiles.length} tracks</div>
      <button class="playlist-play-btn">Play</button>
    `;
  }
  return infoCard;
}

function addTracksToContainer(container, audioFiles, onTrackClick) {
  audioFiles.forEach((file, index) => {
    const track = document.createElement('div');
    track.className = 'tracklist-item';
    const trackName = file.name.replace(/\.[^/.]+$/, '');
    track.innerHTML = `<span class="track-number">${index + 1}</span><span class="track-title">${trackName}</span>`;
    track.addEventListener('click', () => onTrackClick(index));
    container.appendChild(track);
  });
}

function addBackButton(container, onClick) {
  const backBtn = document.createElement('div');
  backBtn.className = 'library-back-btn';
  backBtn.textContent = '← Back to Library';
  backBtn.addEventListener('click', onClick);
  container.appendChild(backBtn);
}

function loadPlaylist(name, audioFiles, coverImage) {
  console.log('[library.js] loadPlaylist called, name:', name, 'files:', audioFiles.length);

  currentPlaylistData = { name, audioFiles, coverImage };

  const libraryGrid = document.querySelector('#library .library-grid');
  const tracklistContainer = document.querySelector('#library .library-tracklist');
  const albumInfo = document.querySelector('#library .library-album-info');

  if (!tracklistContainer || !albumInfo) return;

  // Hide grid, show tracklist and album info
  libraryGrid.style.display = 'none';
  libraryGrid.classList.add('hide-grid');

  const isResponsive = window.innerWidth <= 900;

  if (isResponsive) {
    // Parent container - no scroll, children handle it
    const itemsContainer = document.querySelector('#library .items');
    if (itemsContainer) {
      itemsContainer.style.overflowY = 'visible';
      itemsContainer.style.overflowX = 'hidden';
    }

    // Album info stays separate, appears on top via CSS order
    albumInfo.innerHTML = '';
    albumInfo.style.display = 'flex';
    albumInfo.style.flexDirection = 'column';
    albumInfo.style.alignItems = 'center';
    albumInfo.style.justifyContent = 'center';
    albumInfo.style.width = '100%';
    albumInfo.style.position = 'static';
    albumInfo.style.overflowY = 'visible';
    albumInfo.style.padding = '20px';
    albumInfo.style.boxSizing = 'border-box';

    albumInfo.appendChild(createAlbumInfoCard(coverImage, name, audioFiles));

    // Tracklist scrolls independently
    tracklistContainer.innerHTML = '';
    tracklistContainer.style.display = 'flex';
    tracklistContainer.style.flexDirection = 'column';
    tracklistContainer.style.width = '100%';
    tracklistContainer.style.height = 'auto';
    tracklistContainer.style.maxHeight = 'calc(100vh - 300px)';
    tracklistContainer.style.position = 'static';
    tracklistContainer.style.overflowY = 'auto';
    tracklistContainer.style.padding = '20px';
    tracklistContainer.style.boxSizing = 'border-box';

    addBackButton(tracklistContainer, () => loadLibrary());
    addTracksToContainer(tracklistContainer, audioFiles, playTrack);
  } else {
    // Desktop: side-by-side layout
    tracklistContainer.innerHTML = '';
    tracklistContainer.style.display = 'flex';
    tracklistContainer.style.flexDirection = 'column';
    tracklistContainer.style.width = '55%';
    tracklistContainer.style.height = '100%';
    tracklistContainer.style.position = 'absolute';
    tracklistContainer.style.left = '0';
    tracklistContainer.style.top = '0';
    tracklistContainer.style.borderRight = '2px solid rgba(255, 255, 255, 0.1)';
    tracklistContainer.style.padding = '20px';
    tracklistContainer.style.overflowY = 'auto';
    tracklistContainer.style.boxSizing = 'border-box';

    addBackButton(tracklistContainer, () => loadLibrary());
    addTracksToContainer(tracklistContainer, audioFiles, playTrack);

    // Setup album info
    albumInfo.innerHTML = '';
    albumInfo.style.display = 'flex';
    albumInfo.style.flexDirection = 'column';
    albumInfo.style.alignItems = 'center';
    albumInfo.style.justifyContent = 'flex-start';
    albumInfo.style.width = '45%';
    albumInfo.style.height = '100%';
    albumInfo.style.position = 'absolute';
    albumInfo.style.right = '0';
    albumInfo.style.top = '0';
    albumInfo.style.overflowY = 'auto';
    albumInfo.style.padding = '20px';
    albumInfo.style.boxSizing = 'border-box';

    const infoCard = createAlbumInfoCard(coverImage, name, audioFiles);
    albumInfo.appendChild(infoCard);

    // Add play button listener
    const playBtn = infoCard.querySelector('.playlist-play-btn');
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      playTrack(0);
    });
  }
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