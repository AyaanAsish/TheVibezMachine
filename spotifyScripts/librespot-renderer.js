(function () {
  'use strict'

  // -- State --
  let ctx = null
  let vis = null
  let pendingChunks = [] // Array of Float32Arrays (interleaved stereo)
  let currentChunk = null
  let readIndex = 0
  let isSpotifyActive = false
  let graphInitialized = false

  // -- Audio graph nodes --
  let scriptNode = null
  let gainNode = null

  const BUFFER_SIZE = 16384 // ~371ms @ 44.1kHz — larger than librespot chunk variance
  const PREBUFFER_CHUNKS = 4  // wait for ~4 chunks before unmuting
  let prebuffered = false

  function initGraph() {
    ctx = window.visualizerAudioContext
    vis = window.myVisualizer

    if (!ctx) {
      console.warn('[librespot-renderer] initGraph: AudioContext not ready')
      return false
    }
    if (scriptNode) {
      console.log('[librespot-renderer] initGraph: graph already exists')
      return true
    }

    try {
      gainNode = ctx.createGain()
      gainNode.gain.value = 0.0 // start muted until prebuffer fills

      scriptNode = ctx.createScriptProcessor(BUFFER_SIZE, 0, 2)
      scriptNode.onaudioprocess = (e) => {
        const outL = e.outputBuffer.getChannelData(0)
        const outR = e.outputBuffer.getChannelData(1)
        for (let i = 0; i < outL.length; i++) {
          if (!currentChunk || readIndex >= currentChunk.length) {
            currentChunk = pendingChunks.shift() || null
            readIndex = 0
          }
          if (currentChunk) {
            outL[i] = currentChunk[readIndex]
            outR[i] = currentChunk[readIndex + 1]
            readIndex += 2
          } else {
            outL[i] = 0
            outR[i] = 0
          }
        }

        // Unmute once prebuffer is full
        if (!prebuffered && pendingChunks.length >= PREBUFFER_CHUNKS && gainNode) {
          prebuffered = true
          gainNode.gain.value = 1.0
          console.log('[librespot-renderer] Prebuffer full — unmuting audio')
        }
      }

      scriptNode.connect(gainNode)
      gainNode.connect(ctx.destination)

      console.log('[librespot-renderer] Audio graph initialized (ctx.state=' + ctx.state + ', buffer=' + BUFFER_SIZE + ')')
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
  }

  // -- PCM ingestion --
  let pcmCount = 0
  let lastPcmLog = 0
  function onSpotifyPcm(buffer) {
    pcmCount++
    const now = performance.now()
    if (now - lastPcmLog > 5000) {
      console.log('[librespot-renderer] onSpotifyPcm: chunk #' + pcmCount,
        'active=' + isSpotifyActive,
        'queue=' + pendingChunks.length,
        'prebuffered=' + prebuffered)
      lastPcmLog = now
    }

    if (!window.isSpotifyPlayback) {
      window.isSpotifyPlayback = true
      if (window.pauseLocalAudio) window.pauseLocalAudio()
      if (window.disconnectLocalAudio) window.disconnectLocalAudio()
      window.spotifyPositionMs = 0
      if (window.startSpotifyPositionTicker) window.startSpotifyPositionTicker()
    }
    window.startSpotifyAudio()
    if (!buffer) return

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

    if (!prebuffered && pendingChunks.length >= PREBUFFER_CHUNKS && gainNode) {
      prebuffered = true
      gainNode.gain.value = 1.0
      console.log('[librespot-renderer] Prebuffer full — unmuting audio')
    }
  }

  // -- Events --
  function onSpotifyEvent(event) {
    if (!event) return
    const state = event.state || event.type
    console.log('[librespot-renderer] Event:', state, event)

    if (state === 'playing') {
      window.spotifyIsPlaying = true
      if (!window.isSpotifyPlayback) {
        window.isSpotifyPlayback = true
        if (window.pauseLocalAudio) window.pauseLocalAudio()
        if (window.disconnectLocalAudio) window.disconnectLocalAudio()
        window.spotifyPositionMs = 0
        if (window.startSpotifyPositionTicker) window.startSpotifyPositionTicker()
      }

      // Keep in-app queue index in sync when track changes via any path
      // (remote, native next/prev, auto-advance, in-app click)
      if (event.uri && window.spotifyQueue && Array.isArray(window.spotifyQueue)) {
        const idx = window.spotifyQueue.findIndex(t => t.uri === event.uri)
        if (idx !== -1) {
          window.spotifyCurrentIndex = idx
          if (window.updateSpotifyTracklistHighlight) {
            window.updateSpotifyTracklistHighlight()
          }
        }
      }

      const btn = document.getElementById('btn-play')
      if (btn) btn.textContent = '⏸'
      window.startSpotifyAudio()
    } else if (state === 'paused') {
      window.spotifyIsPlaying = false
      const btn = document.getElementById('btn-play')
      if (btn) btn.textContent = '▶'
    } else if (state === 'end_of_track' || state === 'stopped') {
      window.spotifyIsPlaying = false
      const btn = document.getElementById('btn-play')
      if (btn) btn.textContent = '▶'
      pendingChunks.length = 0
      currentChunk = null
      readIndex = 0
      prebuffered = false
      if (gainNode) gainNode.gain.value = 0.0

      if (window.spotifyQueue && Array.isArray(window.spotifyQueue) && window.spotifyCurrentIndex != null) {
        const nextIdx = window.spotifyCurrentIndex + 1
        if (nextIdx < window.spotifyQueue.length) {
          const next = window.spotifyQueue[nextIdx]
          if (next && next.uri) {
            window.spotifyCurrentIndex = nextIdx
            window.spotifyPlayTrack(next.uri)
            if (window.updateSpotifyTracklistHighlight) {
              window.updateSpotifyTracklistHighlight()
            }
            return
          }
        }
      }
    } else if (state === 'volume' || event.volume != null) {
      let v = event.volume ?? 1.0
      if (typeof v === 'number' && v > 10) v = v / 65535
      if (gainNode) gainNode.gain.value = Math.max(0, Math.min(2, v))
    }

    if (event.title && event.artist && window.isSpotifyPlayback) {
      const trackNameEl = document.getElementById('track-name')
      if (trackNameEl) {
        trackNameEl.textContent = event.title + ' — ' + event.artist
        if (trackNameEl.scrollWidth > trackNameEl.clientWidth) {
          trackNameEl.classList.add('scroll-animation')
        } else {
          trackNameEl.classList.remove('scroll-animation')
        }
      }
    }

    if (event.durationMs) {
      window.spotifyDurationMs = event.durationMs
    }

    if (event.positionMs != null) {
      window.spotifyPositionMs = event.positionMs
    }
  }

  function fmt(s) {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60).toString().padStart(2, '0')
    return `${m}:${sec}`
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
    connectVisualizer()
  }

  window.stopSpotifyAudio = () => {
    if (!isSpotifyActive) return
    isSpotifyActive = false
    pendingChunks.length = 0
    currentChunk = null
    readIndex = 0
    prebuffered = false
    destroyGraph()
    console.log('[librespot-renderer] Spotify audio stopped')
  }

  window.flushSpotifyBuffers = () => {
    pendingChunks.length = 0
    currentChunk = null
    readIndex = 0
    prebuffered = false
    if (gainNode) gainNode.gain.value = 0.0
  }

  window.setSpotifyVolume = (volume) => {
    if (gainNode) {
      let v = volume
      if (typeof v === 'number' && v > 10) v = v / 65535
      gainNode.gain.value = Math.max(0, Math.min(2, v))
    }
  }

  // -- Deferred init: wait for AudioContext --
  let initAttempts = 0
  function tryInit() {
    ctx = window.visualizerAudioContext
    if (!ctx || !window.electronAPI) {
      initAttempts++
      if (initAttempts <= 5 || initAttempts % 10 === 0) {
        console.log('[librespot-renderer] Waiting for AudioContext / electronAPI... (attempt', initAttempts, ')')
      }
      setTimeout(tryInit, 200)
      return
    }

    console.log('[librespot-renderer] AudioContext ready, registering IPC listeners')
    window.electronAPI.onSpotifyPcm(onSpotifyPcm)
    window.electronAPI.onSpotifyEvent(onSpotifyEvent)
    console.log('[librespot-renderer] IPC listeners registered')
  }

  if (document.readyState === 'complete') {
    tryInit()
  } else {
    window.addEventListener('load', tryInit)
  }
})()
