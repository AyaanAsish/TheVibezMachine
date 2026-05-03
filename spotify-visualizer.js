/**
 * Spotify Visualizer
 *
 * The Spotify Web Playback SDK does not expose raw audio, and macOS blocks
 * desktop audio capture without Screen Recording permission. So Butterchurn
 * cannot react to the actual Spotify audio. Instead, we simply keep Butterchurn
 * visible during Spotify playback — it renders its preset animation (just
 * without audio-driven reactivity). This is the same behavior as when no local
 * track is loaded: Butterchurn shows a pretty screensaver.
 */
(function () {
  const butterchurnCanvas = document.getElementById('visCanvas');

  function updateVisibility() {
    if (!butterchurnCanvas) return;
    // Always show Butterchurn — whether local or Spotify is playing.
    // Local audio drives it via player.js. Spotify audio is inaccessible,
    // so Butterchurn just renders the preset statically.
    butterchurnCanvas.style.display = 'block';
  }

  // Watch isSpotifyPlayback flag so we can log state changes
  let lastSpotifyState = window.isSpotifyPlayback;
  setInterval(() => {
    if (window.isSpotifyPlayback !== lastSpotifyState) {
      lastSpotifyState = window.isSpotifyPlayback;
      console.log('[spotify-visualizer] Spotify playback state:', lastSpotifyState);
    }
  }, 300);

  updateVisibility();
  window.updateSpotifyVisualizerVisibility = updateVisibility;
})();
