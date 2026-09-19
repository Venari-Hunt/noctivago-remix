// Hover marquee for the selected-sound title (#editor-sound-name) when the
// window is too narrow to show the whole name - mirrors the Mixer's own
// .sound-row-name marquee (src/renderer/ui/SoundRow.js), duplicated here for
// the same "a plugin bundles its own copies" reason as the constants above.
// The <h3> is white-space:nowrap + overflow:hidden + text-overflow:ellipsis
// (styles.css), so scrollWidth > clientWidth is exactly "this name is cut off".
export const MARQUEE_BASE_PX_PER_SEC = 45

export const MARQUEE_SPEED_SCALE = 0.06

export const MARQUEE_MAX_PX_PER_SEC = 140

export function wireNameMarquee(el) {
  el.addEventListener('mouseenter', () => {
    const overflow = el.scrollWidth - el.clientWidth
    if (overflow <= 0) return
    const pxPerSec = Math.min(MARQUEE_MAX_PX_PER_SEC, MARQUEE_BASE_PX_PER_SEC + overflow * MARQUEE_SPEED_SCALE)
    const duration = (overflow / pxPerSec) * 2 + 0.6
    el.style.setProperty('--marquee-distance', `-${overflow}px`)
    el.style.setProperty('--marquee-duration', `${duration}s`)
    el.classList.add('editor-sound-name-marquee')
  })
  el.addEventListener('mouseleave', () => {
    el.classList.remove('editor-sound-name-marquee')
  })
}
