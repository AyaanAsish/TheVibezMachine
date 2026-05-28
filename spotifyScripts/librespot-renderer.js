(function () {
  'use strict'

  // -- State --
  let ctx = null
  let vis = null
  let pendingChunks = [] // Array of Float32Arrays (interleaved stereo)
  let chunkReadIndex = 0  // Read position into pendingChunks (avoids O(n) shift)
  let currentChunk = null
  let readIndex = 0
  let isSpotifyActive = false
  let graphInitialized = false
  let spotifySamplesPlayed = 0   // Monotonically increasing count of audio frames output
  let positionAnchorMs = 0       // Position (ms) from the last anchor event
  let positionAnchorSamples = 0  // spotifySamplesPlayed value at the time of that event

  // -- Audio graph nodes --
  let scriptNode = null
  let gainNode = null

  const BUFFER_SIZE = 4096 // ~371ms @ 44.1kHz — larger than librespot chunk variance
  const PREBUFFER_CHUNKS = 4  // wait for ~4 chunks before unmuting
  let prebuffered = false
  let lastEventTime = 0

  function setGain(v) {
    if (!gainNode) return
    gainNode.gain.value = Math.max(0, Math.min(2, v))
  }

  function isSpotifyPlaying() {
    return !!(window.PlaybackState && window.PlaybackState.isPlaying)
  }

  function tryUnmute() {
    if (gainNode && !prebuffered && pendingChunks.length >= PREBUFFER_CHUNKS) {
      prebuffered = true
      setGain(1)
    }
  }

  function initGraph() {
    ctx = window.visualizerAudioContext
    vis = window.myVisualizer

    if (!ctx) {
      console.warn('[librespot-renderer] initGraph: AudioContext not ready')
      return false
    }
    if (scriptNode) {
      return true
    }

    try {
      gainNode = ctx.createGain()
      gainNode.gain.value = 0.0 // start muted until prebuffer fills

      scriptNode = ctx.createScriptProcessor(BUFFER_SIZE, 0, 2)
      scriptNode.onaudioprocess = (e) => {
        const outL = e.outputBuffer.getChannelData(0)
        const outR = e.outputBuffer.getChannelData(1)

        // When not playing, emit silence but do NOT consume buffered chunks.
        // This ensures playback resumes exactly where it left off.
        if (!isSpotifyPlaying()) {
          for (let i = 0; i < outL.length; i++) {
            outL[i] = 0
            outR[i] = 0
          }
          return
        }

        let framesOutputThisBlock = 0
        for (let i = 0; i < outL.length; i++) {
          if (!currentChunk || readIndex >= currentChunk.length) {
            currentChunk = chunkReadIndex < pendingChunks.length ? pendingChunks[chunkReadIndex++] : null
            readIndex = 0
          }
          if (currentChunk) {
            outL[i] = currentChunk[readIndex]
            outR[i] = currentChunk[readIndex + 1]
            readIndex += 2
            framesOutputThisBlock++
          } else {
            outL[i] = 0
            outR[i] = 0
          }
        }

        spotifySamplesPlayed += framesOutputThisBlock
        // Compact consumed chunks periodically to prevent unbounded growth
        if (chunkReadIndex > 64) {
          pendingChunks.splice(0, chunkReadIndex)
          chunkReadIndex = 0
        }
        tryUnmute()
      }

      scriptNode.connect(gainNode)
      gainNode.connect(ctx.destination)

      graphInitialized = true
      return true
    } catch (err) {
      console.error('[librespot-renderer] initGraph failed:', err)
      return false
    }
  }

  let isVisualizerConnected = false

  function connectVisualizer() {
    if (!vis || !gainNode) {
      console.warn('[librespot-renderer] connectVisualizer: missing vis or gainNode')
      return
    }
    if (isVisualizerConnected) return
    try {
      vis.connectAudio(gainNode)
      isVisualizerConnected = true
    } catch (e) {
      console.warn('[librespot-renderer] connectAudio error:', e)
    }
  }

  function disconnectVisualizer() {
    if (!vis || !gainNode) return
    try {
      vis.disconnectAudio(gainNode)
      isVisualizerConnected = false
    } catch (_) {}
  }

  function destroyGraph() {
    if (!scriptNode) return
    disconnectVisualizer()
    try { scriptNode.disconnect() } catch (_) {}
    try { gainNode.disconnect() } catch (_) {}
    scriptNode = null
    gainNode = null
    graphInitialized = false
    prebuffered = false
  }

  // -- PCM ingestion --
  const LOCAL_SWITCH_GUARD_MS = 2000

  function knownInQueue(uri) {
    const q = window.spotifyQueue
    return q && Array.isArray(q) && q.some(t => t.uri === uri)
  }

  function clearBuffers() {
    pendingChunks.length = 0
    chunkReadIndex = 0
    currentChunk = null
    readIndex = 0
    prebuffered = false
  }

  function switchToSpotify() {
    if (window.pauseLocalAudio) window.pauseLocalAudio()
    if (window.disconnectLocalAudio) window.disconnectLocalAudio()
    if (window.PlaybackState) {
      window.PlaybackState.setMode('spotify')
    }
  }

  function onSpotifyPcm(buffer) {
    if (!window.isSpotifyPlayback) {
      const lastSwitch = (window.PlaybackState?.lastSwitchTime) || 0
      if (Date.now() - lastSwitch < LOCAL_SWITCH_GUARD_MS) {
        return
      }
      // Only hijack if Spotify mode was already requested by the app
      if (window.PlaybackState?.mode !== 'spotify') {
        return
      }
      switchToSpotify()
      if (window.startSpotifyPositionTicker) window.startSpotifyPositionTicker()
    }
    window.startSpotifyAudio()
    if (!buffer) return

    // Drop PCM while not playing to prevent stale chunk accumulation
    if (!isSpotifyPlaying()) return

    let int16
    try {
      int16 = new Int16Array(buffer)
    } catch (err) {
      console.error('[librespot-renderer] onSpotifyPcm: cannot create Int16Array', err)
      return
    }

    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768
    }
    pendingChunks.push(float32)
    tryUnmute()
  }

  // -- Events --
  function onSpotifyEvent(event) {
    if (!event) return
    const gapSinceLastEvent = Date.now() - lastEventTime
    lastEventTime = Date.now()
    const state = event.state || event.type

    // Throttle logging for high-frequency health/metric events to avoid
    // flooding the console and freezing the app during PCM stalls.
    if (state === 'health' || state === 'metric') {
      // Health/metric events carry no playback state — skip all processing.
      return
    }

    if (state === 'playing') {
      // If this is the first event after a long disconnect, clear stale buffers
      // to prevent audio bleed from before the disconnect.
      if (gapSinceLastEvent > 10000) {
        clearBuffers()
        prebuffered = false
        setGain(0)
      }
      const lastSwitch = (window.PlaybackState?.lastSwitchTime) || 0
      if (Date.now() - lastSwitch < LOCAL_SWITCH_GUARD_MS && (!window.PlaybackState || window.PlaybackState.mode !== 'spotify')) {
        return
      }

      // Only switch to Spotify if the URI is known in our queue or already in spotify mode
      if (window.PlaybackState?.mode !== 'spotify') {
        if (event.uri && !knownInQueue(event.uri)) {
          return
        }
        switchToSpotify()
      }

      if (window.PlaybackState) {
        const sinceUserAction = Date.now() - (window.PlaybackState.lastUserActionTime || 0)
        // Don't re-enable playback from a stale 'playing' event if the user
        // recently clicked pause — the optimistic UI state is more reliable
        // than the event during this window.
        if (sinceUserAction >= 3000 || window.PlaybackState.isPlaying) {
          window.PlaybackState.setPlaying(true)
        }
        window.PlaybackState.isDeviceActive = true
        // Only update duration from events — position is handled by the
        // sample-based ticker which tracks what the user actually hears.
        // The event's positionMs includes buffer delay and would cause
        // the progress bar to jump ahead of the audio.
        if (event.durationMs != null) {
          window.PlaybackState.durationMs = event.durationMs
        }
        // Set position anchor for sample-based tracking.
        // Only reset the anchor on initial play or after a seek/buffer-clear
        // (when positionAnchorSamples is 0, meaning startSpotifyAudio just
        // reset it). On resume from pause, keep the existing anchor so the
        // position continues seamlessly from where the user paused.
        if (event.positionMs != null && positionAnchorSamples === 0) {
          positionAnchorMs = event.positionMs
          positionAnchorSamples = spotifySamplesPlayed
        }
        // Reset the ticker anchor so the position ticker starts counting
        // from this event's position, not from wherever it left off.
        if (window.startSpotifyPositionTicker) {
          window.startSpotifyPositionTicker()
        }
      }

      // If we already have freshly-buffered data (after a seek or initial load),
      // unmute immediately. Stale data from before a pause was already flushed.
      if (prebuffered && pendingChunks.length >= PREBUFFER_CHUNKS) {
        setGain(1)
      }

      // Keep in-app queue index in sync when track changes via any path
      if (event.uri && window.spotifyQueue && Array.isArray(window.spotifyQueue)) {
        const idx = window.spotifyQueue.findIndex(t => t.uri === event.uri)
        if (idx !== -1) {
          window.spotifyCurrentIndex = idx
          if (window.updateSpotifyTracklistHighlight) {
            window.updateSpotifyTracklistHighlight()
          }
        }
      }

      window.startSpotifyAudio()
    } else if (state === 'paused') {
      if (window.PlaybackState) {
        // Don't override positionMs from the event — the sample-based
        // position already reflects what the user heard. The event's
        // positionMs includes buffer delay and would cause the progress
        // bar to jump ahead of the audio.
        const sinceUserAction = Date.now() - (window.PlaybackState.lastUserActionTime || 0)
        // Don't re-pause from a stale 'paused' event if the user recently
        // clicked play — the optimistic UI state is more reliable.
        if (sinceUserAction >= 3000 || !window.PlaybackState.isPlaying) {
          window.PlaybackState.setPlaying(false)
        }
        window.PlaybackState.setProgress(null, null)
      }
    } else if (state === 'end_of_track' || state === 'stopped') {
      if (window.PlaybackState) {
        window.PlaybackState.setPlaying(false)
        window.PlaybackState.isDeviceActive = false
      }
      clearBuffers()
      setGain(0)

      if (state === 'end_of_track') {
        // Only auto-advance if playback was active when the track ended
        const wasPlaying = window.PlaybackState?.isPlaying || false
        if (wasPlaying) {
          if (window.PlaybackState) {
            window.PlaybackState.advance(1)
          } else if (window.spotifyQueue && Array.isArray(window.spotifyQueue) && window.spotifyCurrentIndex != null) {
            const nextIdx = window.spotifyCurrentIndex + 1
            if (nextIdx < window.spotifyQueue.length) {
              const next = window.spotifyQueue[nextIdx]
              if (next && next.uri) {
                window.spotifyCurrentIndex = nextIdx
                // Update cover to next track's album art
                if (next.albumImage) {
                  window.currentPlaylistCover = next.albumImage
                  if (window.updatePlayerCover) window.updatePlayerCover(next.albumImage)
                }
                window.spotifyPlayTrack(next.uri)
                if (window.updateSpotifyTracklistHighlight) {
                  window.updateSpotifyTracklistHighlight()
                }
              }
            }
          }
        }
      }
    } else if (state === 'volume' || event.volume != null) {
      let v = event.volume ?? 1.0
      if (typeof v === 'number' && v > 10) v = v / 65535
      window.setSpotifyVolume(v)
    }

    if (event.title && event.artist && window.isSpotifyPlayback) {
      if (window.PlaybackState) {
        // Use album art from the queue entry if available, otherwise fall back to currentPlaylistCover
        const queueIdx = window.spotifyQueue?.findIndex(t => t.uri === event.uri)
        const cover = (queueIdx != null && queueIdx !== -1 && window.spotifyQueue[queueIdx]?.albumImage) || window.currentPlaylistCover
        window.PlaybackState.setTrackInfo(event.title + ' — ' + event.artist, cover)
      }
    }
  }

  // -- Poll fallback --
  function onSpotifyPoll(result) {
    if (!result || !result.success || !result.data) return
    const data = result.data
    const pollTime = Date.now()
    const eventAge = pollTime - lastEventTime

    // If events are arriving normally (< 10s gap), only trust poll for
    // position corrections and track info. Don't override play/pause state
    // from events because the event is the ground truth when it's fresh.
    const eventsStale = eventAge > 10000

    if (eventsStale) {
      console.warn('[librespot-renderer] No librespot events for', eventAge, 'ms — trusting poll data')
    }

    if (window.PlaybackState) {
      const wasPlaying = window.PlaybackState.isPlaying
      const pollPlaying = !!data.is_playing

      // Only override play state and position if events are stale (no librespot
      // events for >10s) AND the user hasn't clicked play/pause recently.
      // A poll request in-flight during a pause can return stale is_playing=true,
      // which would reactivate the ticker and make the bar skip ahead.
      const sinceUserAction = Date.now() - (window.PlaybackState.lastUserActionTime || 0)
      const userActionCooldown = sinceUserAction < 3000

      if (eventsStale && !userActionCooldown) {
        window.PlaybackState.setPlaying(pollPlaying)
        if (data.progress_ms != null) {
          // Don't override positionMs directly — use the anchor reset
          // which lets the sample-based ticker take over from the poll position.
          if (window.resetSpotifyPositionAnchor) {
            window.resetSpotifyPositionAnchor(data.progress_ms)
          }
        }
      } else if (eventsStale && userActionCooldown) {
        // Poll ignored during user action cooldown
      }

      // Sync duration and track info when the track changed
      if (data.item) {
        if (data.item.duration_ms != null) {
          window.PlaybackState.durationMs = data.item.duration_ms
        }
        const trackName = data.item.name || 'Unknown'
        const trackArtists = (data.item.artists || []).map(a => a.name).join(', ')
        // Use album art from the queue entry if available, otherwise use the track's own album image
        const queueIdx = window.spotifyQueue?.findIndex(t => t.uri === data.item.uri)
        const cover = (queueIdx != null && queueIdx !== -1 && window.spotifyQueue[queueIdx]?.albumImage)
          || data.item.album?.images?.[0]?.url
          || window.currentPlaylistCover
        window.PlaybackState.setTrackInfo(trackName + ' — ' + trackArtists, cover)

        // Keep queue index in sync
        if (data.item.uri && window.spotifyQueue && Array.isArray(window.spotifyQueue)) {
          const idx = window.spotifyQueue.findIndex(t => t.uri === data.item.uri)
          if (idx !== -1) {
            window.spotifyCurrentIndex = idx
            if (window.updateSpotifyTracklistHighlight) {
              window.updateSpotifyTracklistHighlight()
            }
          }
        }
      }

      // Re-apply progress bar visual update
      window.PlaybackState.setProgress(null, null)
    }
  }

  // -- Global controls --
  window.startSpotifyAudio = () => {
    const ok = initGraph()
    if (!ok && !scriptNode) return

    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {})
    }

    if (isSpotifyActive) {
      connectVisualizer()
      return
    }

    isSpotifyActive = true
    spotifySamplesPlayed = 0
    positionAnchorMs = 0
    positionAnchorSamples = 0
    connectVisualizer()
  }

  window.stopSpotifyAudio = () => {
    if (!isSpotifyActive) return
    isSpotifyActive = false
    clearBuffers()
    destroyGraph()
  }

  window.flushSpotifyBuffers = () => {
    clearBuffers()
    setGain(0)
  }

  window.setSpotifyVolume = (volume) => {
    let v = volume
    if (typeof v === 'number' && v > 10) v = v / 65535
    setGain(v)
  }

  window.getSpotifyPosition = () => {
    if (!isSpotifyActive) return null
    return positionAnchorMs + ((spotifySamplesPlayed - positionAnchorSamples) / 44100) * 1000
  }

  window.resetSpotifyPositionAnchor = (positionMs) => {
    positionAnchorMs = positionMs
    positionAnchorSamples = spotifySamplesPlayed
  }

  // -- Deferred init: wait for AudioContext --
  let initAttempts = 0
  function tryInit() {
    ctx = window.visualizerAudioContext
    if (!ctx || !window.electronAPI) {
      initAttempts++
      setTimeout(tryInit, 200)
      return
    }

    window.electronAPI.onSpotifyPcm(onSpotifyPcm)
    window.electronAPI.onSpotifyEvent(onSpotifyEvent)
    window.electronAPI.onSpotifyPoll(onSpotifyPoll)
  }

  if (document.readyState === 'complete') {
    tryInit()
  } else {
    window.addEventListener('load', tryInit)
  }
})()
