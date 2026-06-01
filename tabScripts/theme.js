let currentThemeName = null
let committedThemeName = null

const ThemeEngine = {
  applyTheme(themeName) {
    const tokens = window.THEMES[themeName]
    if (!tokens) return
    for (const [token, value] of Object.entries(tokens)) {
      document.documentElement.style.setProperty(token, value)
    }
    currentThemeName = themeName
  },

  getThemeName() {
    return currentThemeName
  },

  previewTheme(themeName) {
    this.applyTheme(themeName)
  },

  commitTheme(themeName) {
    this.applyTheme(themeName)
    committedThemeName = themeName
    if (window.electronAPI && window.electronAPI.setTheme) {
      window.electronAPI.setTheme(themeName)
    }
    try {
      const tokens = window.THEMES[themeName]
      localStorage.setItem('tvm-theme-cache', JSON.stringify({ themeName, tokens }))
    } catch (e) {}
  },

  restoreTheme() {
    if (committedThemeName) {
      this.applyTheme(committedThemeName)
    }
  }
}

// Initialise: load saved theme asynchronously and update cache.
if (window.electronAPI && window.electronAPI.getTheme) {
  window.electronAPI.getTheme().then(result => {
    const themeName = result && result.themeName ? result.themeName : 'Vibez Classic'
    ThemeEngine.applyTheme(themeName)
    committedThemeName = themeName
    currentThemeName = themeName
    try {
      const tokens = window.THEMES[themeName]
      localStorage.setItem('tvm-theme-cache', JSON.stringify({ themeName, tokens }))
    } catch (e) {}
  }).catch(() => {
    if (!committedThemeName) {
      ThemeEngine.applyTheme('Vibez Classic')
      committedThemeName = 'Vibez Classic'
      currentThemeName = 'Vibez Classic'
    }
  })
}

window.ThemeEngine = ThemeEngine
