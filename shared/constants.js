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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AUDIO_EXTENSIONS, THEMES }
} else if (typeof window !== 'undefined') {
  window.AUDIO_EXTENSIONS = AUDIO_EXTENSIONS
  window.THEMES = THEMES
}
