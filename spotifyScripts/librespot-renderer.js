(function () {
  'use strict'

  // -- State --
  let ctx = null
  let vis = null
  const MAX_PENDING_CHUNKS = 64
  let pendingChunks = [] // Array of Float32Arrays (interleaved stereo)
  let chunkReadIndex = 0  // Read position into pendingChunks (avoids O(n) shift)
  let currentChunk = null
  let readIndex = 0
  let isSpotifyActive = false
  let spotifySamplesPlayed = 0   // Monotonically increasing count of audio frames output
  let positionAnchorMs = 0       // Position (ms) from the last anchor event
  let positionAnchorSamples = 0  // spotifySamplesPlayed value at the time of that event
  let anchorInitialized = false  // True once a playing event has set the anchor
  let cachedConversionBuffer = null // Reusable Float32Array for Int16→Float32

  // -- Audio graph nodes --
  let scriptNode = null
  let gainNode = null

  const BUFFER_SIZE = 4096 // ~371ms @ 44.1kHz — larger than librespot chunk variance
  const PREBUFFER_CHUNKS = 2  // wait for ~2 chunks before unmuting (~50ms)
  let prebuffered = false
  let lastEventTime = Date.now()
  let pollStaleLogged = false
  let lastReconnectAttempt = 0
  const RECONNECT_COOLDOWN_MS = 15000  // minimum 15s between reconnection attempts

  function setGain(v) {
    if (!gainNode) return
    gainNode.gain.value = Math.max(0, Math.min(2, v))
  }

  function isSpotifyPlaying() {
    return !!(window.PlaybackState && window.PlaybackState.isPlaying)
  }

  function tryUnmute() {
    if (gainNode && !prebuffered && (pendingChunks.length - chunkReadIndex) >= PREBUFFER_CHUNKS) {
      prebuffered = true
      setGain(1)
      if (window.startSpotifyPositionTicker) window.startSpotifyPositionTicker()
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
        // Compact consumed chunks periodically
        if (chunkReadIndex > 16) {
          pendingChunks = pendingChunks.slice(chunkReadIndex)
          chunkReadIndex = 0
        }
        tryUnmute()
      }

      scriptNode.connect(gainNode)
      gainNode.connect(ctx.destination)

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
    prebuffered = false
  }

  // -- PCM ingestion --
  const LOCAL_SWITCH_GUARD_MS = 1000

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
      // Only accept PCM if a playing event already set spotify mode
      if (window.PlaybackState?.mode !== 'spotify') {
        return
      }
      // Mode is spotify but flag isn't set — sync it
      window.isSpotifyPlayback = true
    }
    if (!isSpotifyActive) window.startSpotifyAudio()
    if (!buffer) return

    // Drop PCM only if the audio graph isn't active yet. When the graph
    // is active, buffer chunks even if isPlaying is false — the audio
    // processor emits silence for paused tracks, and tryUnmute() will
    // un-mute once enough chunks accumulate. This prevents audio gaps
    // when a remote play event sets isPlaying=true shortly after PCM
    // starts arriving.
    if (!isSpotifyActive) return

    let int16
    try {
      int16 = new Int16Array(buffer)
    } catch (err) {
      console.error('[librespot-renderer] onSpotifyPcm: cannot create Int16Array', err)
      return
    }

    // Reuse conversion buffer when chunk size matches
    if (!cachedConversionBuffer || cachedConversionBuffer.length !== int16.length) {
      cachedConversionBuffer = new Float32Array(int16.length)
    }
    const float32 = cachedConversionBuffer
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768
    }
    // Copy into a new Float32Array for the queue (the cached buffer will be overwritten)
    const chunk = new Float32Array(float32)
    // Drop oldest chunks when buffer is full (backpressure)
    if (pendingChunks.length - chunkReadIndex >= MAX_PENDING_CHUNKS) {
      pendingChunks = pendingChunks.slice(chunkReadIndex + 1)
      chunkReadIndex = 0
    }
    pendingChunks.push(chunk)
    tryUnmute()
  }

  // -- Events --
  function onSpotifyEvent(event) {
    if (!event) return
    // Keepalive events (health/metric) just prove the connection is alive
    if (event.keepalive) {
      lastEventTime = Date.now()
      return
    }
    const gapSinceLastEvent = Date.now() - lastEventTime
    lastEventTime = Date.now()
    const state = event.state || event.type

    if (state === 'ready') {
      // Device is fully initialized and ready to accept playback commands
      if (window.PlaybackState) {
        window.PlaybackState.isDeviceActive = true
      }
      console.log('[librespot-renderer] Spotify Connect device is ready')
      return
    }

    if (state === 'playing') {
      // If this is the first event after a long disconnect, clear stale buffers
      // to prevent audio bleed from before the disconnect.
      if (gapSinceLastEvent > 5000) {
        clearBuffers()
        prebuffered = false
        setGain(0)
      }
      const lastSwitch = (window.PlaybackState?.lastSwitchTime) || 0
      if (Date.now() - lastSwitch < LOCAL_SWITCH_GUARD_MS && (!window.PlaybackState || window.PlaybackState.mode !== 'spotify')) {
        return
      }

      // Switch to Spotify when idle, or when the track is in our queue / already in spotify mode.
      // Only block if we're actively playing local audio and the track isn't ours.
      if (window.PlaybackState?.mode !== 'spotify') {
        if (window.PlaybackState?.mode === 'local' && event.uri && !knownInQueue(event.uri)) {
          return
        }
        switchToSpotify()
      }

      if (window.PlaybackState) {
        const sinceUserAction = Date.now() - (window.PlaybackState.lastUserActionTime || 0)
        const wasPlaying = window.PlaybackState.isPlaying

        // Don't re-enable playback from a stale 'playing' event if the user
        // recently clicked pause — the optimistic UI state is more reliable
        // than the event during this window.
        if (sinceUserAction >= 1500 || wasPlaying) {
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

        // Remote resume: the user pressed play on their phone, not in-app.
        // Use the saved in-app position (from the pause event) instead of
        // the event positionMs, and explicitly seek to correct any drift.
        const isRemoteResume = !wasPlaying && sinceUserAction >= 1500
        if (isRemoteResume && window.spPausePosKey) {
          let savedPos = null
          try {
            const raw = localStorage.getItem(window.spPausePosKey)
            if (raw) {
              const s = JSON.parse(raw)
              if (s.pos > 0 && Date.now() - s.ts < 1800000) {
                savedPos = s.pos
              }
            }
          } catch (_) {}

          if (savedPos != null) {
            positionAnchorMs = savedPos
            positionAnchorSamples = spotifySamplesPlayed
            anchorInitialized = true
            clearBuffers()
            setGain(0)
            prebuffered = false
            if (window.electronAPI?.librespotSeek) {
              window.electronAPI.librespotSeek(savedPos).catch(() => {})
            }
          }
        } else if (event.positionMs != null) {
          // Set position anchor for sample-based tracking.
          // Only sync anchor on initial play (positionAnchorSamples === 0) or
          // when the event position differs significantly from the sample-based
          // position (>2s drift = genuine desync from remote control/seek).
          // Small differences are just buffer latency between librespot and
          // the audio output — syncing them would cause the progress bar to
          // jump ahead of what the user actually hears.
          if (positionAnchorSamples === 0) {
            positionAnchorMs = event.positionMs
            positionAnchorSamples = spotifySamplesPlayed
            anchorInitialized = true
          } else {
            const currentSamplePos = positionAnchorMs + ((spotifySamplesPlayed - positionAnchorSamples) / 44100) * 1000
            const drift = Math.abs(event.positionMs - currentSamplePos)
            if (drift > 2000) {
              positionAnchorMs = event.positionMs
              positionAnchorSamples = spotifySamplesPlayed
              anchorInitialized = true
            }
          }
        }

      }

      // If we already have freshly-buffered data (after a seek or initial load),
      // unmute immediately. Stale data from before a pause was already flushed.
      if (prebuffered && (pendingChunks.length - chunkReadIndex) >= PREBUFFER_CHUNKS) {
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

      if (!isSpotifyActive) window.startSpotifyAudio()
    } else if (state === 'paused') {
      if (window.PlaybackState) {
        // Ignore stale 'paused' events if the user recently clicked play —
        // clearBuffers/setGain would kill audio that should be playing.
        const sinceUserAction = Date.now() - (window.PlaybackState.lastUserActionTime || 0)
        if (sinceUserAction < 1500 && window.PlaybackState.isPlaying) {
          return
        }

        // Save the current in-app position so a remote resume can seek to it.
        // The in-app position is based on samples actually played, which is
        // more accurate than the event positionMs (which includes buffer delay).
        const currentPos = window.getSpotifyPosition()
        if (currentPos != null && window.spPausePosKey) {
          try { localStorage.setItem(window.spPausePosKey, JSON.stringify({ pos: Math.floor(currentPos), ts: Date.now() })); } catch (_) {}
        }

        clearBuffers()
        setGain(0)
        prebuffered = false

        window.PlaybackState.setPlaying(false)
        window.PlaybackState.setProgress(null, null)
      }
    } else if (state === 'end_of_track') {
      const wasPlaying = window.PlaybackState?.isPlaying || false
      if (window.PlaybackState) {
        window.PlaybackState.setPlaying(false)
        window.PlaybackState.setProgress(0, null)
      }
      clearBuffers()
      setGain(0)
      if (wasPlaying) {
        // Only auto-advance if we have an in-app queue. For remote playback
        // (track not in queue), let Spotify manage its own queue advancement.
        // Calling librespotNext() for remote tracks causes double-skipping
        // because Spotify may have already advanced to the next track.
        const queue = window.spotifyQueue
        const idx = window.spotifyCurrentIndex
        if (window.PlaybackState && queue && Array.isArray(queue) && idx != null && idx + 1 < queue.length && queue[idx + 1]?.uri) {
          window.PlaybackState.advance(1)
        }
      }
    } else if (state === 'stopped') {
      if (window.PlaybackState) {
        window.PlaybackState.setPlaying(false)
        window.PlaybackState.isDeviceActive = false
      }
      clearBuffers()
      setGain(0)
      prebuffered = false
    } else if (state === 'volume' || event.volume != null) {
      window.setSpotifyVolume(event.volume ?? 1.0)
    }

    if (event.title && event.artist && window.isSpotifyPlayback) {
      if (window.PlaybackState && event.uri !== window.PlaybackState.lastTrackUri) {
        const queueIdx = window.spotifyQueue?.findIndex(t => t.uri === event.uri)
        const cover = (queueIdx != null && queueIdx !== -1 && window.spotifyQueue[queueIdx]?.albumImage) || window.nowPlayingCover
        window.PlaybackState.setTrackInfo(event.title + ' — ' + event.artist, cover)
        window.PlaybackState.lastTrackUri = event.uri
        window.PlaybackState.coverLoadedFromApi = false
        window.spPausePosKey = 'tvm-pause-' + event.uri
        // Reset position for the new track
        window.PlaybackState.setProgress(0, null)
        positionAnchorMs = 0
        positionAnchorSamples = spotifySamplesPlayed
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
    const eventsStale = eventAge > 5000

    if (eventsStale && !pollStaleLogged) {
      console.warn('[librespot-renderer] No librespot events for', eventAge, 'ms — trusting poll data')
      pollStaleLogged = true
    } else if (!eventsStale) {
      pollStaleLogged = false
    }

    // Auto-reconnect if no librespot events for 30s and we're in Spotify mode
    // with an active device. This handles the case where the Connect session
    // silently drops (network timeout, Spotify deregistration, etc.)
    if (eventAge > 20000 && window.PlaybackState?.isDeviceActive) {
      const now = Date.now()
      if (now - lastReconnectAttempt > RECONNECT_COOLDOWN_MS) {
        lastReconnectAttempt = now
        console.warn('[librespot-renderer] No events for 30s — attempting reconnection')
        if (window.electronAPI?.reconnectLibrespot) {
          window.electronAPI.reconnectLibrespot()
        }
      }
    }

    if (window.PlaybackState) {
      const wasPlaying = window.PlaybackState.isPlaying
      const pollPlaying = !!data.is_playing

      // Only override play state and position if events are stale (no librespot
      // events for >10s) AND the user hasn't clicked play/pause recently.
      // A poll request in-flight during a pause can return stale is_playing=true,
      // which would reactivate the ticker and make the bar skip ahead.
      const sinceUserAction = Date.now() - (window.PlaybackState.lastUserActionTime || 0)
      const userActionCooldown = sinceUserAction < 1500

      if (eventsStale && !userActionCooldown) {
        // Never let poll override a deliberate pause (false→true).
        // Resuming should only come from a 'playing' event or user action.
        if (wasPlaying || !pollPlaying) {
          window.PlaybackState.setPlaying(pollPlaying)
        }
        // Only update position from poll when actually playing — when paused,
        // freeze the position at where the user left it.
        // Only re-sync anchor if drift is significant (>2s). Small differences
        // are just buffer latency and would cause the progress bar to jump.
        if (window.PlaybackState.isPlaying && data.progress_ms != null) {
          const currentSamplePos = positionAnchorMs + ((spotifySamplesPlayed - positionAnchorSamples) / 44100) * 1000
          const drift = Math.abs(data.progress_ms - currentSamplePos)
          if (drift > 2000 && window.resetSpotifyPositionAnchor) {
            window.resetSpotifyPositionAnchor(data.progress_ms)
          }
        }
      }

      // Sync duration and track info when the track changed
      if (data.item) {
        if (data.item.duration_ms != null) {
          window.PlaybackState.durationMs = data.item.duration_ms
        }
        // Only update track info when the track actually changed — avoids
        // reloading the album cover image every 5s from repeated polls.
        // Also allow one upgrade from API album art if the playing event
        // didn't have album art (coverLoadedFromApi is false).
        if (data.item.uri !== window.PlaybackState.lastTrackUri || !window.PlaybackState.coverLoadedFromApi) {
          const isNewTrack = data.item.uri !== window.PlaybackState.lastTrackUri
          const trackName = data.item.name || 'Unknown'
          const trackArtists = (data.item.artists || []).map(a => a.name).join(', ')
          const queueIdx = window.spotifyQueue?.findIndex(t => t.uri === data.item.uri)
          const cover = (queueIdx != null && queueIdx !== -1 && window.spotifyQueue[queueIdx]?.albumImage)
            || data.item.album?.images?.[0]?.url
            || window.nowPlayingCover
          window.PlaybackState.setTrackInfo(trackName + ' — ' + trackArtists, cover)
          window.PlaybackState.lastTrackUri = data.item.uri
          window.PlaybackState.coverLoadedFromApi = true
          window.spPausePosKey = 'tvm-pause-' + data.item.uri
          if (isNewTrack) {
            window.PlaybackState.setProgress(0, null)
            positionAnchorMs = 0
            positionAnchorSamples = spotifySamplesPlayed
          }
        }

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
  window.startSpotifyAudio = async () => {
    if (isSpotifyActive) {
      connectVisualizer()
      return
    }

    const ok = initGraph()
    if (!ok && !scriptNode) return

    if (ctx && ctx.state === 'suspended') {
      isSpotifyActive = true
      try {
        await ctx.resume()
      } catch (err) {
        console.warn('[librespot-renderer] AudioContext resume failed:', err)
        isSpotifyActive = false
        return
      }
    }

    isSpotifyActive = true
    spotifySamplesPlayed = 0
    if (!anchorInitialized) {
      positionAnchorMs = 0
      positionAnchorSamples = 0
    }
    connectVisualizer()
  }

  window.stopSpotifyAudio = () => {
    if (!isSpotifyActive) return
    isSpotifyActive = false
    anchorInitialized = false
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
  function tryInit() {
    ctx = window.visualizerAudioContext
    if (!ctx || !window.electronAPI) {
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
