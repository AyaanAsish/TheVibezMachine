# TheVibezMachine

An Electron-based music player with local file playback and Spotify Connect integration via librespot. Features a fullscreen visualizer, local library management, and seamless Spotify playback without the Web Playback SDK.

## Setup

1. Install dependencies (includes vendored `@lox-audioserver/node-librespot`):

```bash
npm install
```

2. Run the app:

```bash
npm start
```

The app serves itself from `localhost:3000` (fallbacks to 3001, 3002, then random). No build step required.

## Features

- **Local playback** — Scan folders for audio files (MP3, WAV, FLAC, OGG, M4A), browse playlists, and play via HTML5 Audio.
- **Spotify Connect** — Uses `@lox-audioserver/node-librespot` (native addon) for PCM streaming. No Web Playback SDK.
- **Visualizer** — Butterchurn-powered milkdrop visualizer with preset picker.
- **Explore tab** — Search Spotify, browse saved albums/playlists, and play tracks with in-app queue support.
- **Unified playback state** — Single `PlaybackState` object manages local/Spotify mode switching, progress, and controls.

## Spotify Auth

1. Go to **Settings** tab.
2. Enter your Spotify **Client ID** and **Client Secret**.
3. Click **Connect Spotify**.
4. Authorize in the browser window that opens.

Tokens are persisted to `~/Library/Application Support/TheVibezMachine/.spotify-auth.json` (macOS) or the equivalent Electron `userData` path.

## Architecture

- **Main process** (`main.js`) — HTTP static server, IPC handlers, librespot native addon management.
- **Preload** (`playerScripts/preload.js`) — `contextBridge` exposing `electronAPI` to renderer.
- **Renderer** — Tab-based UI (Library, Explore, Visualizer, Settings) with unified player controls.

### Key Files

| File | Purpose |
|------|---------|
| `main.js` | Electron main process, static server, IPC registration |
| `playerScripts/player.js` | Unified `PlaybackState`, play/pause/seek, local audio |
| `spotifyScripts/librespot-main.js` | Native addon init, PCM batching, Spotify API proxy |
| `spotifyScripts/librespot-renderer.js` | PCM audio graph (ScriptProcessorNode), position tracking, event handling |
| `spotifyScripts/spotifyAuth.js` | OAuth flow, token refresh, token persistence |
| `tabScripts/explore.js` | Spotify search, saved albums/playlists, tracklist rendering |
| `DB/db.js` | SQLite library path persistence via `better-sqlite3` |

## Data Flow

**Local:** Settings → folder path → `scan-folder` IPC → playlist cards → `loadPlayerTrack()` → HTML5 Audio

**Spotify:** Explore click → `spotifyPlayTrack()` → librespot device → PCM chunks → renderer audio graph → `PlaybackState` updates

## Important Notes

- **No Spotify Web Playback SDK** — replaced by librespot Connect device.
- **Client Secret never exposed to renderer** — all Spotify API calls are proxied through the main process.
- **Desktop audio capture blocked on macOS** without Screen Recording permission. Visualizer connects directly to the librespot GainNode instead.
- **Saved playlists** only work for playlists you own or are a collaborator on (Spotify policy change, Feb 2026).
- **No tests configured**.

## Recent Fixes

### Resume-after-pause
The librespot Connect device silently fails to resume from non-zero `position_ms` after a near-end pause. Fixed by always sending `play(track, 0)` first, then `seek(savedPos)` immediately after.

### Track-end auto-advance
When a track finished, the device would get stuck at position 0 on the same track. Fixed by passing the full in-app queue to Spotify so it can auto-advance, plus a fallback `advance(1)` if Spotify doesn't advance within 2.5s.

### Proactive reconnection
The native addon degrades over multiple tracks. Auto-reconnect now only fires when idle (not during playback), plus an additional proactive reconnect is triggered at `end_of_track` if events were already stale during the track.

### Skip buttons for remote playback
Next/prev buttons now fall back to Spotify API `next`/`previous` endpoints when no in-app queue exists, so they work for both in-app and remote (phone app) playback.

## Debugging

Open Chrome DevTools with `Cmd+Option+I` (macOS) or connect to `localhost:9222/json` when running.

Renderer console messages are forwarded to the main process logs when testing headlessly.
