const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a']

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AUDIO_EXTENSIONS }
} else if (typeof window !== 'undefined') {
  window.AUDIO_EXTENSIONS = AUDIO_EXTENSIONS
}
