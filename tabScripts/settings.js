function renderThemeStrip(themeName) {
  const strip = document.getElementById('theme-strip')
  if (!strip) return
  const name = themeName || (window.ThemeEngine ? window.ThemeEngine.getThemeName() : 'Vibez Classic')
  const tokens = window.THEMES && window.THEMES[name]
  if (!tokens) return

  strip.innerHTML = ''
  for (const [token, value] of Object.entries(tokens)) {
    const swatch = document.createElement('div')
    swatch.className = 'theme-swatch'
    swatch.style.backgroundColor = value

    const label = document.createElement('span')
    label.className = 'theme-swatch-label'
    label.textContent = token.replace(/^--/, '').replace(/-/g, ' ')

    swatch.appendChild(label)
    strip.appendChild(swatch)
  }
}

function initSettings() {
  const select = document.getElementById('theme-select')
  if (!select) return

  const currentName = (window.ThemeEngine ? window.ThemeEngine.getThemeName() : null) || 'Vibez Classic'

  for (const name of Object.keys(window.THEMES || {})) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name
    if (name === currentName) option.selected = true
    select.appendChild(option)
  }

  select.addEventListener('mouseover', (e) => {
    if (e.target.tagName === 'OPTION') {
      const name = e.target.value
      if (window.ThemeEngine) window.ThemeEngine.previewTheme(name)
      renderThemeStrip(name)
    }
  })

  select.addEventListener('mouseleave', () => {
    if (window.ThemeEngine) window.ThemeEngine.restoreTheme()
    renderThemeStrip()
  })

  select.addEventListener('change', (e) => {
    const name = e.target.value
    if (window.ThemeEngine) window.ThemeEngine.commitTheme(name)
    renderThemeStrip(name)
  })

  const spacingSelect = document.getElementById('spacing-select')
  if (spacingSelect) {
    const currentSpacing = (window.SpacingEngine ? window.SpacingEngine.getPresetName() : null) || 'Default'

    for (const name of Object.keys(window.SPACING_PRESETS || {})) {
      const option = document.createElement('option')
      option.value = name
      option.textContent = name
      if (name === currentSpacing) option.selected = true
      spacingSelect.appendChild(option)
    }

    spacingSelect.addEventListener('mouseover', (e) => {
      if (e.target.tagName === 'OPTION') {
        const name = e.target.value
        if (window.SpacingEngine) window.SpacingEngine.previewSpacing(name)
      }
    })

    spacingSelect.addEventListener('mouseleave', () => {
      if (window.SpacingEngine) window.SpacingEngine.restoreSpacing()
    })

    spacingSelect.addEventListener('change', (e) => {
      const name = e.target.value
      if (window.SpacingEngine) window.SpacingEngine.commitSpacing(name)
    })
  }
}

window.renderThemeStrip = renderThemeStrip

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSettings)
} else {
  initSettings()
}
