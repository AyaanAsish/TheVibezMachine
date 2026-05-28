(function () {
  'use strict'

  window.highlightTracklistItems = function (selector, activeIndex) {
    document.querySelectorAll(selector).forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex)
    })
  }
})()
