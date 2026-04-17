const TABS = ['library', 'explore', 'visualizer', 'settings']
const BLADE_W = 46
let activeTab = 'library'

TABS.forEach(tab => {
    document.getElementById('blade-' + tab)
        .addEventListener('click', () => switchTab(tab))
})

document.addEventListener('keydown', (event) => {
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
        }, 100)
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
