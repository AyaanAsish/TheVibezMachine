let currentPresetName = null
let committedPresetName = null

const SpacingEngine = {
  applySpacing(presetName) {
    const tokens = window.SPACING_PRESETS && window.SPACING_PRESETS[presetName]
    if (!tokens) return
    // Clean up all old tokens so they fall back to :root defaults
    document.documentElement.style.removeProperty('--tracklist-gap')
    document.documentElement.style.removeProperty('--card-padding')
    document.documentElement.style.removeProperty('--settings-gap')
    document.documentElement.style.removeProperty('--library-grid-gap')
    document.documentElement.style.removeProperty('--library-tracklist-gap')
    document.documentElement.style.removeProperty('--library-card-padding')
    document.documentElement.style.removeProperty('--explore-grid-gap')
    document.documentElement.style.removeProperty('--explore-tracklist-gap')
    document.documentElement.style.removeProperty('--explore-card-padding')
    for (const [token, value] of Object.entries(tokens)) {
      document.documentElement.style.setProperty(token, value)
    }
    currentPresetName = presetName
  },

  getPresetName() {
    return currentPresetName
  },

  previewSpacing(presetName) {
    this.applySpacing(presetName)
  },

  commitSpacing(presetName) {
    this.applySpacing(presetName)
    committedPresetName = presetName
    if (window.electronAPI && window.electronAPI.setSpacing) {
      window.electronAPI.setSpacing(presetName)
    }
    try {
      const tokens = window.SPACING_PRESETS[presetName]
      localStorage.setItem('tvm-spacing-cache', JSON.stringify({ presetName, tokens }))
    } catch (e) {}
  },

  restoreSpacing() {
    if (committedPresetName) {
      this.applySpacing(committedPresetName)
    }
  }
}

if (window.electronAPI && window.electronAPI.getSpacing) {
  window.electronAPI.getSpacing().then(result => {
    const presetName = result && result.presetName ? result.presetName : 'Default'
    SpacingEngine.applySpacing(presetName)
    committedPresetName = presetName
    currentPresetName = presetName
    try {
      const tokens = window.SPACING_PRESETS[presetName]
      localStorage.setItem('tvm-spacing-cache', JSON.stringify({ presetName, tokens }))
    } catch (e) {}
  }).catch(() => {
    if (!committedPresetName) {
      SpacingEngine.applySpacing('Default')
      committedPresetName = 'Default'
      currentPresetName = 'Default'
    }
  })
}

window.SpacingEngine = SpacingEngine
