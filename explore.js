(function () {
  const canvas = document.getElementById('explore-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const searchInput = document.getElementById('explore-search');
  const searchBtn = document.getElementById('explore-search-btn');
  const dropdown = document.getElementById('explore-dropdown');
  const dropdownResults = dropdown ? dropdown.querySelector('.dropdown-results') : null;
  const tracklistContainer = document.querySelector('.explore-tracklist');
  const albumInfoContainer = document.querySelector('.explore-album-info');
  const searchContainer = document.getElementById('explore-search-container');

  let credentials = null;
  let savedAlbums = [];
  let apiError = null;
  const imageCache = new Map();
  let needsRedraw = true;
  let hitRegions = [];

  const TILE_W = 160;
  const TILE_H = 210;
  const GAP = 24;
  const HEADER_H = 40;
  const COVER_H = 150;

  async function getCredentials() {
    try {
      credentials = await window.electronAPI.getSpotifyCredentials();
    } catch (e) {
      credentials = null;
    }
  }

  async function fetchSavedAlbums() {
    if (!credentials) return;
    try {
      const result = await window.electronAPI.spotifyApi('/me/albums?limit=50');
      if (!result.success) {
        apiError = result.error;
        savedAlbums = [];
        needsRedraw = true;
        draw();
        return;
      }
      apiError = null;
      savedAlbums = (result.data.items || []).map(item => ({
        name: item.album.name,
        artist: item.album.artists.map(a => a.name).join(', '),
        image: item.album.images[0]?.url,
        uri: item.album.uri,
        id: item.album.id,
        type: 'Saved Album'
      }));
      preloadImages(savedAlbums);
    } catch (e) {
      apiError = e.message;
      console.error('Failed to fetch saved albums:', e);
      savedAlbums = [];
    }
    needsRedraw = true;
    draw();
  }

  function showDropdown() {
    if (dropdown) dropdown.classList.add('visible');
  }

  function hideDropdown() {
    if (dropdown) dropdown.classList.remove('visible');
  }

  function showTracklist() {
    if (canvas) canvas.style.display = 'none';
    if (searchContainer) searchContainer.style.display = 'none';
    if (tracklistContainer) {
      tracklistContainer.classList.add('active-tracklist');
      tracklistContainer.style.display = 'flex';
    }
    if (albumInfoContainer) {
      albumInfoContainer.classList.add('active-tracklist');
      albumInfoContainer.style.display = 'flex';
    }
  }

  function hideTracklist() {
    if (canvas) canvas.style.display = 'block';
    if (searchContainer) searchContainer.style.display = 'flex';
    if (tracklistContainer) {
      tracklistContainer.classList.remove('active-tracklist');
      tracklistContainer.style.display = 'none';
      tracklistContainer.innerHTML = '';
    }
    if (albumInfoContainer) {
      albumInfoContainer.classList.remove('active-tracklist');
      albumInfoContainer.style.display = 'none';
      albumInfoContainer.innerHTML = '';
    }
  }

  async function loadAlbumTracks(albumId, name, artist, image) {
    if (!credentials) return;
    try {
      const result = await window.electronAPI.spotifyApi('/albums/' + albumId + '/tracks?limit=50');
      if (!result.success) {
        apiError = result.error;
        draw();
        return;
      }
      apiError = null;
      const tracks = result.data.items || [];
      renderTracklist(tracks, name, artist, image, 'Album');
    } catch (e) {
      apiError = e.message;
      console.error('Failed to load album tracks:', e);
      draw();
    }
  }

  async function loadPlaylistTracks(playlistId, name, image) {
    if (!credentials) return;
    try {
      const result = await window.electronAPI.spotifyApi('/playlists/' + playlistId + '/tracks?limit=50');
      if (!result.success) {
        apiError = result.error;
        draw();
        return;
      }
      apiError = null;
      const tracks = (result.data.items || []).map(item => ({
        name: item.track ? item.track.name : 'Unknown',
        artists: item.track ? item.track.artists : [],
        uri: item.track ? item.track.uri : '',
        duration_ms: item.track ? item.track.duration_ms : 0
      }));
      renderTracklist(tracks, name, '', image, 'Playlist');
    } catch (e) {
      apiError = e.message;
      console.error('Failed to load playlist tracks:', e);
      draw();
    }
  }

  async function loadArtistTopTracks(artistId, name, image) {
    if (!credentials) return;
    try {
      const result = await window.electronAPI.spotifyApi('/artists/' + artistId + '/top-tracks?market=US');
      if (!result.success) {
        apiError = result.error;
        draw();
        return;
      }
      apiError = null;
      const tracks = result.data.tracks || [];
      renderTracklist(tracks, name, '', image, 'Artist');
    } catch (e) {
      apiError = e.message;
      console.error('Failed to load artist top tracks:', e);
      draw();
    }
  }

  function renderTracklist(tracks, name, artist, image, itemType) {
    if (!tracklistContainer || !albumInfoContainer) return;

    showTracklist();

    tracklistContainer.innerHTML = '';
    albumInfoContainer.innerHTML = '';

    // Back button
    const backBtn = document.createElement('div');
    backBtn.className = 'explore-back-btn';
    backBtn.textContent = '← Back to Explore';
    backBtn.addEventListener('click', hideTracklist);
    tracklistContainer.appendChild(backBtn);

    // Album info card
    const infoCard = document.createElement('div');
    infoCard.className = 'album-info-card';
    if (image) {
      infoCard.innerHTML = `
        <img src="${image}" alt="${name}" class="album-cover-large">
        <div class="album-name">${name}</div>
        <div class="album-artist">${artist ? artist + ' · ' : ''}${tracks.length} tracks</div>
        <button class="playlist-play-btn">Play</button>
      `;
    } else {
      infoCard.innerHTML = `
        <div class="album-cover-large no-cover">🎵</div>
        <div class="album-name">${name}</div>
        <div class="album-artist">${artist ? artist + ' · ' : ''}${tracks.length} tracks</div>
        <button class="playlist-play-btn">Play</button>
      `;
    }
    albumInfoContainer.appendChild(infoCard);

    // Play all button
    const playBtn = infoCard.querySelector('.playlist-play-btn');
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tracks.length > 0 && tracks[0].uri) {
        window.spotifyPlayTrack(tracks[0].uri);
      }
    });

    // Tracklist items
    tracks.forEach((track, index) => {
      const trackName = track.name || 'Unknown';
      const trackArtists = track.artists ? track.artists.map(a => a.name).join(', ') : '';
      const duration = fmtMs(track.duration_ms || 0);
      const uri = track.uri || '';

      const item = document.createElement('div');
      item.className = 'tracklist-item';
      item.innerHTML = `<span class="track-number">${index + 1}</span><span class="track-title">${trackName}</span><span style="margin-left:auto;color:#888;font-size:12px;">${duration}</span>`;
      item.addEventListener('click', () => {
        if (uri) {
          window.spotifyPlayTrack(uri);
          // Highlight active
          document.querySelectorAll('.explore-tracklist .tracklist-item').forEach((el, i) => {
            el.classList.toggle('active', i === index);
          });
        }
      });
      tracklistContainer.appendChild(item);
    });
  }

  function fmtMs(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  function renderDropdown(results) {
    if (!dropdownResults) return;
    dropdownResults.innerHTML = '';
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'dropdown-item';
      empty.textContent = 'No results';
      dropdownResults.appendChild(empty);
      showDropdown();
      return;
    }
    results.forEach(item => {
      const el = document.createElement('div');
      el.className = 'dropdown-item';
      const img = document.createElement('img');
      img.src = item.image || '';
      img.alt = '';
      img.onerror = () => { img.style.visibility = 'hidden'; };
      const info = document.createElement('div');
      info.className = 'dropdown-info';
      const name = document.createElement('div');
      name.className = 'dropdown-name';
      name.textContent = item.name;
      const meta = document.createElement('div');
      meta.className = 'dropdown-meta';
      meta.textContent = (item.artist ? item.artist + ' · ' : '') + item.type;
      info.appendChild(name);
      info.appendChild(meta);
      el.appendChild(img);
      el.appendChild(info);
      el.addEventListener('click', () => {
        if (item.type === 'Track') {
          window.spotifyPlayTrack(item.uri);
        } else if (item.type === 'Album') {
          const id = item.uri.replace('spotify:album:', '');
          loadAlbumTracks(id, item.name, item.artist, item.image);
        } else if (item.type === 'Artist') {
          const id = item.uri.replace('spotify:artist:', '');
          loadArtistTopTracks(id, item.name, item.image);
        }
        hideDropdown();
      });
      dropdownResults.appendChild(el);
    });
    showDropdown();
  }

  async function doSearch(query) {
    if (!credentials || !query.trim()) {
      hideDropdown();
      return;
    }
    try {
      const endpoint = '/search?q=' + encodeURIComponent(query) + '&type=album,track,artist&limit=10';
      const result = await window.electronAPI.spotifyApi(endpoint);
      if (!result.success) {
        apiError = result.error;
        hideDropdown();
        needsRedraw = true;
        draw();
        return;
      }
      apiError = null;
      const data = result.data;
      const results = [];
      (data.albums?.items || []).forEach(a => {
        results.push({
          name: a.name,
          artist: a.artists.map(ar => ar.name).join(', '),
          image: a.images[0]?.url,
          uri: a.uri,
          id: a.id,
          type: 'Album'
        });
      });
      (data.tracks?.items || []).forEach(t => {
        results.push({
          name: t.name,
          artist: t.artists.map(ar => ar.name).join(', '),
          image: t.album.images[0]?.url,
          uri: t.uri,
          id: t.id,
          type: 'Track'
        });
      });
      (data.artists?.items || []).forEach(ar => {
        results.push({
          name: ar.name,
          artist: '',
          image: ar.images[0]?.url,
          uri: ar.uri,
          id: ar.id,
          type: 'Artist'
        });
      });
      renderDropdown(results);
    } catch (e) {
      apiError = e.message;
      console.error('Search failed:', e);
      hideDropdown();
      needsRedraw = true;
      draw();
    }
  }

  function preloadImages(items) {
    items.forEach(item => {
      if (!item.image || imageCache.has(item.image)) return;
      const img = new Image();
      img.onload = () => {
        imageCache.set(item.image, img);
        needsRedraw = true;
        draw();
      };
      img.onerror = () => {
        imageCache.set(item.image, null);
      };
      img.src = item.image;
    });
  }

  function resize() {
    const container = canvas.parentElement;
    if (!container) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, container.clientWidth - 40);
    const maxCols = Math.max(1, Math.floor(cssWidth / (TILE_W + GAP)));

    const savedRows = savedAlbums.length ? Math.ceil(savedAlbums.length / maxCols) : 1;
    let cssHeight = 40;
    if (savedAlbums.length) cssHeight += HEADER_H + savedRows * (TILE_H + GAP);
    cssHeight = Math.max(cssHeight, container.clientHeight - 40);

    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsRedraw = true;
    draw();
  }

  function drawText(text, x, y, maxWidth, fontSize, color) {
    ctx.font = `${fontSize}px oswald, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    const words = String(text || '').split(' ');
    let line = '';
    const lines = [];
    for (let i = 0; i < words.length; i++) {
      const testLine = line + words[i] + ' ';
      if (ctx.measureText(testLine).width > maxWidth && i > 0) {
        lines.push(line.trim());
        line = words[i] + ' ';
      } else {
        line = testLine;
      }
    }
    lines.push(line.trim());
    lines.slice(0, 2).forEach((l, idx) => {
      ctx.fillText(l, x, y + idx * (fontSize + 2));
    });
  }

  function drawSection(items, title, startY, cols) {
    const totalGridW = cols * (TILE_W + GAP) - GAP;
    const cssW = canvas.width / (window.devicePixelRatio || 1);
    const startX = (cssW - totalGridW) / 2;

    ctx.font = 'bold 18px oswald, sans-serif';
    ctx.fillStyle = '#e2c044';
    ctx.textAlign = 'left';
    ctx.fillText(title, startX, startY + 24);

    let y = startY + HEADER_H;
    items.forEach((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = startX + col * (TILE_W + GAP);
      const itemY = y + row * (TILE_H + GAP);

      if (item.image && imageCache.get(item.image)) {
        ctx.drawImage(imageCache.get(item.image), x, itemY, TILE_W, COVER_H);
      } else {
        ctx.fillStyle = '#2a2a2a';
        ctx.fillRect(x, itemY, TILE_W, COVER_H);
        ctx.fillStyle = '#888';
        ctx.font = '40px serif';
        ctx.textAlign = 'center';
        ctx.fillText('♪', x + TILE_W / 2, itemY + COVER_H / 2 + 14);
      }

      if (item.type && item.type !== 'Saved Album') {
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillRect(x, itemY, 52, 20);
        ctx.fillStyle = '#e2c044';
        ctx.font = '10px oswald, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(item.type, x + 4, itemY + 14);
      }

      drawText(item.name, x + TILE_W / 2, itemY + COVER_H + 18, TILE_W, 13, '#ffffff');
      if (item.artist) {
        drawText(item.artist, x + TILE_W / 2, itemY + COVER_H + 34, TILE_W, 11, '#888888');
      }

      hitRegions.push({ x, y: itemY, w: TILE_W, h: TILE_H, item });
    });

    return y + Math.ceil(items.length / cols) * (TILE_H + GAP);
  }

  function draw() {
    if (!needsRedraw) return;
    needsRedraw = false;

    const cssW = canvas.width / (window.devicePixelRatio || 1);
    const cssH = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, cssW, cssH);
    hitRegions = [];

    if (!credentials) {
      ctx.fillStyle = '#888888';
      ctx.font = '16px source_serif_4, serif';
      ctx.textAlign = 'center';
      ctx.fillText('Connect Spotify in Settings to explore.', cssW / 2, cssH / 2);
      return;
    }

    if (apiError) {
      ctx.fillStyle = '#e2c044';
      ctx.font = 'bold 16px source_serif_4, serif';
      ctx.textAlign = 'center';
      ctx.fillText('Error:', cssW / 2, cssH / 2 - 20);
      ctx.fillStyle = '#ffffff';
      ctx.font = '14px source_serif_4, serif';
      const maxLine = cssW - 40;
      const words = String(apiError).split(' ');
      let line = '';
      const lines = [];
      for (let i = 0; i < words.length; i++) {
        const testLine = line + words[i] + ' ';
        if (ctx.measureText(testLine).width > maxLine && i > 0) {
          lines.push(line.trim());
          line = words[i] + ' ';
        } else {
          line = testLine;
        }
      }
      lines.push(line.trim());
      lines.forEach((l, idx) => {
        ctx.fillText(l, cssW / 2, cssH / 2 + 10 + idx * 18);
      });
      return;
    }

    if (!savedAlbums.length) {
      ctx.fillStyle = '#888888';
      ctx.font = '16px source_serif_4, serif';
      ctx.textAlign = 'center';
      ctx.fillText('No saved albums found.', cssW / 2, cssH / 2);
      return;
    }

    const cols = Math.max(1, Math.floor(cssW / (TILE_W + GAP)));
    drawSection(savedAlbums, 'Saved Albums', 20, cols);
  }

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const cssW = canvas.width / (window.devicePixelRatio || 1);
    const cssH = canvas.height / (window.devicePixelRatio || 1);
    const scaleX = cssW / rect.width;
    const scaleY = cssH / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    for (const region of hitRegions) {
      if (mx >= region.x && mx <= region.x + region.w && my >= region.y && my <= region.y + region.h) {
        const item = region.item;
        if (item.type === 'Saved Album') {
          loadAlbumTracks(item.id, item.name, item.artist, item.image);
        }
        break;
      }
    }
  });

  searchBtn.addEventListener('click', () => doSearch(searchInput.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch(searchInput.value);
  });

  // Close dropdown on Escape or clicking outside
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideDropdown();
  });
  document.addEventListener('click', (e) => {
    if (!dropdown) return;
    const container = document.getElementById('explore-search-container');
    if (container && !container.contains(e.target)) {
      hideDropdown();
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    resize();
  });
  resizeObserver.observe(canvas.parentElement);

  const exploreTab = document.getElementById('explore');
  if (exploreTab) {
    const tabObserver = new MutationObserver(() => {
      if (exploreTab.classList.contains('active')) {
        getCredentials().then(() => {
          if (credentials && savedAlbums.length === 0) {
            fetchSavedAlbums().then(() => resize());
          } else {
            resize();
          }
        });
      }
    });
    tabObserver.observe(exploreTab, { attributes: true });
  }

  (async function init() {
    await getCredentials();
    await fetchSavedAlbums();
    resize();
    setTimeout(() => { resize(); }, 100);
    setTimeout(() => { resize(); }, 500);
  })();
})();
