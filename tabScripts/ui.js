const TABS = ['library', 'explore', 'visualizer', 'settings']
const BLADE_W = 46
let activeTab = 'library'

TABS.forEach(tab => {
    document.getElementById('blade-' + tab)
        .addEventListener('click', () => switchTab(tab))
})

window.isUserTyping = () => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    return false;
};

document.addEventListener('keydown', (event) => {
    if (window.isUserTyping()) return;
    const i = TABS.indexOf(activeTab);
    if (i === -1) return;

    if (event.key === 'ArrowLeft') {
        const next = TABS[i - 1];
        if (next) switchTab(next);
    }

    if (event.key === 'ArrowRight') {
        const next = TABS[i + 1];
        if (next) switchTab(next);
    }
});

function positionBlades(animate) {
    const appWidth = document.getElementById('app').offsetWidth
    const activeIdx = TABS.indexOf(activeTab)

    const content = document.getElementById('content')
    content.style.left  = (activeIdx * BLADE_W) + 'px'
    content.style.right = ((TABS.length - activeIdx - 1) * BLADE_W) + 'px'

    TABS.forEach((tab, i) => {
        const blade = document.getElementById('blade-' + tab)
        blade.classList.toggle('animating', animate)
        blade.classList.toggle('activeBlade', tab === activeTab)
        blade.style.left = i <= activeIdx
            ? (i * BLADE_W) + 'px'
            : (appWidth - (TABS.length - i) * BLADE_W) + 'px'
    })
}

function switchTab(newTab) {
    if (newTab === activeTab) return

    // Fade out old content
    const oldItems = document.querySelector('#' + activeTab + ' .items')
    if (oldItems) oldItems.classList.remove('items-visible')

    document.getElementById(activeTab).classList.remove('active')

    // Start blade slide animation
    setTimeout(() => {
        activeTab = newTab
        document.getElementById(newTab).classList.add('active')
        positionBlades(true)

        // After blade sweep finishes, fade in new content
        setTimeout(() => {
            const newItems = document.querySelector('#' + newTab + ' .items')
            if (newItems) newItems.classList.add('items-visible')
            if (newTab === 'settings' && window.renderThemeStrip) renderThemeStrip()
            if (newTab === 'settings' && window.SpacingEngine && document.getElementById('spacing-thumb')) {
              const SNAP = ['Compact', 'Default', 'Relaxed']
              let pct = 50
              let label = 'Default'
              const blend = window.SpacingEngine.getBlendPercent()
              if (typeof blend === 'number') {
                pct = blend
                const i = Math.round(pct / 100 * (SNAP.length - 1))
                label = SNAP[Math.max(0, Math.min(SNAP.length - 1, i))]
              } else {
                const saved = window.SpacingEngine.getPresetName() || 'Default'
                const i = SNAP.indexOf(saved)
                pct = i === -1 ? 50 : (i / (SNAP.length - 1)) * 100
                label = saved
              }
              document.getElementById('spacing-thumb').style.left = pct + '%'
              document.getElementById('spacing-fill').style.width = pct + '%'
              const lbl = document.getElementById('spacing-label')
              if (lbl) lbl.textContent = label
            }
        }, 50)
    }, 50)
}

// Initial positioning of blades and content
positionBlades(false)

const initItems = document.querySelector('#' + activeTab + ' .items')
if (initItems) initItems.classList.add('items-visible')

// Add event listener for window resize
window.addEventListener('resize', () => {
    positionBlades(false)
})
