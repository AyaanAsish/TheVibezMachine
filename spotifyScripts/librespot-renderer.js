(function () {
  'use strict'

  // -- State --
  let ctx = null
  let vis = null
  const MAX_PENDING_CHUNKS = 128
  let pendingChunks = [] // Array of Float32Arrays (interleaved stereo)
  let chunkReadIndex = 0  // Read position into pendingChunks (avoids O(n) shift)
  let currentChunk = null
  let readIndex = 0
  let isSpotifyActive = false
  let spotifySamplesPlayed = 0   // Monotonically increasing count of audio frames output
  let positionAnchorMs = 0       // Position (ms) from the last anchor event
  let positionAnchorSamples = 0  // spotifySamplesPlayed value at the time of that event
  let anchorSet = false          // True once a playing event has set the anchor
  let cachedConversionBuffer = null // Reusable Float32Array for Int16→Float32
  let ignorePcmUntil = 0        // Ignore PCM arriving shortly after a flush/seek

  // -- Audio graph nodes --
  let scriptNode = null
  let gainNode = null

  const BUFFER_SIZE = 4096 // ~371ms @ 44.1kHz — larger than librespot chunk variance
  const PREBUFFER_CHUNKS = 2  // wait for ~2 chunks before unmuting (~50ms)
  let prebufferThreshold = PREBUFFER_CHUNKS  // can be raised during resume to absorb wrong-position PCM
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
    if (!gainNode || prebuffered) return
    const chunksAvailable = pendingChunks.length - chunkReadIndex
    if (chunksAvailable < prebufferThreshold) return

    prebuffered = true
    setGain(1)
    prebufferThreshold = PREBUFFER_CHUNKS
    if (window.startSpotifyPositionTicker) window.startSpotifyPositionTicker()
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

  function clearBuffers(shouldResetThreshold = true) {
    pendingChunks.length = 0
    chunkReadIndex = 0
    currentChunk = null
    readIndex = 0
    prebuffered = false
    if (shouldResetThreshold) {
      prebufferThreshold = PREBUFFER_CHUNKS
    }
    // Ignore PCM for 250ms after a flush. IPC batches drain every 25ms,
    // and with network/main-process latency, stale PCM can trail by 100-200ms.
    ignorePcmUntil = Date.now() + 250
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

    // Drop PCM that arrives within the post-flush ignore window. This prevents
    // stale in-flight chunks from before a seek/flush from contaminating the
    // buffer after the flush has completed.
    if (Date.now() < ignorePcmUntil) return

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
    // Backpressure: if the buffer is full, drop the oldest unread chunk and
    // keep the newest. Dropping the newest would starve the reader when it
    // catches up to the end of the buffer, causing silence. Dropping the oldest
    // creates a small skip forward but keeps audio flowing.
    if (pendingChunks.length - chunkReadIndex >= MAX_PENDING_CHUNKS) {
      chunkReadIndex++
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
    const state = event.state || event.type
    const gapSinceLastEvent = Date.now() - lastEventTime
    lastEventTime = Date.now()

    if (state === 'ready') {
      // Device is fully initialized and ready to accept playback commands
      if (window.PlaybackState) {
        window.PlaybackState.isDeviceActive = true
      }
      // Device is ready to accept playback commands
      return
    }

    if (state === 'playing') {
      // If we were expecting the next track after end_of_track, check whether
      // Spotify actually auto-advanced or just restarted the same track.
      if (window.spotifyExpectingNextTrack && event.uri) {
        if (event.uri === window.spotifyExpectingNextTrack) {
          // Device restarted the same track instead of advancing — force next
          window.spotifyExpectingNextTrack = null
          if (window.PlaybackState) window.PlaybackState.advance(1)
          return
        } else {
          // Different track — Spotify auto-advanced correctly
          window.spotifyExpectingNextTrack = null
        }
      }

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
        if (event.durationMs != null) {
          window.PlaybackState.durationMs = event.durationMs
          // Persist duration so the resume handler can detect track-finished
          // even when the playing event didn't include it.
          if (event.uri) {
            try { localStorage.setItem('tvm-track-duration-' + event.uri, String(event.durationMs)) } catch (_) {}
          }
        }

        // Sync position anchor from the event. When a resume expectation is
        // pending, only accept the event if its position matches the expected
        // resume position (within 2s). This blocks wrong-position audio from
        // playing when the device ignores position_ms and starts from 0.
        // When no expectation is pending, only update anchor on the first event
        // after a flush (positionAnchorSamples === 0) or when drift > 2s.
        // This prevents delayed events from previous playthroughs from corrupting
        // the position after a restart.
        if (event.positionMs != null) {
          const isExpectedTrack = !event.uri || event.uri === window.expectedResumeUri
          if (window.expectedResumePos != null && isExpectedTrack) {
            const drift = Math.abs(event.positionMs - window.expectedResumePos)
            if (drift <= 2000) {
              // Valid resume position — set anchor and unmute. Do NOT clear
              // buffers; the prebuffered PCM is already at the correct position
              // and clearing it would create an audible gap.
              window.expectedResumePos = null
              window.expectedResumeUri = null
              positionAnchorMs = event.positionMs
              positionAnchorSamples = spotifySamplesPlayed
              anchorSet = true
              tryUnmute()
            } else {
              // Device started from the wrong position. Discard the buffered
              // wrong-position PCM, issue a corrective seek, and stay muted
              // until the next playing event confirms the seek landed.
              clearBuffers(false)
              ignorePcmUntil = Date.now() + 250
              if (window.electronAPI?.librespotSeek) {
                window.electronAPI.librespotSeek(window.expectedResumePos).catch(() => {})
              }
            }
          } else {
            // No expectation or different track — only sync anchor on the
            // first event after flush. After that, trust the sample-based
            // ticker and only update anchor from user-initiated seeks (which
            // call flushSpotifyBuffers and reset anchorSet). This prevents
            // delayed events from previous playthroughs from corrupting the
            // position after a restart.
            window.expectedResumePos = null
            window.expectedResumeUri = null
            if (!anchorSet) {
              positionAnchorMs = event.positionMs
              positionAnchorSamples = spotifySamplesPlayed
              anchorSet = true
              tryUnmute()
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
        const sinceUserAction = Date.now() - (window.PlaybackState.lastUserActionTime || 0)
        // Ignore stale 'paused' events that arrive shortly after a resume click
        // while audio is still playing. A genuine pause click sets isPlaying=false
        // first, so this guard only blocks stale events during active playback.
        const samplesSinceResume = spotifySamplesPlayed
        if (window.PlaybackState.isPlaying && sinceUserAction < 15000 && samplesSinceResume < 100000) {
          return
        }

        // Save the current track + position + duration into a unified pause state
        // key. On resume we replay this exact track from this exact position.
        // Duration is needed to detect if the track finished while we were paused.
        const currentPos = window.getSpotifyPosition()
        const currentUri = window.PlaybackState.lastTrackUri || window.spPausePosKey?.replace('tvm-pause-', '')
        const currentDuration = window.PlaybackState.durationMs || 0
        if (currentPos != null && currentUri) {
          try {
            localStorage.setItem('tvm-pause-state', JSON.stringify({
              uri: currentUri,
              pos: Math.floor(currentPos),
              durationMs: currentDuration,
              ts: Date.now()
            }))
          } catch (_) {}
        }

        clearBuffers()
        setGain(0)
        prebuffered = false
        // Drop trailing PCM that may still be in-flight from before the pause.
        ignorePcmUntil = Date.now() + 200

        window.PlaybackState.setPlaying(false)
        window.PlaybackState.setProgress(null, null)
      }
    } else if (state === 'end_of_track') {
      const wasPlaying = window.PlaybackState?.isPlaying || false
      // After a resume, flushSpotifyBuffers resets spotifySamplesPlayed to 0.
      // If end_of_track arrives shortly after a resume, it's a stale/delayed
      // event from the track's previous playthrough (which finished while we
      // were paused). Completely ignore it — don't pause, don't reset progress,
      // don't clear buffers. Otherwise the UI would snap to 0 and audio would
      // cut out within seconds of resuming a near-end track.
      const samplesSinceResume = spotifySamplesPlayed
      const positionMs = window.PlaybackState?.positionMs ?? 0
      const durationMs = window.PlaybackState?.durationMs ?? 0
      const nearEnd = durationMs > 0 && (durationMs - positionMs) < 10000
      const prematureEndOfTrack = samplesSinceResume < 300000 && !nearEnd
      if (prematureEndOfTrack) {
        return
      }

      // Clear pause state so a subsequent play click doesn't resume from an
      // old position on a track that has already finished.
      const finishedUri = window.PlaybackState?.lastTrackUri || event.uri
      try {
        localStorage.removeItem('tvm-pause-state')
        if (finishedUri) localStorage.removeItem('tvm-pause-' + finishedUri)
      } catch (_) {}

      // If the track genuinely finished, expect Spotify to auto-advance.
      // If it doesn't (device bug), manually advance after a short delay.
      window.spotifyExpectingNextTrack = finishedUri
      setTimeout(() => {
        if (window.spotifyExpectingNextTrack === finishedUri) {
          window.spotifyExpectingNextTrack = null
          if (window.PlaybackState && window.PlaybackState.mode === 'spotify') {
            const currentUri = window.PlaybackState.lastTrackUri
            if (!currentUri || currentUri === finishedUri) {
              window.PlaybackState.advance(1)
            }
          }
        }
      }, 2500)

      // Proactive reconnection: the native addon degrades over multiple tracks.
      // The gap between tracks is the safest moment to restart it, because no
      // audio is flowing and Spotify hasn't started the next track yet.
      // Use the gap computed at the top of onSpotifyEvent (before lastEventTime
      // was updated) so we know how stale events were during the track.
      if (gapSinceLastEvent > 8000) {
        const now = Date.now()
        if (now - lastReconnectAttempt > RECONNECT_COOLDOWN_MS) {
          lastReconnectAttempt = now
          console.warn('[librespot-renderer] Events stale during track end — proactive reconnection')
          if (window.electronAPI?.reconnectLibrespot) {
            window.electronAPI.reconnectLibrespot()
          }
        }
      }

      if (window.PlaybackState) {
        window.PlaybackState.setPlaying(false)
        window.PlaybackState.setProgress(0, null)
      }
      clearBuffers()
      setGain(0)
      prebuffered = false
      // Drop trailing PCM that may still be in-flight from before the track ended.
      ignorePcmUntil = Date.now() + 200
      window.expectedResumePos = null
      window.expectedResumeUri = null
    } else if (state === 'stopped') {
      const sinceUserAction = window.PlaybackState
        ? Date.now() - (window.PlaybackState.lastUserActionTime || 0)
        : Infinity
      if (sinceUserAction < 15000 && window.PlaybackState?.isPlaying) {
        return
      }
      if (window.PlaybackState) {
        window.PlaybackState.setPlaying(false)
        window.PlaybackState.isDeviceActive = false
      }
      clearBuffers()
      setGain(0)
      prebuffered = false
      // Drop trailing PCM that may still be in-flight from before the stop.
      ignorePcmUntil = Date.now() + 200
      window.expectedResumePos = null
      window.expectedResumeUri = null
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
        anchorSet = true
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

    // Auto-reconnect if no librespot events for 20s, BUT only when we're
    // not actively playing. Reconnecting during playback shuts down the native
    // host and causes audible drops / NO_ACTIVE_DEVICE cascades. Instead we
    // reconnect opportunistically between tracks (end_of_track) or when idle.
    if (eventAge > 20000 && window.PlaybackState?.isDeviceActive && !window.PlaybackState?.isPlaying) {
      const now = Date.now()
      if (now - lastReconnectAttempt > RECONNECT_COOLDOWN_MS) {
        lastReconnectAttempt = now
        console.warn('[librespot-renderer] No events for 20s while idle — attempting reconnection')
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
          if (data.item.uri) {
            try { localStorage.setItem('tvm-track-duration-' + data.item.uri, String(data.item.duration_ms)) } catch (_) {}
          }
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
            anchorSet = true
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
    // Always reset the anchor when starting audio fresh. Stale anchor values
    // from a previous track/session would corrupt position tracking for the
    // new playback stream.
    positionAnchorMs = 0
    positionAnchorSamples = 0
    anchorSet = false
    connectVisualizer()
  }

  window.stopSpotifyAudio = () => {
    if (!isSpotifyActive) return
    isSpotifyActive = false
    clearBuffers()
    destroyGraph()
  }

  window.flushSpotifyBuffers = (targetPositionMs = null, threshold = null) => {
    // Pass false so the caller's prebuffer threshold (e.g. 8 during resume)
    // is preserved rather than being reset to the default of 2.
    clearBuffers(false)
    setGain(0)
    // Reset sample counter and anchor so position tracking starts fresh
    // after a seek/resume. Stale anchor values corrupt the progress bar
    // and the resume expectation guard calculations.
    spotifySamplesPlayed = 0
    // If a target position is provided (e.g. resume), use it immediately so
    // the 50ms ticker can't read a temporary 0 and snap the UI to start.
    positionAnchorMs = targetPositionMs != null ? targetPositionMs : 0
    positionAnchorSamples = 0
    anchorSet = false
    // Set threshold atomically with the flush so a PCM chunk that arrives
    // between flush and threshold-set uses the correct value.
    if (threshold != null) prebufferThreshold = threshold
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
    anchorSet = true
  }

  window.trySpotifyUnmute = tryUnmute

  window.setPrebufferThreshold = (n) => {
    prebufferThreshold = n
  }

  window.resetPrebufferThreshold = () => {
    prebufferThreshold = PREBUFFER_CHUNKS
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
