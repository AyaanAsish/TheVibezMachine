const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a']

const THEMES = {
  "Vibez Classic": {
    "--blade": "#b094c7",
    "--blade-active": "#483666",
    "--accent": "#e2c044",
    "--accent-dark": "#d4b13e",
    "--card": "#2a2a2a",
    "--body": "#000000",
    "--text": "#ffffff",
    "--text-muted": "#888888",
  }
}

const SPACING_PRESETS = {
  "Compact": {
    "--grid-gap":        "12px",
    "--tracklist-gap":   "2px",
    "--settings-gap":    "8px",
    "--card-padding":    "8px",
  },
  "Default": {
    "--grid-gap":        "20px",
    "--tracklist-gap":   "6px",
    "--settings-gap":    "14px",
    "--card-padding":    "12px",
  },
  "Relaxed": {
    "--grid-gap":        "32px",
    "--tracklist-gap":   "12px",
    "--settings-gap":    "22px",
    "--card-padding":    "18px",
  },
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AUDIO_EXTENSIONS, THEMES, SPACING_PRESETS }
} else if (typeof window !== 'undefined') {
  window.AUDIO_EXTENSIONS = AUDIO_EXTENSIONS
  window.THEMES = THEMES
  window.SPACING_PRESETS = SPACING_PRESETS
}
