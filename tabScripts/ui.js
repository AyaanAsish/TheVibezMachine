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
    if (document.body.classList.contains('fullscreen-active')) return;
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

let switchTimerA = null
let switchTimerB = null

function switchTab(newTab) {
    if (newTab === activeTab) return
    if (document.body.classList.contains('fullscreen-active')) return

    // Cancel any in-flight timeouts from a previous rapid switch
    if (switchTimerA) { clearTimeout(switchTimerA); switchTimerA = null }
    if (switchTimerB) { clearTimeout(switchTimerB); switchTimerB = null }

    // Remove active + visible from ALL tabs, not just the current one
    // (handles rapid-switch race where a previous timeout already
    //  added .active to a tab before this call got to run)
    TABS.forEach(tab => {
        document.getElementById(tab).classList.remove('active')
        const items = document.querySelector('#' + tab + ' .items')
        if (items) items.classList.remove('items-visible')
    })

    const target = newTab
    switchTimerA = setTimeout(() => {
        switchTimerA = null
        activeTab = target
        document.getElementById(target).classList.add('active')
        positionBlades(true)

        switchTimerB = setTimeout(() => {
            switchTimerB = null
            const newItems = document.querySelector('#' + target + ' .items')
            if (newItems) newItems.classList.add('items-visible')
            if (target === 'settings' && window.renderThemeStrip) renderThemeStrip()
            if (target === 'settings' && window.syncSpacingSlider) {
              window.syncSpacingSlider()
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
