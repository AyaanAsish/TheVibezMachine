const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a']

const THEMES = {
  "Vibez Classic": {
    "--blade": "#b094c7",
    "--blade-active": "#483666",
    "--accent": "#e2c044",
    "--accent-dark": "#d4b13e",
    "--highlight": "#483666",
    "--bg": "#483666",
    "--body": "#000000",
    "--card": "#2a2a2a",
    "--text": "#ffffff",
    "--text-muted": "#888888",
  },
  "Retro Vibez": {
    "--blade": "#7e7e7e",
    "--blade-active": "#9F2042",
    "--accent": "#9F2042",
    "--accent-dark": "#791530",
    "--highlight": "#000000",
    "--bg": "#383838",
    "--body": "#000000",
    "--card": "#2a2a2a",
    "--text": "#ffffff",
    "--text-muted": "#888888",
  },
  "Springy Vibez": {
    "--blade": "#77867F",
    "--blade-active": "#445D52",
    "--accent": "#d69ec4",
    "--accent-dark": "#a0658d",
    "--highlight": "#445D52",
    "--bg": "#77867F",
    "--body": "#445D52",
    "--card": "#2a2a2a",
    "--text": "#ffffff",
    "--text-muted": "#888888",
  }
}

const SPACING_PRESETS = {
  "Compact": {
    "--grid-gap":        "16px",
  },
  "Default": {
    "--grid-gap":        "40px",
  },
  "Relaxed": {
    "--grid-gap":        "80px",
  },
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AUDIO_EXTENSIONS, THEMES, SPACING_PRESETS }
} else if (typeof window !== 'undefined') {
  window.AUDIO_EXTENSIONS = AUDIO_EXTENSIONS
  window.THEMES = THEMES
  window.SPACING_PRESETS = SPACING_PRESETS
}
