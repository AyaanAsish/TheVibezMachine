function isHexLight(hexCode) {
  let cleanHex = hexCode.replace('#', '');

  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(char => char + char).join('');
  }

  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);

  const luminance = (r * 0.299) + (g * 0.587) + (b * 0.114);

  return luminance > 128;
}

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
    label.classList.add('theme-swatch-label')
    if (isHexLight(value)) label.classList.add('dark-text')
    else label.classList.add('light-text')
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

  // Spacing slider
  const SNAP_POINTS = ['Compact', 'Default', 'Relaxed']
  const SNAP_PCTS   = [0, 50, 100]
  const SNAP_RADIUS = 5 // percent

  const thumb = document.getElementById('spacing-thumb')
  const fill  = document.getElementById('spacing-fill')
  const track = document.getElementById('spacing-track')
  const label = document.getElementById('spacing-label')

  if (thumb && track) {
    const nearestPreset = (percent) => {
      const i = Math.round(percent / 100 * (SNAP_POINTS.length - 1))
      return SNAP_POINTS[Math.max(0, Math.min(SNAP_POINTS.length - 1, i))]
    }

    const snap = (pct) => {
      let closest = pct, minDist = Infinity
      for (const sp of SNAP_PCTS) {
        const d = Math.abs(pct - sp)
        if (d < minDist) { minDist = d; closest = sp }
      }
      return minDist <= SNAP_RADIUS ? closest : pct
    }

    const setSliderTo = (percent, preview = false) => {
      thumb.style.left = percent + '%'
      fill.style.width = percent + '%'
      if (label) label.textContent = nearestPreset(percent)
      if (preview && window.SpacingEngine) window.SpacingEngine.previewBlend(percent)
    }

    let startPercent = 50
    if (window.SpacingEngine) {
      const blend = window.SpacingEngine.getBlendPercent()
      if (typeof blend === 'number') startPercent = blend
      else {
        const i = SNAP_POINTS.indexOf(window.SpacingEngine.getPresetName() || 'Default')
        startPercent = i === -1 ? 50 : SNAP_PCTS[i]
      }
    }
    setSliderTo(startPercent)

    let dragging = false

    const getPercent = (clientX) => {
      const rect = track.getBoundingClientRect()
      const raw = (clientX - rect.left) / rect.width * 100
      return Math.max(0, Math.min(100, raw))
    }

    thumb.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault() })

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return
      setSliderTo(snap(getPercent(e.clientX)), true)
    })

    document.addEventListener('mouseup', (e) => {
      if (!dragging) return
      dragging = false
      const pct = snap(getPercent(e.clientX))
      setSliderTo(pct)
      if (window.SpacingEngine) window.SpacingEngine.commitBlend(pct)
    })

    track.addEventListener('click', (e) => {
      if (e.target === thumb) return
      const pct = snap(getPercent(e.clientX))
      setSliderTo(pct)
      if (window.SpacingEngine) window.SpacingEngine.commitBlend(pct)
    })

    window.syncSpacingSlider = () => {
      if (!thumb || !fill) return
      let pct = 50
      if (window.SpacingEngine) {
        const blend = window.SpacingEngine.getBlendPercent()
        if (typeof blend === 'number') pct = blend
        else {
          const i = SNAP_POINTS.indexOf(window.SpacingEngine.getPresetName() || 'Default')
          pct = i === -1 ? 50 : SNAP_PCTS[i]
        }
      }
      setSliderTo(pct)
    }
  }
}

window.renderThemeStrip = renderThemeStrip

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSettings)
} else {
  initSettings()
}
