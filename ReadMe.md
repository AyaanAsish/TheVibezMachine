# TheVibezMachine

A clean, no-frills music player built with Electron. Just load your music folder and play.

## What It Does

TheVibezMachine is a desktop app that plays your local music files. It organizes your music into playlists based on folders and lets you browse and play tracks with a simple interface.

## Features

- **Blade Navigation** - Slide between tabs (Library, Explore, Visualizer, Settings) by clicking the side blades or using arrow keys
- **Auto-Organize** - Folders become playlists automatically
- **Album Art** - Picks up cover.jpg, folder.jpg, album.jpg from your folders
- **Keyboard Controls** - Left/Right arrows to switch tabs
- **Clean Design** - No clutter, just your music

## Tech Stack

- Electron 41.1.1
- HTML/CSS/JavaScript
- Node.js (fs, path modules)
- Butterchurn (for visualizer)

## Installation

```bash
git clone https://github.com/AyaanAsish/TheVibezMachine.git
cd TheVibezMachine
npm install
npm start
```

That's it. App should launch.

## Usage

1. Open the app
2. Go to **Settings** (click the rightmost blade or press Right arrow twice)
3. Click **Open Files** or type in a folder path
4. Click **Apply Path**
5. Go back to **Library** - your music should be there

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Left Arrow | Previous tab |
| Right Arrow | Next tab |

## Project Structure

```
TheVibezMachine/
├── index.html      # Main HTML
├── styles.css      # All styles
├── ui.js           # Tab switching, blade animations
├── library.js      # Music library scanning
├── player.js       # Audio playback
├── main.js         # Electron main process
├── preload.js      # IPC bridge
└── assets/         # Fonts and images
```

### What Each File Does

| File | Purpose |
|------|---------|
| `main.js` | Creates the window, handles folder scanning |
| `preload.js` | Connects main process to renderer |
| `ui.js` | Handles tab switching and blade animations |
| `library.js` | Scans folders, builds playlist cards |
| `player.js` | Plays audio, manages queue |
| `styles.css` | All the styling |

## Notes

- Visualizer tab is a WIP
- Explore tab isn't implemented yet

## Issues

Found a bug? Open an issue on the [GitHub repo](https://github.com/AyaanAsish/TheVibezMachine/issues).
