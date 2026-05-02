(function () {
  let player = null;
  let deviceId = null;

  window.spotifyDeviceId = null;
  window.isSpotifyPlayback = false;
  window.spotifyPlaybackState = null;

  async function getToken() {
    try {
      const creds = await window.electronAPI.getSpotifyCredentials();
      return creds ? creds.accessToken : null;
    } catch (e) {
      return null;
    }
  }

  function updatePlayerUI(state) {
    if (!state || !state.track_window || !state.track_window.current_track) return;
    const track = state.track_window.current_track;
    const durationMs = track.duration_ms || 1;
    const positionMs = state.position || 0;
    const pct = (positionMs / durationMs) * 100;

    document.getElementById('track-name').textContent = track.name + ' — ' + track.artists.map(a => a.name).join(', ');
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('current-time').textContent = fmt(positionMs / 1000);
    document.getElementById('duration').textContent = fmt(durationMs / 1000);
    document.getElementById('btn-play').textContent = state.paused ? '▶' : '⏸';
  }

  function fmt(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  function initSpotifyPlayer() {
    player = new Spotify.Player({
      name: 'TheVibezMachine',
      getOAuthToken: (cb) => {
        getToken().then(token => {
          if (token) cb(token);
          else console.error('[spotify-player] No token available');
        });
      },
      volume: 0.5
    });

    player.addListener('ready', ({ device_id }) => {
      console.log('[spotify-player] Ready with Device ID', device_id);
      deviceId = device_id;
      window.spotifyDeviceId = device_id;
      // Immediately make this device active so Web API play commands work
      window.electronAPI.spotifyTransferPlayback(device_id).then(result => {
        if (result.success) {
          console.log('[spotify-player] Playback transferred to device', device_id);
        } else {
          console.warn('[spotify-player] Transfer failed:', result.error);
        }
      });
    });

    player.addListener('not_ready', ({ device_id }) => {
      console.log('[spotify-player] Device ID has gone offline', device_id);
      deviceId = null;
      window.spotifyDeviceId = null;
    });

    player.addListener('player_state_changed', (state) => {
      window.spotifyPlaybackState = state;
      if (state && state.track_window && state.track_window.current_track) {
        window.isSpotifyPlayback = true;
        updatePlayerUI(state);
      } else {
        window.isSpotifyPlayback = false;
      }
    });

    player.addListener('initialization_error', ({ message }) => {
      console.error('[spotify-player] Initialization error:', message);
      alert('Spotify player initialization failed: ' + message);
    });

    player.addListener('authentication_error', ({ message }) => {
      console.error('[spotify-player] Authentication error:', message);
    });

    player.addListener('account_error', ({ message }) => {
      console.error('[spotify-player] Account error:', message);
      alert('Spotify Premium is required for in-app playback.');
    });

    player.connect().then((success) => {
      console.log('[spotify-player] connect() returned:', success);
    });
  }

  // Defensive init: if the SDK already loaded before this script ran, start immediately.
  if (window.Spotify) {
    initSpotifyPlayer();
  } else {
    window.onSpotifyWebPlaybackSDKReady = initSpotifyPlayer;
  }

  window.spotifyTogglePlay = () => {
    if (!player) return;
    player.togglePlay();
  };

  window.spotifyNextTrack = () => {
    if (!player) return;
    player.nextTrack();
  };

  window.spotifyPreviousTrack = () => {
    if (!player) return;
    player.previousTrack();
  };

  window.spotifySeek = (positionMs) => {
    if (!player) return;
    player.seek(positionMs);
  };

  window.spotifySetVolume = (volume) => {
    if (!player) return;
    player.setVolume(volume);
  };

  window.spotifyPlayTrack = async (uri) => {
    // First: try our Web Playback SDK device
    let attempts = 0;
    const maxAttempts = 8; // ~4 seconds max wait
    while (attempts < maxAttempts) {
      const activeDeviceId = window.spotifyDeviceId;
      if (activeDeviceId) {
        console.log('[spotify-player] Playing on Web Playback SDK device:', activeDeviceId);
        const result = await window.electronAPI.spotifyPlayTrack(uri, activeDeviceId);
        if (result.success) {
          window.isSpotifyPlayback = true;
          return;
        }
        if (result.error && result.error.includes('NO_ACTIVE_DEVICE') && attempts === 0) {
          console.log('[spotify-player] Device not active, transferring...');
          await window.electronAPI.spotifyTransferPlayback(activeDeviceId);
          await new Promise(r => setTimeout(r, 700));
          attempts++;
          continue;
        }
        console.error('[spotify-player] Failed to start track on SDK device:', result.error);
        break; // Fall through to device fallback
      }
      console.log('[spotify-player] Waiting for SDK device ID...');
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    // Fallback: query user's available Spotify devices and play on an active one
    console.log('[spotify-player] SDK device not ready. Querying available devices...');
    const devicesResult = await window.electronAPI.spotifyGetDevices();
    if (!devicesResult.success) {
      console.error('[spotify-player] Failed to get devices:', devicesResult.error);
      alert('Spotify player is not ready. Open Spotify on your phone or computer and try again.');
      return;
    }

    const devices = devicesResult.devices || [];
    console.log('[spotify-player] Available devices:', devices.map(d => ({ name: d.name, id: d.id, is_active: d.is_active })));

    // Prefer an active device, then any available device
    let targetDevice = devices.find(d => d.is_active) || devices[0];
    if (!targetDevice) {
      alert('No Spotify devices found. Open Spotify on your phone or computer and try again.');
      return;
    }

    console.log('[spotify-player] Falling back to device:', targetDevice.name, targetDevice.id);
    const playResult = await window.electronAPI.spotifyPlayTrack(uri, targetDevice.id);
    if (playResult.success) {
      window.isSpotifyPlayback = true;
      console.log('[spotify-player] Playback started on fallback device:', targetDevice.name);
    } else {
      console.error('[spotify-player] Fallback playback failed:', playResult.error);
      alert('Failed to play: ' + playResult.error);
    }
  };
})();
