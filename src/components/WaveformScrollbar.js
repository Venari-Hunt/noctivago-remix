// A minimal draggable "you are here" bar under the waveform, showing the
// current zoomed viewport as a thumb within the full track (full duration).
// Drag the thumb to pan; click elsewhere on the track to jump there.
// Deliberately plain HTML/CSS (not canvas-drawn) - a styled div is simpler
// and more idiomatic here than teaching the canvas renderer a second,
// unrelated widget.
export function createWaveformScrollbar(trackEl, thumbEl) {
  let duration = 0
  let viewStart = 0
  let viewEnd = 0
  let onNavigate = () => {}
  let dragging = false
  let dragStartX = 0
  let dragStartViewStart = 0

  function render() {
    if (!duration) {
      thumbEl.style.left = '0%'
      thumbEl.style.width = '100%'
      return
    }
    const leftPct = (viewStart / duration) * 100
    const widthPct = Math.max(((viewEnd - viewStart) / duration) * 100, 2)
    thumbEl.style.left = `${leftPct}%`
    thumbEl.style.width = `${widthPct}%`
  }

  function thumbMouseDown(evt) {
    if (!duration) return
    evt.preventDefault()
    // Stops the track's own mousedown (below) from also firing a
    // click-to-jump for the same gesture.
    evt.stopPropagation()
    dragging = true
    dragStartX = evt.clientX
    dragStartViewStart = viewStart
  }

  function windowMouseMove(evt) {
    if (!dragging || !duration) return
    const trackWidth = trackEl.getBoundingClientRect().width
    const span = viewEnd - viewStart
    const deltaTime = ((evt.clientX - dragStartX) / trackWidth) * duration
    onNavigate(dragStartViewStart + deltaTime, dragStartViewStart + deltaTime + span)
  }

  function windowMouseUp() {
    dragging = false
  }

  // Clicking the track outside the thumb re-centers the view on that point
  // - a standard scrollbar-track affordance.
  function trackMouseDown(evt) {
    if (evt.target === thumbEl || !duration) return
    const rect = trackEl.getBoundingClientRect()
    const clickTime = ((evt.clientX - rect.left) / rect.width) * duration
    const span = viewEnd - viewStart
    onNavigate(clickTime - span / 2, clickTime + span / 2)
  }

  thumbEl.addEventListener('mousedown', thumbMouseDown)
  trackEl.addEventListener('mousedown', trackMouseDown)
  window.addEventListener('mousemove', windowMouseMove)
  window.addEventListener('mouseup', windowMouseUp)

  return {
    update(newDuration, newViewStart, newViewEnd) {
      duration = newDuration
      viewStart = newViewStart
      viewEnd = newViewEnd
      render()
    },
    onNavigate(fn) {
      onNavigate = fn
    },
    destroy() {
      thumbEl.removeEventListener('mousedown', thumbMouseDown)
      trackEl.removeEventListener('mousedown', trackMouseDown)
      window.removeEventListener('mousemove', windowMouseMove)
      window.removeEventListener('mouseup', windowMouseUp)
    }
  }
}
