/**
 * Spotify Visualizer Audio Capture
 *
 * When Spotify is playing, this module generates a silent synthetic audio signal
 * that is rhythmically synced to the track's tempo (fetched from Spotify's
 * audio-features API). The signal is fed into Butterchurn so the visualizer
 * reacts to the music, but it is NOT connected to the audio output (speakers)
 * so you hear nothing.
 *
 * Why not real desktop capture?
 * getUserMedia({ chromeMediaSource: 'desktop' }) causes renderer crashes on
 * macOS in this Electron build. This synthetic approach is crash-safe.
 */
(function () {
  const butterchurnCanvas = document.getElementById('visCanvas');

  let spotifyAudioNodes = null;   // { source, gain, lfo, lfoGain }
  let currentTrackId = null;
  let trackFeatures = null;
  let toastEl = null;

  function showToast(msg, isError) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'viz-toast';
      toastEl.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:6px;font-family:oswald,sans-serif;font-size:13px;z-index:9999;opacity:0;transition:opacity 0.4s;pointer-events:none;';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.background = isError ? 'rgba(200,50,50,0.9)' : 'rgba(30,30,30,0.9)';
    toastEl.style.color = '#fff';
    toastEl.style.opacity = '1';
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => { toastEl.style.opacity = '0'; }, 6000);
  }

  function updateVisibility() {
    if (!butterchurnCanvas) return;
    butterchurnCanvas.style.display = 'block';
  }

  // Fetch audio features (tempo, energy, etc.) for a track
  async function fetchTrackFeatures(trackId) {
    if (!trackId) return null;
    try {
      const result = await window.electronAPI.spotifyApi('/audio-features/' + trackId);
      if (result.success && result.data) {
        console.log('[spotify-visualizer] Audio features for', trackId, ': tempo=', result.data.tempo, 'energy=', result.data.energy);
        return {
          tempo: result.data.tempo || 120,
          energy: result.data.energy || 0.5,
          danceability: result.data.danceability || 0.5,
          valence: result.data.valence || 0.5
        };
      }
    } catch (e) {
      console.warn('[spotify-visualizer] Failed to fetch audio features:', e);
    }
    return null;
  }

  // Create a noise buffer (white noise) that loops
  function createNoiseBuffer(ctx, durationSec) {
    const sampleRate = ctx.sampleRate;
    const frames = Math.floor(sampleRate * durationSec);
    const buffer = ctx.createBuffer(1, frames, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  // Build and start the synthetic audio graph
  function startSyntheticAudio(features) {
    const ctx = window.visualizerAudioContext;
    if (!ctx || !window.myVisualizer) {
      console.warn('[spotify-visualizer] Cannot start synthetic audio: context/visualizer not ready');
      return;
    }

    // Clean up any existing synthetic audio first
    stopSyntheticAudio();

    const tempo = features?.tempo || 120;
    const energy = features?.energy || 0.5;
    const bps = tempo / 60;

    // Create noise buffer source (looping)
    const noiseBuffer = createNoiseBuffer(ctx, 2); // 2-second loop
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;

    // Main gain — controls overall level (silent, just for visualizer)
    const gain = ctx.createGain();
    gain.gain.value = 0.01 + energy * 0.04; // 0.01–0.05 range

    // LFO — modulates gain at the track's tempo to create pulsing
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = bps; // beats per second

    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.02 + energy * 0.03; // modulation depth

    // Wiring:
    // source -> gain -> Butterchurn
    // lfo -> lfoGain -> gain.gain (modulates amplitude)
    source.connect(gain);
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);

    // Connect ONLY to Butterchurn — NOT to ctx.destination (silent!)
    window.myVisualizer.connectAudio(gain);

    source.start();
    lfo.start();

    spotifyAudioNodes = { source, gain, lfo, lfoGain };
    console.log('[spotify-visualizer] Synthetic audio started: tempo=', tempo, 'energy=', energy);
  }

  // Tear down the synthetic audio graph
  function stopSyntheticAudio() {
    if (!spotifyAudioNodes) return;

    try { spotifyAudioNodes.lfo.stop(); } catch (_) {}
    try { spotifyAudioNodes.source.stop(); } catch (_) {}
    try { spotifyAudioNodes.lfo.disconnect(); } catch (_) {}
    try { spotifyAudioNodes.lfoGain.disconnect(); } catch (_) {}
    try { spotifyAudioNodes.source.disconnect(); } catch (_) {}
    try { spotifyAudioNodes.gain.disconnect(); } catch (_) {}

    if (window.myVisualizer && spotifyAudioNodes.gain) {
      try { window.myVisualizer.disconnectAudio(spotifyAudioNodes.gain); } catch (_) {}
    }

    spotifyAudioNodes = null;
    console.log('[spotify-visualizer] Synthetic audio stopped');
  }

  // Reconnect local audio when switching back from Spotify
  function reconnectLocalAudio() {
    if (window.localAudioSource && window.myVisualizer) {
      try { window.myVisualizer.connectAudio(window.localAudioSource); } catch (_) {}
    }
    if (window.visualizerAudioContext && window.visualizerAudioContext.state === 'suspended') {
      window.visualizerAudioContext.resume().catch(() => {});
    }
  }

  // Detect track changes from Spotify playback state
  function checkTrackChange() {
    const state = window.spotifyPlaybackState;
    if (!state || !state.track_window || !state.track_window.current_track) return;

    const track = state.track_window.current_track;
    const trackId = track.id;
    if (!trackId || trackId === currentTrackId) return;

    currentTrackId = trackId;
    console.log('[spotify-visualizer] Track changed:', track.name, 'id=', trackId);

    // If already playing Spotify, restart synthetic audio with new track features
    if (window.isSpotifyPlayback) {
      fetchTrackFeatures(trackId).then(features => {
        trackFeatures = features || { tempo: 120, energy: 0.5 };
        startSyntheticAudio(trackFeatures);
      });
    }
  }

  // Watch the Spotify playback flag
  let lastSpotifyState = window.isSpotifyPlayback;
  setInterval(() => {
    // Check for track changes every tick
    checkTrackChange();

    if (window.isSpotifyPlayback !== lastSpotifyState) {
      lastSpotifyState = window.isSpotifyPlayback;
      console.log('[spotify-visualizer] Spotify playback state:', lastSpotifyState);

      if (lastSpotifyState) {
        // Spotify just started playing
        // Disconnect local audio so it doesn't mix
        if (window.localAudioSource && window.myVisualizer) {
          try { window.myVisualizer.disconnectAudio(window.localAudioSource); } catch (_) {}
        }

        // Start synthetic audio with existing or default features
        const features = trackFeatures || { tempo: 120, energy: 0.5 };
        startSyntheticAudio(features);
        showToast('Visualizer synced to Spotify track', false);
      } else {
        // Spotify stopped — tear down synthetic and reconnect local
        stopSyntheticAudio();
        reconnectLocalAudio();
      }
    }
  }, 300);

  // DevTools helper: manually test synthetic audio
  window.testSyntheticAudio = () => {
    startSyntheticAudio({ tempo: 128, energy: 0.8 });
  };

  updateVisibility();
  window.updateSpotifyVisualizerVisibility = updateVisibility;
})();
