const getAccentColor = () => {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return color || '#ffffff'; 
};

(function () {
  /* ─── DOM refs ─── */
  const canvas = document.getElementById('explore-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const searchInput = document.getElementById('explore-search');
  const searchBtn = document.getElementById('explore-search-btn');
  const dropdown = document.getElementById('explore-dropdown');
  const dropdownResults = dropdown?.querySelector('.dropdown-results');
  const tracklistContainer = document.querySelector('#explore .library-tracklist');
  const albumInfoContainer = document.querySelector('#explore .library-album-info');
  const searchContainer = document.getElementById('explore-search-container');

  /* ─── Config ─── */
  const TILE_W = 160;
  const TILE_H = 210;
  const HEADER_H = 40;
  const COVER_H = 150;
  const HOVER_SCALE = 1.06;
  const LERP_FACTOR = 0.12;

  /* ─── State ─── */
  let credentials = null;
  let savedAlbums = [];
  let savedPlaylists = [];
  let apiError = null;
  let isFetchingAlbums = false;
  let isFetchingPlaylists = false;
  let needsRedraw = true;
  let hoveredItem = null;

  /* ─── Friendly error mapping ─── */
  function friendlyError(raw) {
    if (!raw) return 'Something went wrong - try again';
    const m = String(raw).toLowerCase();
    if (m.includes('not authenticated') || m.includes('sign in')) return 'Sign in to Spotify first';
    if (m.includes('no device')) return 'No Spotify device connected - try reconnecting';
    if (m.includes('timed out') || m.includes('timeout') || m.includes('abort')) return 'Connection timed out - check your internet and try again';
    if (m.includes('403')) return 'You don\'t have permission for this on Spotify';
    if (m.includes('404')) return 'Spotify device not found - your network may be blocking Spotify';
    if (m.includes('429')) return 'Too many requests - wait a moment and try again';
    if (m.includes('token exchange') || m.includes('invalid_client') || m.includes('401')) return 'Invalid Spotify credentials - check your Client ID and Secret';
    if (m.includes('eaddrinuse') || m.includes('callback server')) return 'Could not start the login server - try again in a moment';
    if (m.includes('access_denied')) return 'Spotify access was denied - try connecting again';
    return 'Something went wrong - try again';
  }
  let currentHoverScale = 1;
  let hitRegions = [];
  let currentGap = 24;
  let currentSectionGap = 16;
  const imageCache = new Map();

  /* ─── Helpers ─── */
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function readCssInt(prop, fallback) {
    const val = getComputedStyle(document.documentElement).getPropertyValue(prop);
    return parseInt(val, 10) || fallback;
  }

  function updateGap() { currentGap = readCssInt('--grid-gap', 24); }
  function updateSectionGap() { currentSectionGap = readCssInt('--explore-section-gap', 16); }

  async function getCredentials() {
    try {
      credentials = await window.electronAPI.getSpotifyCredentials();
    } catch {
      credentials = null;
    }
  }

  /* ─── Data fetching ─── */
  async function fetchSavedItems(endpoint, mapper, flagRef) {
    if (!credentials || flagRef.value) return [];
    flagRef.value = true;
    try {
      const result = await window.electronAPI.spotifyApi(endpoint);
      if (!result.success) {
        apiError = result.error;
        needsRedraw = true;
        return [];
      }
      apiError = null;
      const items = (result.data.items || []).map(mapper);
      preloadImages(items);
      return items;
    } catch (e) {
      apiError = e.message;
      console.error('Failed to fetch saved items:', e);
      return [];
    } finally {
      flagRef.value = false;
      needsRedraw = true;
    }
  }

  async function fetchSavedAlbums() {
    savedAlbums = await fetchSavedItems(
      '/me/albums?limit=50',
      item => ({
        name: item.album.name,
        artist: item.album.artists.map(a => a.name).join(', '),
        image: item.album.images?.[0]?.url,
        uri: item.album.uri,
        id: item.album.id,
        type: 'Saved Album'
      }),
      { value: isFetchingAlbums }
    );
  }

  async function fetchSavedPlaylists() {
    savedPlaylists = await fetchSavedItems(
      '/me/playlists?limit=50',
      item => ({
        name: item.name,
        artist: item.owner?.display_name || '',
        image: item.images?.[0]?.url,
        uri: item.uri,
        id: item.id,
        type: 'Saved Playlist'
      }),
      { value: isFetchingPlaylists }
    );
  }

  /* ─── UI toggles ─── */
  function showDropdown() { dropdown?.classList.add('open'); }
  function hideDropdown() { dropdown?.classList.remove('open'); }

  function showTracklist() {
    document.querySelector('#explore .explore-browse')?.classList.add('hidden');
    document.querySelector('#explore .items')?.classList.add('showing-tracklist');
    tracklistContainer?.classList.remove('hidden');
    albumInfoContainer?.classList.remove('hidden');
  }

  function hideTracklist() {
    document.querySelector('#explore .explore-browse')?.classList.remove('hidden');
    document.querySelector('#explore .items')?.classList.remove('showing-tracklist');
    tracklistContainer?.classList.add('hidden');
    tracklistContainer && (tracklistContainer.innerHTML = '');
    albumInfoContainer?.classList.add('hidden');
    albumInfoContainer && (albumInfoContainer.innerHTML = '');
    needsRedraw = true;
    resize();
  }

  /* ─── Tracklist builders ─── */
  function createBackButton() {
    const btn = document.createElement('div');
    btn.className = 'library-back-btn';
    btn.textContent = '← Back to Explore';
    btn.addEventListener('click', hideTracklist);
    return btn;
  }

  function createErrorMessage(msg) {
    const el = document.createElement('div');
    el.className = 'explore-tracklist-error';
    el.textContent = msg;
    return el;
  }

  function buildInfoCard(name, artist, image, trackCount) {
    const card = document.createElement('div');
    card.className = 'album-info-card';

    const coverHtml = image
      ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(name)}" class="album-cover-large">`
      : `<div class="album-cover-large no-cover">🎵</div>`;

    card.innerHTML = `
      ${coverHtml}
      <div class="album-name">${escapeHtml(name)}</div>
      <div class="album-artist">${escapeHtml(artist ? artist + ' · ' : '')}${trackCount} tracks</div>
      <button class="playlist-play-btn">Play</button>
    `;
    return card;
  }

  function buildTrackItem(track, index, fallbackImage) {
    const item = document.createElement('div');
    item.className = 'tracklist-item';
    item.innerHTML = `<span class="track-number">${index + 1}</span><span class="track-title">${escapeHtml(track.name || 'Unknown')}</span>`;

    item.addEventListener('click', () => {
      if (!track.uri) return;
      window.spotifyCurrentIndex = index;
      const cover = track.albumImage || fallbackImage || '';
      window.currentPlaylistCover = cover;
      window.updatePlayerCover?.(cover);
      window.spotifyPlayTrack(track.uri);
      window.highlightTracklistItems?.('#explore .library-tracklist .tracklist-item', index);
    });

    return item;
  }

  /* ─── Tracklist rendering ─── */
  async function loadAlbumTracks(albumId, name, artist, image) {
    if (!credentials) return;
    try {
      const result = await window.electronAPI.spotifyApi(`/albums/${albumId}/tracks?limit=50`);
      if (!result.success) {
        console.error('[explore] Album tracks API error:', result.error);
        renderTracklist([], name, artist, image, friendlyError(result.error));
        return;
      }
      apiError = null;
      const tracks = (result.data.items || []).map(t => ({
        name: t.name,
        artists: t.artists || [],
        uri: t.uri,
        duration_ms: t.duration_ms,
        albumImage: image
      }));
      renderTracklist(tracks, name, artist, image);
    } catch (e) {
      console.error('[explore] Failed to load album tracks:', e);
      renderTracklist([], name, artist, image, friendlyError(e.message));
    }
  }

  async function loadPlaylistTracks(playlistId, name, image) {
    if (!credentials || !playlistId) {
      console.warn('[explore] Cannot load playlist: missing credentials or id');
      renderTracklist([], name, '', image, 'Sign in to Spotify via the Settings tab');
      return;
    }

    try {
      const allItems = [];
      const limit = 50;
      let offset = 0;
      let total = null;

      while (true) {
        const result = await window.electronAPI.spotifyApi(
          `/playlists/${playlistId}/items?limit=${limit}&offset=${offset}&additional_types=track`
        );
        if (!result.success) {
          console.error(`[explore] Playlist tracks API error (offset ${offset}):`, result.error);
          const is403 = String(result.error).includes('403');
          const msg = is403
            ? 'You don\'t have permission for this playlist. Spotify now limits access to playlists you don\'t own. For your own playlists, try reconnecting Spotify in Settings.'
            : friendlyError(result.error);
          renderTracklist([], name, '', image, msg);
          return;
        }

        const items = result.data.items || [];
        allItems.push(...items);
        total = result.data.total;
        if (items.length === 0 || allItems.length >= total) break;
        offset += limit;
      }

      apiError = null;

      const tracks = allItems
        .map(item => {
          const track = item.item || item.track;
          return {
            name: track?.name || 'Unavailable',
            artists: track?.artists || [],
            uri: track?.uri || '',
            duration_ms: track?.duration_ms || 0,
            is_local: item.is_local || false,
            albumImage: track?.album?.images?.[0]?.url || null
          };
        })
        .filter(t => t.uri);

      if (tracks.length === 0) {
        const hasLocal = allItems.some(i => i.is_local);
        const allNull = allItems.length > 0 && allItems.every(i => !(i.item || i.track));
        let msg = 'No playable tracks found in this playlist.';
        if (allNull) msg += ' Spotify says these tracks are unavailable right now. Try reconnecting Spotify in Settings.';
        else if (hasLocal) msg += ' This playlist may contain local files which Spotify can\'t stream.';
        else msg += ' These tracks may not be available in your region right now.';
        renderTracklist([], name, '', image, msg);
        return;
      }

      renderTracklist(tracks, name, '', image);
    } catch (e) {
      console.error('[explore] Failed to load playlist tracks:', e);
      renderTracklist([], name, '', image, friendlyError(e.message));
    }
  }

  function renderTracklist(tracks, name, artist, image, errorMsg) {
    if (!tracklistContainer || !albumInfoContainer) return;

    showTracklist();
    window.currentPlaylistCover = image || '';
    tracklistContainer.innerHTML = '';
    albumInfoContainer.innerHTML = '';

    tracklistContainer.appendChild(createBackButton());
    if (errorMsg) tracklistContainer.appendChild(createErrorMessage(errorMsg));

    const infoCard = buildInfoCard(name, artist, image, tracks.length);
    albumInfoContainer.appendChild(infoCard);

    infoCard.querySelector('.playlist-play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const firstIdx = tracks.findIndex(t => t.uri);
      if (firstIdx >= 0) {
        window.spotifyCurrentIndex = firstIdx;
        window.updatePlayerCover?.(tracks[firstIdx].albumImage || image || '');
        window.spotifyPlayTrack(tracks[firstIdx].uri);
      } else {
        console.warn('[explore] No playable tracks in this list');
      }
    });

    window.spotifyQueue = tracks;
    tracks.forEach((track, i) => tracklistContainer.appendChild(buildTrackItem(track, i, image)));
  }

  /* ─── Search / dropdown ─── */
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

      if (item.image) {
        const img = document.createElement('img');
        img.src = item.image;
        img.alt = '';
        img.onerror = () => img.classList.add('img-error');
        el.appendChild(img);
      }

      const info = document.createElement('div');
      info.className = 'dropdown-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'dropdown-name';
      nameEl.textContent = item.name;
      const meta = document.createElement('div');
      meta.className = 'dropdown-meta';
      meta.textContent = (item.artist ? item.artist + ' · ' : '') + item.type;
      info.appendChild(nameEl);
      info.appendChild(meta);
      el.appendChild(info);

      el.addEventListener('click', () => {
        if (item.type === 'Track') {
          window.currentPlaylistCover = item.image || '';
          window.updatePlayerCover?.(item.image || '');
          window.spotifyQueue = [item];
          window.spotifyCurrentIndex = 0;
          window.spotifyPlayTrack(item.uri);
        } else if (item.type === 'Album') {
          const id = item.uri.replace('spotify:album:', '');
          loadAlbumTracks(id, item.name, item.artist, item.image);
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
      const result = await window.electronAPI.spotifyApi(`/search?q=${encodeURIComponent(query)}&type=album,track&limit=10`);
      if (!result.success) {
        apiError = result.error;
        hideDropdown();
        needsRedraw = true;
        return;
      }
      apiError = null;

      const albums = (result.data.albums?.items || []).map(a => ({
        name: a.name,
        artist: a.artists.map(ar => ar.name).join(', '),
        image: a.images?.[0]?.url,
        uri: a.uri,
        id: a.id,
        type: 'Album'
      }));

      const tracks = (result.data.tracks?.items || []).map(t => ({
        name: t.name,
        artist: t.artists.map(ar => ar.name).join(', '),
        image: t.album?.images?.[0]?.url,
        uri: t.uri,
        id: t.id,
        type: 'Track'
      }));

      renderDropdown([...albums, ...tracks]);
    } catch (e) {
      apiError = e.message;
      console.error('Search failed:', e);
      hideDropdown();
      needsRedraw = true;
    }
  }

  /* ─── Canvas helpers ─── */
  function preloadImages(items) {
    items.forEach(item => {
      if (!item.image || imageCache.has(item.image)) return;
      const img = new Image();
      img.onload = () => { imageCache.set(item.image, img); needsRedraw = true; };
      img.onerror = () => { imageCache.set(item.image, null); };
      img.src = item.image;
    });
  }

  function getComputedOverhead(container, searchEl) {
    const browseStyle = window.getComputedStyle(container);
    const searchStyle = searchEl ? window.getComputedStyle(searchEl) : null;
    const canvasStyle = window.getComputedStyle(canvas);
    return (
      (parseFloat(browseStyle.paddingTop) || 0) +
      (parseFloat(browseStyle.paddingBottom) || 0) +
      (parseFloat(searchStyle?.marginBottom) || 0) +
      (parseFloat(canvasStyle.marginBottom) || 0)
    );
  }

  function resize() {
    updateGap();
    updateSectionGap();
    const container = canvas.parentElement;
    if (!container) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, container.clientWidth - 40);
    const maxCols = Math.max(1, Math.floor(cssWidth / (TILE_W + currentGap)));

    const albumRows = savedAlbums.length ? Math.ceil(savedAlbums.length / maxCols) : 0;
    const playlistRows = savedPlaylists.length ? Math.ceil(savedPlaylists.length / maxCols) : 0;

    let contentHeight = 20; // top padding matching draw()
    if (savedAlbums.length) {
      contentHeight += HEADER_H + Math.max(0, albumRows - 1) * (TILE_H + currentGap) + TILE_H;
    }
    if (savedPlaylists.length) {
      if (savedAlbums.length) contentHeight += currentSectionGap;
      contentHeight += HEADER_H + Math.max(0, playlistRows - 1) * (TILE_H + currentGap) + TILE_H;
    }

    const searchEl = document.getElementById('explore-search-container');
    const overhead = getComputedOverhead(container, searchEl);
    const onePageMin = Math.max(1, container.clientHeight - overhead - (searchEl?.offsetHeight || 0));
    const cssHeight = Math.max(contentHeight, onePageMin);

    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsRedraw = true;
  }

  function wrapText(text, maxWidth) {
    const words = String(text || '').split(' ');
    const lines = [];
    let line = '';
    for (let i = 0; i < words.length; i++) {
      const test = line + words[i] + ' ';
      if (ctx.measureText(test).width > maxWidth && i > 0) {
        lines.push(line.trim());
        line = words[i] + ' ';
      } else {
        line = test;
      }
    }
    lines.push(line.trim());
    return lines;
  }

  function drawText(text, x, y, maxWidth, fontSize, color) {
    ctx.font = `${fontSize}px oswald, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    const lines = wrapText(text, maxWidth);
    lines.slice(0, 2).forEach((l, idx) => ctx.fillText(l, x, y + idx * (fontSize + 2)));
  }

  function drawTile(item, x, y, isHovered) {
    if (isHovered) {
      ctx.save();
      const cx = x + TILE_W / 2;
      const cy = y + TILE_H / 2;
      ctx.translate(cx, cy);
      ctx.scale(currentHoverScale, currentHoverScale);
      ctx.translate(-cx, -cy);
    }

    const cached = item.image ? imageCache.get(item.image) : null;
    if (cached) {
      ctx.drawImage(cached, x, y, TILE_W, COVER_H);
    } else {
      ctx.fillStyle = '#2a2a2a';
      ctx.fillRect(x, y, TILE_W, COVER_H);
      ctx.fillStyle = '#888';
      ctx.font = '40px serif';
      ctx.textAlign = 'center';
      ctx.fillText('♪', x + TILE_W / 2, y + COVER_H / 2 + 14);
    }

    if (item.type && item.type !== 'Saved Album') {
      const label = item.type === 'Saved Playlist' ? 'Playlist' : item.type;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(x, y, 52, 20);
      ctx.fillStyle = '#e2c044';
      ctx.font = '10px oswald, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(label, x + 4, y + 14);
    }

    drawText(item.name, x + TILE_W / 2, y + COVER_H + 16, TILE_W, 13, '#ffffff');
    if (item.artist) {
      drawText(item.artist, x + TILE_W / 2, y + COVER_H + 42, TILE_W, 11, '#888888');
    }

    if (isHovered) ctx.restore();
  }

  function drawSection(items, title, startY, cols, canvasWidth) {
    const gridWidth = cols * TILE_W + (cols - 1) * currentGap;
    const gridStartX = Math.max(20, (canvasWidth - gridWidth) / 2);

    ctx.font = 'bold 18px oswald, sans-serif';
    ctx.fillStyle = '#e2c044';
    ctx.textAlign = 'center';
    ctx.fillText(title, canvasWidth / 2, startY + 24);

    let y = startY + HEADER_H;
    items.forEach((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gridStartX + col * (TILE_W + currentGap);
      const itemY = y + row * (TILE_H + currentGap);
      const isHovered = hoveredItem === item;

      hitRegions.push({ x, y: itemY, w: TILE_W, h: TILE_H, item });
      drawTile(item, x, itemY, isHovered);
    });

    const rows = Math.ceil(items.length / cols);
    return y + (rows - 1) * (TILE_H + currentGap) + TILE_H;
  }

  function drawMessage(text, subtextLines = [], yOffset = 0) {
    const cssW = canvas.width / (window.devicePixelRatio || 1);
    const cssH = canvas.height / (window.devicePixelRatio || 1);
    const cx = cssW / 2;
    const cy = cssH / 2 + yOffset;

    if (subtextLines.length) {
      ctx.fillStyle = '#e2c044';
      ctx.font = 'bold 16px source_serif_4, serif';
      ctx.textAlign = 'center';
      ctx.fillText(text, cx, cy - 20);
      ctx.fillStyle = '#ffffff';
      ctx.font = '14px source_serif_4, serif';
      subtextLines.forEach((l, idx) => ctx.fillText(l, cx, cy + 10 + idx * 18));
    } else {
      ctx.fillStyle = '#888888';
      ctx.font = '16px source_serif_4, serif';
      ctx.textAlign = 'center';
      ctx.fillText(text, cx, cy);
    }
  }

  function draw() {
    updateGap();
    updateSectionGap();
    const prevScale = currentHoverScale;
    const target = hoveredItem ? HOVER_SCALE : 1;
    currentHoverScale += (target - currentHoverScale) * LERP_FACTOR;

    if (!needsRedraw && Math.abs(currentHoverScale - prevScale) < 0.001) return;
    needsRedraw = false;

    const cssW = canvas.width / (window.devicePixelRatio || 1);
    const cssH = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, cssW, cssH);
    hitRegions = [];

    if (!credentials) {
      drawMessage('Connect Spotify in Settings to explore.');
      return;
    }

    if (apiError) {
      drawMessage(friendlyError(apiError));
      return;
    }

    if (!savedAlbums.length && !savedPlaylists.length) {
      drawMessage('No saved albums or playlists found.');
      return;
    }

    const cols = Math.max(1, Math.floor(cssW / (TILE_W + currentGap)));
    let nextY = 20;
    if (savedAlbums.length) {
      nextY = drawSection(savedAlbums, 'Saved Albums', nextY, cols, cssW);
      nextY += currentSectionGap;
    }
    if (savedPlaylists.length) {
      drawSection(savedPlaylists, 'Saved Playlists', nextY, cols, cssW);
    }
  }

  /* ─── Interaction ─── */
  function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    const cssW = canvas.width / (window.devicePixelRatio || 1);
    const cssH = canvas.height / (window.devicePixelRatio || 1);
    return {
      mx: (e.clientX - rect.left) * (cssW / rect.width),
      my: (e.clientY - rect.top) * (cssH / rect.height)
    };
  }

  function findHitRegion(mx, my) {
    for (const r of hitRegions) {
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return r.item;
    }
    return null;
  }

  canvas.addEventListener('click', (e) => {
    try {
      const { mx, my } = getMousePos(e);
      const item = findHitRegion(mx, my);
      if (!item) return;
      if (item.type === 'Saved Album') {
        loadAlbumTracks(item.id, item.name, item.artist, item.image);
      } else if (item.type === 'Saved Playlist') {
        loadPlaylistTracks(item.id, item.name, item.image);
      }
    } catch (err) {
      console.error('[explore] Click handler error:', err);
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const { mx, my } = getMousePos(e);
    const prev = hoveredItem;
    hoveredItem = findHitRegion(mx, my);
    if (hoveredItem !== prev) {
      canvas.style.cursor = hoveredItem ? 'pointer' : 'default';
      needsRedraw = true;
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (!hoveredItem) return;
    hoveredItem = null;
    canvas.style.cursor = 'default';
    needsRedraw = true;
  });

  searchBtn.addEventListener('click', () => doSearch(searchInput.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch(searchInput.value);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideDropdown();
  });
  document.addEventListener('click', (e) => {
    if (dropdown && searchContainer && !searchContainer.contains(e.target)) {
      hideDropdown();
    }
  });

  /* ─── Observers / lifecycle ─── */
  new ResizeObserver(() => resize()).observe(canvas.parentElement);

  const exploreTab = document.getElementById('explore');
  if (exploreTab) {
    const tabObserver = new MutationObserver(() => {
      if (!exploreTab.classList.contains('active')) return;
      getCredentials().then(() => {
        let p = Promise.resolve();
        if (credentials) {
          if (!savedAlbums.length) p = p.then(() => fetchSavedAlbums());
          if (!savedPlaylists.length) p = p.then(() => fetchSavedPlaylists());
        }
        p.then(() => resize());
      });
    });
    tabObserver.observe(exploreTab, { attributes: true, attributeFilter: ['class'] });
  }

  function animate() {
    draw();
    requestAnimationFrame(animate);
  }
  animate();

  (async function init() {
    await getCredentials();
    await Promise.all([fetchSavedAlbums(), fetchSavedPlaylists()]);
    resize();
  })();

  window.updateSpotifyTracklistHighlight = () => {
    const idx = window.spotifyCurrentIndex ?? 0;
    window.highlightTracklistItems?.('#explore .library-tracklist .tracklist-item', idx);
  };
})();
