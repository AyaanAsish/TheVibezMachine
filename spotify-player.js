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

    const trackNameEl = document.getElementById('track-name');
    trackNameEl.textContent = track.name + ' — ' + track.artists.map(a => a.name).join(', ');

    // Add/Remove scrolling animation if text overflows
    if (trackNameEl.scrollWidth > trackNameEl.clientWidth) {
      trackNameEl.classList.add('scroll-animation');
    } else {
      trackNameEl.classList.remove('scroll-animation');
    }

    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('current-time').textContent = fmt(positionMs / 1000);
    document.getElementById('duration').textContent = fmt(durationMs / 1000);
    document.getElementById('btn-play').textContent = state.paused ? '▶' : '⏸';
  }

  // Lightweight update that only touches the progress bar and times,
  // called from the smooth polling interval so the UI doesn't jump.
  function updateProgressOnly(state) {
    if (!state || !state.track_window || !state.track_window.current_track) return;
    const durationMs = state.track_window.current_track.duration_ms || 1;
    const positionMs = state.position || 0;
    const pct = (positionMs / durationMs) * 100;
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('current-time').textContent = fmt(positionMs / 1000);
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

    window.spotifyPlayerInstance = player;

    player.addListener('ready', ({ device_id }) => {
      console.log('[spotify-player] Ready with Device ID', device_id);
      deviceId = device_id;
      window.spotifyDeviceId = device_id;
    });

    player.addListener('not_ready', ({ device_id }) => {
      console.log('[spotify-player] Device ID has gone offline', device_id);
      deviceId = null;
      window.spotifyDeviceId = null;
      // If we were playing Spotify, reset the flag so controls fall back gracefully
      if (window.isSpotifyPlayback) {
        window.isSpotifyPlayback = false;
      }
      // Try to reconnect after a short delay
      setTimeout(() => {
        if (player) {
          console.log('[spotify-player] Attempting reconnect...');
          player.connect().catch(err => {
            console.error('[spotify-player] Reconnect failed:', err);
          });
        }
      }, 2000);
    });

    // Keep-alive: poll state every 10s so Spotify does not mark the device inactive
    setInterval(() => {
      if (player) {
        player.getCurrentState().then(state => {
          if (!state && window.isSpotifyPlayback) {
            console.warn('[spotify-player] Playback lost — another device may have taken over');
            // Attempt to reclaim playback to this device
            const activeDeviceId = window.spotifyDeviceId;
            if (activeDeviceId) {
              window.electronAPI.spotifyTransferPlayback(activeDeviceId).catch(() => {});
            }
          }
        }).catch(err => {
          console.error('[spotify-player] Keep-alive poll error:', err);
        });
      }
    }, 10000);

    // Smooth progress updates: poll every 200ms so the progress bar and time
    // don't jump between player_state_changed events.
    setInterval(() => {
      if (player && window.isSpotifyPlayback) {
        player.getCurrentState().then(state => {
          if (state && !state.paused) {
            updateProgressOnly(state);
          }
        }).catch(() => {});
      }
    }, 200);

    let lastTrackUri = null;

    player.addListener('player_state_changed', (state) => {
      window.spotifyPlaybackState = state;
      if (state && state.track_window && state.track_window.current_track) {
        const track = state.track_window.current_track;

        if (track.uri && track.uri !== lastTrackUri) {
          lastTrackUri = track.uri;
        }

        // If the SDK reports paused and we already switched to local playback,
        // ignore this stale state entirely so it doesn't overwrite the local UI.
        if (state.paused && !window.isSpotifyPlayback) {
          return;
        }
        window.isSpotifyPlayback = true;
        updatePlayerUI(state);

        // If a manual queue is active, sync the current index to the new track
        if (window.spotifyQueue && Array.isArray(window.spotifyQueue)) {
          const newIdx = window.spotifyQueue.findIndex(t => t.uri === track.uri);
          if (newIdx >= 0) {
            window.spotifyCurrentIndex = newIdx;
            updateSpotifyTracklistHighlight();
          }
        }
      } else {
        window.isSpotifyPlayback = false;
        lastTrackUri = null;
      }

      if (window.updateSpotifyVisualizerVisibility) {
        window.updateSpotifyVisualizerVisibility();
      }
    });

    player.addListener('initialization_error', ({ message }) => {
      console.error('[spotify-player] Initialization error:', message);
      alert('Spotify player initialization failed: ' + message);
    });

    player.addListener('authentication_error', ({ message }) => {
      console.error('[spotify-player] Authentication error:', message);
      alert('Spotify authentication error: ' + message + '. Try reconnecting in Settings.');
    });

    player.addListener('account_error', ({ message }) => {
      console.error('[spotify-player] Account error:', message);
      alert('Spotify Premium is required for in-app playback.');
    });

    player.addListener('playback_error', ({ message }) => {
      console.error('[spotify-player] Playback error:', message);
      // A playback error usually means the SDK lost the audio stream.
      // Pause gracefully so the user sees the player stopped.
      if (player) {
        player.pause();
      }
    });

    console.log('[spotify-player] Calling player.connect()...');
    player.connect().then((success) => {
      console.log('[spotify-player] connect() returned:', success);
    }).catch(err => {
      console.error('[spotify-player] connect() failed:', err);
    });
  }

  // Global error handlers to catch SDK iframe errors
  window.addEventListener('error', (e) => {
    console.error('[spotify-player] Global error:', e.message, e.filename, e.lineno);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[spotify-player] Unhandled rejection:', e.reason);
  });

  // Defensive init: if the SDK already loaded before this script ran, start immediately.
  console.log('[spotify-player] EME available:', typeof navigator.requestMediaKeySystemAccess);
  console.log('[spotify-player] Location:', window.location.href);
  if (window.Spotify) {
    console.log('[spotify-player] Spotify SDK already loaded, initializing player after brief delay...');
    setTimeout(initSpotifyPlayer, 200);
  } else {
    console.log('[spotify-player] Waiting for Spotify SDK to load...');
    window.onSpotifyWebPlaybackSDKReady = initSpotifyPlayer;
  }

  window.spotifyTogglePlay = () => {
    if (!player) return;
    player.togglePlay();
  };

  window.spotifyPause = () => {
    if (!player) return Promise.resolve();
    return player.pause();
  };

  window.spotifyNextTrack = () => {
    if (!player) return;
    // If we have a manual queue (e.g., from Explore tracklist), use it.
    // The SDK's internal nextTrack() only works when Spotify provides a queue.
    if (window.spotifyQueue && Array.isArray(window.spotifyQueue)) {
      const idx = (window.spotifyCurrentIndex || 0) + 1;
      if (idx < window.spotifyQueue.length) {
        const next = window.spotifyQueue[idx];
        if (next && next.uri) {
          window.spotifyCurrentIndex = idx;
          window.spotifyPlayTrack(next.uri);
          updateSpotifyTracklistHighlight();
          return;
        }
      }
    }
    // Fallback to SDK method (works for album/playlist context playback)
    player.nextTrack();
  };

  window.spotifyPreviousTrack = () => {
    if (!player) return;
    // Same manual-queue logic for previous track
    if (window.spotifyQueue && Array.isArray(window.spotifyQueue)) {
      const idx = (window.spotifyCurrentIndex || 0) - 1;
      if (idx >= 0) {
        const prev = window.spotifyQueue[idx];
        if (prev && prev.uri) {
          window.spotifyCurrentIndex = idx;
          window.spotifyPlayTrack(prev.uri);
          updateSpotifyTracklistHighlight();
          return;
        }
      }
    }
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

  function updateSpotifyTracklistHighlight() {
    const idx = window.spotifyCurrentIndex || 0;
    const exploreItems = document.querySelectorAll('#explore .library-tracklist .tracklist-item');
    if (exploreItems.length > 0) {
      exploreItems.forEach((el, i) => el.classList.toggle('active', i === idx));
    }
  }

  window.spotifyPlayTrack = async (uri) => {
    // Pause local audio before starting Spotify playback
    if (window.pauseLocalAudio) window.pauseLocalAudio();

    // Wait for the Web Playback SDK device to be ready
    let attempts = 0;
    const maxAttempts = 30;
    while (attempts < maxAttempts) {
      const activeDeviceId = window.spotifyDeviceId;
      if (activeDeviceId) {
        // STEP 1: Transfer to our device with play=true so Spotify
        // treats it as the active device immediately.
        const xfer = await window.electronAPI.spotifyTransferPlayback(activeDeviceId, true);
        if (!xfer.success) {
          console.warn('[spotify-player] Transfer failed:', xfer.error);
        }

        // STEP 2: Give Spotify's backend time to register the device switch.
        // 3s is usually enough; increase on retry.
        const waitMs = 2000 + attempts * 500;
        await new Promise(r => setTimeout(r, waitMs));

        // STEP 3: Play the specific track on our device explicitly.
        // Passing device_id guarantees the request goes to the SDK,
        // not the user's phone/desktop app.
        console.log('[spotify-player] Playing track on SDK device:', activeDeviceId);
        const result = await window.electronAPI.spotifyPlayTrack(uri, activeDeviceId);
        if (result.success) {
          window.isSpotifyPlayback = true;
          return;
        }
        if (result.error && result.error.includes('NO_ACTIVE_DEVICE')) {
          console.log('[spotify-player] Device not active yet, retrying... (attempt', attempts + 1, ')');
          attempts++;
          continue;
        }
        console.error('[spotify-player] Failed to start track:', result.error);
        alert('Failed to play in-app: ' + result.error);
        return;
      }
      console.log('[spotify-player] Waiting for SDK device ID...');
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    const spotifyAvailable = typeof window.Spotify !== 'undefined' ? 'SDK loaded' : 'SDK NOT loaded';
    console.error('[spotify-player] Device never became ready.', spotifyAvailable, 'DeviceId:', window.spotifyDeviceId);
    alert('In-app Spotify player is not ready.\n\nStatus: ' + spotifyAvailable + '\n\nIf you have Spotify Premium, try restarting the app. If not, in-app playback requires a Premium account.');
  };
})();
