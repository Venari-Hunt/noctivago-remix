import { resizeCanvasForDisplay } from '../audio/waveform.js'
import { loopLayout, clipToSource } from '../domain/loopLayout.js'

// "Loop seam" strip (v0.1.222): the loop drawn the way it actually plays,
// laid out like a DAW's overlapping-tail crossfade (the owner's reference):
//
//   [ second half of the trim ][ X crossfade X ][ first half of the trim ]
//
// The clip starts and ends mid-trim on one continuous recording, so the
// only edit is the original end -> start join, under the crossfade in the
// middle (loopLayout.js / loopClip.js). Inside the overlap both sides are
// drawn with their equal-power gain applied. Dragging either overlap edge
// sets the crossfade length (both edges move together, around the center),
// double-clicking an edge resets it, and pressing anywhere else scrubs.
// Times handed in and out are clip times (0..layout.length).
//
// Zoom (v0.1.231): scroll to zoom, centered on the cursor, and middle-drag
// to pan - the same interaction the main trim waveform already has
// (LoopEditor.js's handleWheel/pointerDown 'pan'), so it feels consistent
// rather than a second interaction to learn. The crossfade-edge pins only
// hit-test at full zoom-out (edgeHit) - their drag math derives the fade
// from the overlap's own on-screen symmetry around the canvas center, which
// only holds when the canvas is showing the whole clip; once zoomed, the
// existing "Loop crossfade" slider is still the way to change the fade
// value. Detail peaks (finer than the trim-wide fetch index.js already
// does) are requested through onViewportChange whenever a zoom/pan settles,
// keyed off the union of source-time positions actually on screen -
// straddling the crossfade blend shows two source ranges (tail and head) at
// once, so that union is computed by sampling across the view rather than
// just its two endpoints.

const EDGE_HIT_PX = 8
const CURVE_STEPS = 32
const ZOOM_IN_FACTOR = 0.8
const ZOOM_OUT_FACTOR = 1.25
// Clip-time floor for how far a scroll-zoom can shrink the view - capped at
// the clip's own length too, for a clip shorter than this (a tiny trim with
// a big crossfade eating most of it).
const MIN_VIEW_SECONDS = 0.05
// Source-range sampling resolution for the detail-peaks request (see the
// header comment above) - enough steps to catch the blend's two curves
// without resampling on every single pixel.
const SOURCE_RANGE_SAMPLES = 48
const COLORS = {
  background: '#161a2b',
  secondHalf: 'rgba(122, 162, 247, 0.10)',
  firstHalf: 'rgba(158, 206, 106, 0.08)',
  wave: 'rgba(122, 162, 247, 0.65)',
  tailWave: 'rgba(122, 162, 247, 0.55)',
  headWave: 'rgba(158, 206, 106, 0.55)',
  hatch: 'rgba(255, 255, 255, 0.07)',
  overlap: 'rgba(255, 255, 255, 0.05)',
  edge: 'rgba(255, 255, 255, 0.85)',
  tailCurve: '#7aa2f7',
  headCurve: '#9ece6a',
  label: '#c0caf5',
  dim: '#8892b0',
  playhead: '#ff9e64'
}

export function createSeamViewController(canvas) {
  let loopStart = 0
  let loopEnd = 0
  let fadeSec = 0
  let maxSec = 2
  let stepSec = 0.01
  let defaultSec = 0.2
  let enabled = true
  let peaks = null
  let peaksStart = 0
  let peaksEnd = 0
  let playhead = null
  let dragging = null
  let onChange = () => {}
  let onScrub = () => {}
  let onViewportChangeCb = () => {}
  // (0, 0) is the "not zoomed" sentinel rather than persisting the full
  // range - see resolveView - so a shrinking clip (editing the trim while
  // zoomed out) never needs an explicit reset.
  let viewStart = 0
  let viewEnd = 0
  let panStartX = 0
  let panStartViewStart = 0
  let panStartViewEnd = 0
  let detailPeaks = null
  let detailPeaksStart = 0
  let detailPeaksEnd = 0

  const layout = () => loopLayout(loopStart, loopEnd, enabled ? fadeSec : 0)

  function resolveView(length) {
    if (!(viewEnd > viewStart)) return [0, length]
    const s = Math.max(0, viewStart)
    const e = Math.min(length, viewEnd)
    return e > s ? [s, e] : [0, length]
  }

  function currentView() {
    const L = layout()
    const [lo, hi] = resolveView(L.length)
    return { L, lo, hi }
  }

  // The union of source-time positions actually drawn across [viewLo,
  // viewHi] of clip time - both the tail and head curves where that window
  // straddles the crossfade blend, otherwise the single plain/tail mapping
  // clipToSource already gives. See the header comment for why.
  function computeSourceRange(viewLo, viewHi) {
    const L = layout()
    if (!(L.length > 0)) return null
    let lo = Infinity
    let hi = -Infinity
    const consider = (t) => {
      if (t < lo) lo = t
      if (t > hi) hi = t
    }
    for (let i = 0; i <= SOURCE_RANGE_SAMPLES; i++) {
      const ct = viewLo + (viewHi - viewLo) * (i / SOURCE_RANGE_SAMPLES)
      if (L.fade > 0 && ct >= L.blendStart && ct <= L.blendEnd) {
        consider(L.loopEnd - L.fade + (ct - L.blendStart))
        consider(L.loopStart + (ct - L.blendStart))
      } else {
        consider(clipToSource(L, ct))
      }
    }
    return hi > lo ? [lo, hi] : null
  }

  // The one place that commits a new view window - clamps to [0, length]
  // (sliding back in bounds rather than shrinking, so zoom level never
  // changes as a side effect), redraws, and reports the visible source
  // range to whatever wants finer peaks for it. Mirrors LoopEditor.js's own
  // applyViewport.
  function applyView(newStart, newEnd, length) {
    let s = newStart
    let e = newEnd
    if (s < 0) {
      e -= s
      s = 0
    }
    if (e > length) {
      s -= e - length
      e = length
    }
    viewStart = Math.max(s, 0)
    viewEnd = Math.min(e, length)
    redraw()
    onViewportChangeCb(computeSourceRange(viewStart, viewEnd))
  }

  function peakAt(t) {
    if (detailPeaks && detailPeaks.length > 0 && detailPeaksEnd > detailPeaksStart && t >= detailPeaksStart && t <= detailPeaksEnd) {
      const idx = Math.floor(((t - detailPeaksStart) / (detailPeaksEnd - detailPeaksStart)) * detailPeaks.length)
      return detailPeaks[Math.min(detailPeaks.length - 1, Math.max(0, idx))]
    }
    if (!peaks || peaks.length === 0 || peaksEnd <= peaksStart) return [0, 0]
    const idx = Math.floor(((t - peaksStart) / (peaksEnd - peaksStart)) * peaks.length)
    return peaks[Math.min(peaks.length - 1, Math.max(0, idx))]
  }

  function fillWave(ctx, x0, x1, width, mid, sample, color) {
    const from = Math.max(0, Math.floor(x0))
    const to = Math.min(width, Math.ceil(x1))
    if (to <= from) return
    ctx.beginPath()
    for (let x = from; x <= to; x++) ctx.lineTo(x, mid - sample(x)[1] * mid * 0.85)
    for (let x = to; x >= from; x--) ctx.lineTo(x, mid - sample(x)[0] * mid * 0.85)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }

  function label(ctx, text, x, align, color = COLORS.label, y = 4) {
    ctx.fillStyle = color
    ctx.font = '10px sans-serif'
    ctx.textBaseline = 'top'
    ctx.textAlign = align
    ctx.fillText(text, x, y)
  }

  function redraw() {
    const { width, height, dpr } = resizeCanvasForDisplay(canvas)
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = COLORS.background
    ctx.fillRect(0, 0, width, height)
    const L = layout()
    if (!(L.length > 0)) return
    const [viewLo, viewHi] = resolveView(L.length)
    const viewSpan = viewHi - viewLo
    const zoomed = viewSpan < L.length - 1e-6
    const mid = height / 2
    const xOf = (t) => ((t - viewLo) / viewSpan) * width
    const tOf = (x) => viewLo + (x / width) * viewSpan
    const bx0 = xOf(L.blendStart)
    const bx1 = xOf(L.blendEnd)

    ctx.fillStyle = COLORS.secondHalf
    ctx.fillRect(0, 0, bx0, height)
    ctx.fillStyle = COLORS.firstHalf
    ctx.fillRect(bx1, 0, width - bx1, height)

    const plain = (x) => {
      const [min, max] = peakAt(clipToSource(L, tOf(x)))
      return [min, max]
    }
    if (L.fade > 0) {
      fillWave(ctx, 0, bx0, width, mid, plain, COLORS.wave)
      fillWave(ctx, bx1, width, width, mid, plain, COLORS.wave)

      // Overlap: hatched, both sides drawn at their equal-power gain.
      ctx.fillStyle = COLORS.overlap
      ctx.fillRect(bx0, 0, bx1 - bx0, height)
      ctx.save()
      ctx.beginPath()
      ctx.rect(bx0, 0, bx1 - bx0, height)
      ctx.clip()
      ctx.strokeStyle = COLORS.hatch
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = bx0 - height; x < bx1; x += 6) {
        ctx.moveTo(x, height)
        ctx.lineTo(x + height, 0)
      }
      ctx.stroke()
      const phase = (x) => Math.min(Math.max((tOf(x) - L.blendStart) / L.fade, 0), 1) * (Math.PI / 2)
      const scaled = (source, gain) => (x) => {
        const [min, max] = peakAt(source(x))
        const g = gain(x)
        return [min * g, max * g]
      }
      const tail = (x) => L.loopEnd - L.fade + (tOf(x) - L.blendStart)
      const head = (x) => L.loopStart + (tOf(x) - L.blendStart)
      fillWave(ctx, bx0, bx1, width, mid, scaled(tail, (x) => Math.cos(phase(x))), COLORS.tailWave)
      fillWave(ctx, bx0, bx1, width, mid, scaled(head, (x) => Math.sin(phase(x))), COLORS.headWave)

      // The X: the end of the trim fading out (blue) and its start fading in
      // (green). Equal-power curves cross at ~71% rather than halfway.
      const curve = (gain, color) => {
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.beginPath()
        for (let i = 0; i <= CURVE_STEPS; i++) {
          const a = (i / CURVE_STEPS) * (Math.PI / 2)
          const x = bx0 + (bx1 - bx0) * (i / CURVE_STEPS)
          const y = height - gain(a) * (height - 2)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      curve(Math.cos, COLORS.tailCurve)
      curve(Math.sin, COLORS.headCurve)
      ctx.restore()

      ctx.strokeStyle = COLORS.edge
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(bx0, 0)
      ctx.lineTo(bx0, height)
      ctx.moveTo(bx1, 0)
      ctx.lineTo(bx1, height)
      ctx.stroke()

      label(ctx, '2nd half of trim', 5, 'left')
      label(ctx, '1st half of trim', width - 5, 'right')
      if (bx0 > 90) label(ctx, `${L.fade.toFixed(2)} s`, (bx0 + bx1) / 2, 'center')
    } else {
      fillWave(ctx, 0, width, width, mid, plain, COLORS.wave)
      label(ctx, 'Start of trim', 5, 'left')
      label(ctx, 'End of trim', width - 5, 'right')
      label(ctx, enabled ? 'Crossfade off: the loop restarts with a hard cut. Drag from the middle to add one.' : 'Doppler is on: no crossfade', width / 2, 'center', COLORS.dim)
      if (enabled) {
        const centerX = xOf(L.length / 2)
        ctx.strokeStyle = COLORS.edge
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(centerX, 18)
        ctx.lineTo(centerX, height)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    if (Number.isFinite(playhead)) {
      const x = xOf(Math.min(Math.max(playhead, 0), L.length))
      ctx.strokeStyle = COLORS.playhead
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
    }

    if (zoomed) label(ctx, 'Zoomed — double-click to reset', width / 2, 'center', COLORS.dim, 16)
  }

  // Edge pins only hit-test at full zoom-out - fadeForX's math derives the
  // fade from where the overlap sits relative to the *canvas* center, which
  // only equals the clip-time center (L.length / 2) when the whole clip is
  // on screen. Scrubbing still works at any zoom (it just reads tOf(x)).
  function edgeHit(x, width) {
    if (!enabled) return false
    const { L, lo, hi } = currentView()
    if (!(L.length > 0)) return false
    if (hi - lo < L.length - 1e-6) return false
    const center = width / 2
    if (L.fade <= 0) return Math.abs(x - center) <= EDGE_HIT_PX
    const half = ((L.fade / 2) / L.length) * width
    return Math.abs(Math.abs(x - center) - half) <= EDGE_HIT_PX
  }

  // The overlap is always centered, so its half-width d (px) fixes the fade:
  // d / width = (f / 2) / (trim - f)  =>  f = 2 d trim / (width + 2 d).
  function fadeForX(x, width) {
    const trim = Math.max(0, loopEnd - loopStart)
    const d = Math.abs(x - width / 2)
    const raw = (2 * d * trim) / (width + 2 * d)
    const cap = Math.min(maxSec, trim / 4)
    const snapped = Math.round(Math.min(raw, cap) / stepSec) * stepSec
    return Math.min(Math.max(snapped, 0), cap)
  }

  function scrubAt(x, width) {
    const { L, lo, hi } = currentView()
    if (!(L.length > 0)) return
    playhead = Math.min(Math.max(lo + (x / width) * (hi - lo), 0), L.length)
    redraw()
    onScrub(playhead)
  }

  function pointerDown(evt) {
    // Middle-click-drag pans, same button/semantics as the main trim
    // waveform (LoopEditor.js) - drag right to reveal earlier content.
    if (evt.button === 1) {
      const { L, lo, hi } = currentView()
      if (!(L.length > 0)) return
      evt.preventDefault()
      dragging = 'pan'
      panStartX = evt.clientX
      panStartViewStart = lo
      panStartViewEnd = hi
      return
    }
    if (evt.button !== 0 || !(loopEnd > loopStart)) return
    const rect = canvas.getBoundingClientRect()
    const x = evt.clientX - rect.left
    dragging = edgeHit(x, rect.width) ? 'edge' : 'scrub'
    if (dragging === 'scrub') scrubAt(x, rect.width)
  }

  function pointerMove(evt) {
    const rect = canvas.getBoundingClientRect()
    const x = evt.clientX - rect.left
    if (dragging === 'pan') {
      const L = layout()
      if (!(L.length > 0)) return
      const span = panStartViewEnd - panStartViewStart
      const deltaTime = ((evt.clientX - panStartX) / rect.width) * span
      applyView(panStartViewStart - deltaTime, panStartViewEnd - deltaTime, L.length)
      return
    }
    if (!dragging) {
      if (evt.target === canvas) canvas.style.cursor = edgeHit(x, rect.width) ? 'ew-resize' : 'pointer'
      return
    }
    if (dragging === 'scrub') {
      scrubAt(Math.min(Math.max(x, 0), rect.width), rect.width)
      return
    }
    const next = fadeForX(x, rect.width)
    if (next !== fadeSec) {
      fadeSec = next
      redraw()
      onChange(fadeSec)
    }
  }

  function pointerUp() {
    dragging = null
  }

  // Wheel zoom, centered on the cursor's time - same shape as the main trim
  // waveform's handleWheel. A horizontal scroll gesture pans instead.
  function handleWheel(evt) {
    const { L, lo, hi } = currentView()
    if (!(L.length > 0)) return
    evt.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const span = hi - lo

    if (Math.abs(evt.deltaX) > Math.abs(evt.deltaY)) {
      const shift = (evt.deltaX / rect.width) * span
      applyView(lo + shift, hi + shift, L.length)
      return
    }

    const x = evt.clientX - rect.left
    const cursorTime = lo + (x / rect.width) * span
    const factor = evt.deltaY < 0 ? ZOOM_IN_FACTOR : ZOOM_OUT_FACTOR
    const minSpan = Math.min(MIN_VIEW_SECONDS, L.length)
    const newSpan = Math.min(Math.max(span * factor, minSpan), L.length)
    const ratio = span > 0 ? (cursorTime - lo) / span : 0.5
    const newStart = cursorTime - ratio * newSpan
    applyView(newStart, newStart + newSpan, L.length)
  }

  function doubleClick(evt) {
    const rect = canvas.getBoundingClientRect()
    const x = evt.clientX - rect.left
    if (edgeHit(x, rect.width)) {
      fadeSec = defaultSec
      redraw()
      onChange(fadeSec)
      return
    }
    const { L, lo, hi } = currentView()
    if (L.length > 0 && hi - lo < L.length - 1e-6) applyView(0, L.length, L.length)
  }

  canvas.addEventListener('mousedown', pointerDown)
  canvas.addEventListener('dblclick', doubleClick)
  window.addEventListener('mousemove', pointerMove)
  window.addEventListener('mouseup', pointerUp)
  canvas.addEventListener('wheel', handleWheel, { passive: false })
  window.addEventListener('resize', redraw)

  // Re-requests detail peaks for the current view against a just-changed
  // layout (setLoop/setCrossfade) - only matters while zoomed (unzoomed,
  // the trim-wide peaks index.js already fetches are enough), and only a
  // no-op call if nothing's listening yet.
  function refreshDetailForCurrentView(length) {
    const [lo, hi] = resolveView(length)
    if (hi - lo < length - 1e-6) onViewportChangeCb(computeSourceRange(lo, hi))
  }

  return {
    setLoop(newStart, newEnd) {
      loopStart = newStart
      loopEnd = newEnd
      refreshDetailForCurrentView(layout().length)
      redraw()
    },
    setCrossfade(seconds) {
      fadeSec = Math.max(0, seconds || 0)
      refreshDetailForCurrentView(layout().length)
      redraw()
    },
    setLimits({ maxSeconds, stepSeconds, defaultSeconds }) {
      maxSec = maxSeconds
      stepSec = stepSeconds
      defaultSec = defaultSeconds
    },
    // false while Doppler is on - its bake has no crossfade.
    setEnabled(value) {
      enabled = Boolean(value)
      redraw()
    },
    // peaks: [min, max] pairs spanning [rangeStart, rangeEnd] of the source.
    setPeaks(newPeaks, rangeStart, rangeEnd) {
      peaks = newPeaks
      peaksStart = rangeStart
      peaksEnd = rangeEnd
      redraw()
    },
    // Finer peaks for exactly the current zoomed-in view - see the header
    // comment and index.js's scheduleSeamDetailPeaks. Falls back to the
    // (coarser) base peaks outside [rangeStart, rangeEnd].
    setDetailPeaks(newPeaks, rangeStart, rangeEnd) {
      detailPeaks = newPeaks
      detailPeaksStart = rangeStart
      detailPeaksEnd = rangeEnd
      redraw()
    },
    setPlayhead(clipTime) {
      playhead = clipTime
      redraw()
    },
    // Back to showing the whole clip - called on loading a different sound,
    // since a zoom window from the previous sound means nothing here.
    resetZoom() {
      viewStart = 0
      viewEnd = 0
      detailPeaks = null
      detailPeaksStart = 0
      detailPeaksEnd = 0
      redraw()
    },
    getLayout: layout,
    redraw,
    onCrossfadeChange(fn) {
      onChange = fn
    },
    onScrub(fn) {
      onScrub = fn
    },
    // fn(sourceRange | null) - the source-time range the current zoomed
    // view spans, whenever a zoom/pan gesture settles. index.js uses this
    // to fetch finer peaks for just that range.
    onViewportChange(fn) {
      onViewportChangeCb = fn
    },
    destroy() {
      canvas.removeEventListener('mousedown', pointerDown)
      canvas.removeEventListener('dblclick', doubleClick)
      window.removeEventListener('mousemove', pointerMove)
      window.removeEventListener('mouseup', pointerUp)
      canvas.removeEventListener('wheel', handleWheel)
      window.removeEventListener('resize', redraw)
    }
  }
}
