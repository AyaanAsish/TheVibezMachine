let currentPresetName = null
let committedPresetName = null
let currentBlendPercent = null

const ALL_SPACING_TOKENS = [
  '--tracklist-gap',
  '--card-padding',
  '--settings-gap',
  '--library-grid-gap',
  '--library-tracklist-gap',
  '--library-card-padding',
  '--explore-grid-gap',
  '--explore-tracklist-gap',
  '--explore-card-padding',
  '--grid-gap'
]

const SpacingEngine = {
  _clearSpacing() {
    for (const token of ALL_SPACING_TOKENS) {
      document.documentElement.style.removeProperty(token)
    }
  },

  applySpacing(presetName) {
    const tokens = window.SPACING_PRESETS && window.SPACING_PRESETS[presetName]
    if (!tokens) return
    this._clearSpacing()
    for (const [token, value] of Object.entries(tokens)) {
      document.documentElement.style.setProperty(token, value)
    }
    currentPresetName = presetName
    currentBlendPercent = null
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
    currentBlendPercent = null
    if (window.electronAPI && window.electronAPI.setSpacing) {
      window.electronAPI.setSpacing(presetName)
    }
    try {
      const tokens = window.SPACING_PRESETS[presetName]
      localStorage.setItem('tvm-spacing-cache', JSON.stringify({ presetName, tokens }))
    } catch (e) {}
  },

  restoreSpacing() {
    if (typeof currentBlendPercent === 'number') {
      this.applyBlend(currentBlendPercent)
    } else if (committedPresetName) {
      this.applySpacing(committedPresetName)
    }
  },

  applyBlend(percent) {
    const presets = window.SPACING_PRESETS
    if (!presets) return
    const names = ['Compact', 'Default', 'Relaxed']
    const idx = (percent / 100) * (names.length - 1)
    const lowerIdx = Math.max(0, Math.min(names.length - 1, Math.floor(idx)))
    const upperIdx = Math.max(0, Math.min(names.length - 1, Math.ceil(idx)))
    const t = upperIdx === lowerIdx ? 0 : (idx - lowerIdx) / (upperIdx - lowerIdx)

    const lower = presets[names[lowerIdx]]
    const upper = presets[names[upperIdx]]
    if (!lower) return

    this._clearSpacing()

    const allKeys = new Set([...Object.keys(lower), ...(upper ? Object.keys(upper) : [])])
    for (const token of allKeys) {
      const lowerVal = lower[token]
      const upperVal = upper ? upper[token] : lowerVal
      if (lowerVal === undefined) {
        if (upperVal !== undefined) document.documentElement.style.setProperty(token, upperVal)
        continue
      }
      if (upperVal === undefined || lowerVal === upperVal) {
        document.documentElement.style.setProperty(token, lowerVal)
        continue
      }

      const lowerNum = parseFloat(lowerVal)
      const upperNum = parseFloat(upperVal)
      if (!isNaN(lowerNum) && !isNaN(upperNum)) {
        const unit = lowerVal.replace(/[0-9.\-]/g, '') || upperVal.replace(/[0-9.\-]/g, '')
        const interpolated = lowerNum + (upperNum - lowerNum) * t
        document.documentElement.style.setProperty(token, Math.round(interpolated) + unit)
      } else {
        document.documentElement.style.setProperty(token, t < 0.5 ? lowerVal : upperVal)
      }
    }

    currentBlendPercent = percent
    currentPresetName = names[Math.round(idx)] || names[0]
  },

  getBlendPercent() {
    return currentBlendPercent
  },

  previewBlend(percent) {
    this.applyBlend(percent)
  },

  commitBlend(percent) {
    this.applyBlend(percent)
    committedPresetName = currentPresetName
    if (window.electronAPI && window.electronAPI.setSpacing) {
      window.electronAPI.setSpacing({ percent })
    }
    try {
      const tokens = {}
      for (const token of ALL_SPACING_TOKENS) {
        const val = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
        if (val) tokens[token] = val
      }
      localStorage.setItem('tvm-spacing-cache', JSON.stringify({ percent, tokens }))
    } catch (e) {}
  }
}

if (window.electronAPI && window.electronAPI.getSpacing) {
  window.electronAPI.getSpacing().then(result => {
    if (result && typeof result.percent === 'number') {
      SpacingEngine.applyBlend(result.percent)
      committedPresetName = SpacingEngine.getPresetName()
      currentPresetName = committedPresetName
    } else {
      const presetName = result && result.presetName ? result.presetName : 'Default'
      SpacingEngine.applySpacing(presetName)
      committedPresetName = presetName
      currentPresetName = presetName
    }
    try {
      const tokens = {}
      for (const token of ALL_SPACING_TOKENS) {
        const val = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
        if (val) tokens[token] = val
      }
      const cache = currentBlendPercent !== null
        ? { percent: currentBlendPercent, tokens }
        : { presetName: committedPresetName, tokens }
      localStorage.setItem('tvm-spacing-cache', JSON.stringify(cache))
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
