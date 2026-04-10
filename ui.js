const TABS = ['library', 'explore', 'visualizer', 'settings']
const BLADE_W = 46
let activeTab = 'library'

function initBlades() {
    const app = document.getElementById('app')
    TABS.forEach(tab => {
        const div = document.createElement('div')
        div.className = 'bladeStrip'
        div.id = 'blade-' + tab

        const ind = document.createElement('div')
        ind.className = 'activeIndicator'

        const label = document.createElement('div')
        label.className = 'bladeLabel'
        label.textContent = tab[0].toUpperCase() + tab.slice(1)

        div.append(ind, label)
        div.addEventListener('click', () => switchTab(tab))
        app.appendChild(div)
    })
    positionBlades(false)
}

function positionBlades(animate) {
    const appWidth = document.getElementById('app').offsetWidth
    const activeIdx = TABS.indexOf(activeTab)

    const content = document.getElementById('content')
    content.classList.toggle('animatingC', animate)
    content.style.left = (activeIdx * BLADE_W) + 'px'
    content.style.right = ((TABS.length - activeIdx - 1) * BLADE_W) + 'px'

    TABS.forEach((tab, i) => {
        const blade = document.getElementById('blade-' + tab)
        blade.classList.toggle('animating', animate)
        blade.classList.toggle('activeBlade', tab === activeTab)
        blade.style.left = i <= activeIdx
            ? (i * BLADE_W) + 'px'
            : (appWidth - (TABS.length - i - 1) * BLADE_W - BLADE_W) + 'px'
    })
}

function switchTab(newTab) {
    if (newTab === activeTab) return
    document.getElementById(activeTab).classList.remove('active')
    activeTab = newTab
    positionBlades(true)
    setTimeout(() => document.getElementById(newTab).classList.add('active'), 300)
}

initBlades()