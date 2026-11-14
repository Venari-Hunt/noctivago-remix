// The marker layer one canvas (the Trim waveform, the Spectrum view) owns:
// it holds the markers, draws them (a colored tag with the name at the top
// and a dashed line down the picture, the approved mock's look A), finds the
// tag under the pointer, snaps a dragged time to a marker, and drags a tag.
// Time is original-file seconds, same as loopStart/loopEnd.
import { markerColor, snapToMarker, moveMarker, MARKER_SNAP_PX } from '../domain/markers.js'

const TAG_TOP = 4
const TAG_HEIGHT = 24
const TAG_MAX_WIDTH = 120
const TAG_FONT = "700 11px 'Segoe UI', sans-serif"
const ICON_SIZE = 10
// The mock's marker glyph (24 grid): a flat top with a point down.
const TAG_PATH = 'M5 3h14a1 1 0 0 1 1 1v10.2a1 1 0 0 1-.3.7l-7 6.8a1 1 0 0 1-1.4 0l-7-6.8a1 1 0 0 1-.3-.7V4a1 1 0 0 1 1-1z'
export const MARKER_ICON_SVG = `<svg class="rx-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${TAG_PATH}"/></svg>`

let measureCtx = null
function measure(text) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  measureCtx.font = TAG_FONT
  return measureCtx.measureText(text).width
}

// How wide a marker's tag is, clipped to the max.
function tagWidth(marker) {
  return Math.min(TAG_MAX_WIDTH, 5 + ICON_SIZE + 4 + Math.ceil(measure(marker.name)) + 7)
}

// Where a marker's tag sits for a given x of its line (centered on it).
export function tagRect(marker, x) {
  const w = tagWidth(marker)
  return { x: x - w / 2, y: TAG_TOP, w, h: TAG_HEIGHT }
}

function clipText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text
  let t = text
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1)
  return t + '…'
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export function createMarkerLayer({ onChange = () => {}, onEdit = () => {} } = {}) {
  let markers = []
  let selectedId = null
  // The marker a drag is snapped to right now (its line thickens, a note names it).
  let hitId = null

  const iconPath = typeof Path2D === 'function' ? new Path2D(TAG_PATH) : null

  const layer = {
    setMarkers(list) {
      markers = list
      if (selectedId != null && !markers.some((m) => m.id === selectedId)) selectedId = null
    },
    getMarkers: () => markers,
    select(id) {
      selectedId = id
    },
    getSelected: () => selectedId,
    setSnapped(marker) {
      hitId = marker ? marker.id : null
    },

    // Draws every marker whose line falls in view. timeToX maps seconds to
    // CSS-pixel x for the canvas's current view; the caller has already set
    // the CSS-pixel transform.
    draw(ctx, { width, height, timeToX, top = 0 }) {
      if (!markers.length) return
      ctx.save()
      ctx.font = TAG_FONT
      ctx.textBaseline = 'middle'
      let snappedX = null
      let snappedName = ''
      for (const m of markers) {
        const x = timeToX(m.time)
        if (x < -TAG_MAX_WIDTH || x > width + TAG_MAX_WIDTH) continue
        const color = markerColor(m)
        const hit = m.id === hitId
        const sel = m.id === selectedId
        ctx.strokeStyle = color
        ctx.globalAlpha = hit || sel ? 1 : 0.75
        ctx.lineWidth = hit ? 2 : 1
        ctx.setLineDash(hit || sel ? [] : [4, 3])
        ctx.beginPath()
        ctx.moveTo(Math.round(x) + 0.5, top + TAG_TOP + TAG_HEIGHT)
        ctx.lineTo(Math.round(x) + 0.5, height)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1
        const r = tagRect(m, x)
        if (sel) {
          ctx.fillStyle = '#0b0b0d'
          roundRect(ctx, r.x - 2, top + r.y - 2, r.w + 4, r.h + 4, 6)
          ctx.fill()
        }
        ctx.fillStyle = color
        roundRect(ctx, r.x, top + r.y, r.w, r.h, 4)
        ctx.fill()
        ctx.fillStyle = '#141417'
        if (iconPath) {
          ctx.save()
          ctx.translate(r.x + 5, top + r.y + (r.h - ICON_SIZE) / 2)
          ctx.scale(ICON_SIZE / 24, ICON_SIZE / 24)
          ctx.fill(iconPath)
          ctx.restore()
        }
        ctx.textAlign = 'left'
        ctx.fillText(clipText(ctx, m.name, r.w - (5 + ICON_SIZE + 4 + 7)), r.x + 5 + ICON_SIZE + 4, top + r.y + r.h / 2 + 0.5)
        if (hit) {
          snappedX = x
          snappedName = m.name
        }
      }
      if (snappedX != null) {
        const label = `Snapped to ${snappedName}`
        const w = Math.ceil(ctx.measureText(label).width) + 16
        const x = Math.max(w / 2, Math.min(width - w / 2, snappedX))
        ctx.fillStyle = '#ece9e2'
        roundRect(ctx, x - w / 2, top + TAG_TOP + TAG_HEIGHT + 4, w, 20, 6)
        ctx.fill()
        ctx.fillStyle = '#141417'
        ctx.textAlign = 'center'
        ctx.fillText(label, x, top + TAG_TOP + TAG_HEIGHT + 14.5)
      }
      ctx.restore()
    },

    // The marker whose tag is under (x, y) in canvas CSS pixels, or null.
    hitTag(x, y, timeToX, top = 0) {
      for (let i = markers.length - 1; i >= 0; i--) {
        const m = markers[i]
        const r = tagRect(m, timeToX(m.time))
        if (x >= r.x && x <= r.x + r.w && y >= top + r.y && y <= top + r.y + r.h) return m
      }
      return null
    },

    // Snap a dragged time to a marker within 8 px. Returns { time, marker }.
    // `enabled` false (Ctrl held) leaves the time alone.
    snap(time, secondsPerPixel, enabled = true) {
      if (!enabled) return { time, marker: null }
      return snapToMarker(markers, time, secondsPerPixel, MARKER_SNAP_PX)
    },

    // Drag a tag sideways. timeAt(clientX) gives the time under the pointer;
    // redraw repaints the canvas; a click without movement just selects.
    startDrag(evt, marker, { timeAt, duration, redraw }) {
      selectedId = marker.id
      redraw()
      let moved = false
      const startX = evt.clientX
      const move = (e) => {
        if (!moved && Math.abs(e.clientX - startX) < 3) return
        moved = true
        markers = moveMarker(markers, marker.id, timeAt(e.clientX), duration)
        redraw()
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        if (moved) onChange(markers)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },

    // Right-click or double-click a tag: ask the owner of the layer to open
    // the editor for it.
    edit(marker, clientX, clientY) {
      selectedId = marker.id
      onEdit(marker, clientX, clientY)
    }
  }
  return layer
}
