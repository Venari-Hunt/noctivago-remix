// The "bar with 3 circles" control the owner spec'd for Remix Fluctuation
// (Obsidian inbox): a horizontal track with three draggable handles -
//   - min  : the lowest the value drifts to
//   - max  : the highest the value drifts to
//   - bias : where the value sits most of the time (must stay between min/max)
// The left edge of the track is valueMin, the right edge is valueMax. Drag a
// handle to move it; double-click a handle to reset just that one to its
// default. onChange fires continuously during a drag and once on release.
// v0.1.218: setBiasEnabled(false) hides the bias circle (values are then
// picked evenly between min and max) - used by every drift and per-play
// random bar's "Bias" toggle.
//
// Same canvas discipline as this plugin's other custom controls
// (LoopEditor / EqEditor): interaction math works in CSS-pixel space
// (rect.width/height), and the bitmap is resized to the rendered size x
// devicePixelRatio before every draw so nothing renders stretched/blurry
// (the exact bug class that hit the EQ graph and trim waveform before).
//
// Owner bug (2026-09-17, "keeps happening"): min/max labels showed up
// upside-down and mirrored, overlapping the bias label. Two causes, both
// handled here: (1) most bars are created while their section is hidden, so
// the first draw used the 260px fallback width and nothing redrew it once
// shown - the stale bitmap got stretched to full width. A ResizeObserver now
// redraws whenever the rendered size changes (including hidden -> shown).
// (2) the flipped copy is a GPU-compositing glitch some Windows drivers have
// with accelerated 2D canvases; willReadFrequently keeps these tiny canvases
// on the CPU rasterizer, so there is no GPU texture to flip.

const HANDLE_RADIUS = 7
const GRAB_SLOP = 11
const TRACK_PAD = 14

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

export function createFluctuationBar(canvas, { valueMin, valueMax, defaults, format, onChange }) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const fmt = format ?? ((v) => String(Math.round(v * 100) / 100))
  let values = { ...defaults }
  let enabled = true
  let biasOn = true
  let dragging = null // 'min' | 'bias' | 'max' | null
  let cssW = 0
  let cssH = 0

  function resizeForDisplay() {
    const rect = canvas.getBoundingClientRect()
    cssW = rect.width || canvas.clientWidth || 260
    cssH = rect.height || canvas.clientHeight || 54
    const dpr = window.devicePixelRatio || 1
    const bw = Math.round(cssW * dpr)
    const bh = Math.round(cssH * dpr)
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function xFor(v) {
    const t = (v - valueMin) / (valueMax - valueMin || 1)
    return TRACK_PAD + t * (cssW - 2 * TRACK_PAD)
  }

  function valueForX(x) {
    const t = (x - TRACK_PAD) / (cssW - 2 * TRACK_PAD || 1)
    return clamp(valueMin + t * (valueMax - valueMin), valueMin, valueMax)
  }

  function styleColor(name, fallback) {
    const v = getComputedStyle(canvas).getPropertyValue(name).trim()
    return v || fallback
  }

  function draw() {
    resizeForDisplay()
    const cy = Math.round(cssH * 0.42)
    ctx.clearRect(0, 0, cssW, cssH)

    const accent = styleColor('--accent', '#7aa2f7')
    const biasColor = '#bb9af7'
    const dim = enabled ? 1 : 0.4
    ctx.globalAlpha = dim

    // base track
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(TRACK_PAD, cy)
    ctx.lineTo(cssW - TRACK_PAD, cy)
    ctx.stroke()

    // active span (min..max)
    ctx.strokeStyle = accent
    ctx.beginPath()
    ctx.moveTo(xFor(values.min), cy)
    ctx.lineTo(xFor(values.max), cy)
    ctx.stroke()

    // handles
    const drawHandle = (v, color, filled) => {
      const x = xFor(v)
      ctx.beginPath()
      ctx.arc(x, cy, HANDLE_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = filled ? color : '#1a1b26'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = color
      ctx.stroke()
    }
    drawHandle(values.min, accent, false)
    drawHandle(values.max, accent, false)
    if (biasOn) drawHandle(values.bias, biasColor, true)

    // value labels under each handle
    ctx.globalAlpha = dim
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.font = '10px system-ui, sans-serif'
    ctx.textBaseline = 'top'
    const labelY = cy + HANDLE_RADIUS + 4
    ctx.textAlign = 'center'
    ctx.fillText(fmt(values.min), clamp(xFor(values.min), 12, cssW - 12), labelY)
    ctx.fillText(fmt(values.max), clamp(xFor(values.max), 12, cssW - 12), labelY)
    if (biasOn) {
      ctx.fillStyle = biasColor
      ctx.fillText(fmt(values.bias), clamp(xFor(values.bias), 12, cssW - 12), cy - HANDLE_RADIUS - 13)
    }
    ctx.globalAlpha = 1
  }

  function pickHandle(x) {
    // min and max sitting on the same spot (e.g. a "no variation" default):
    // which one to move is decided by the first drag direction - see
    // onPointerMove's 'split' case.
    if (Math.abs(xFor(values.min) - xFor(values.max)) < 2 && Math.abs(x - xFor(values.min)) <= GRAB_SLOP) {
      return 'split'
    }
    const cands = [
      ...(biasOn ? [['bias', Math.abs(x - xFor(values.bias))]] : []),
      ['min', Math.abs(x - xFor(values.min))],
      ['max', Math.abs(x - xFor(values.max))]
    ].sort((a, b) => a[1] - b[1])
    return cands[0][1] <= GRAB_SLOP ? cands[0][0] : null
  }

  function applyDrag(handle, x) {
    const v = valueForX(x)
    if (handle === 'min') {
      values.min = Math.min(v, values.max)
      values.bias = clamp(values.bias, values.min, values.max)
    } else if (handle === 'max') {
      values.max = Math.max(v, values.min)
      values.bias = clamp(values.bias, values.min, values.max)
    } else {
      values.bias = clamp(v, values.min, values.max)
    }
    draw()
    onChange?.({ ...values })
  }

  function localX(evt) {
    const rect = canvas.getBoundingClientRect()
    return evt.clientX - rect.left
  }

  let splitStartX = 0

  function onPointerDown(evt) {
    if (!enabled) return
    const handle = pickHandle(localX(evt))
    if (!handle) return
    dragging = handle
    canvas.setPointerCapture?.(evt.pointerId)
    if (handle === 'split') {
      splitStartX = localX(evt)
      return
    }
    applyDrag(handle, localX(evt))
  }

  function onPointerMove(evt) {
    if (!dragging) {
      canvas.style.cursor = enabled && pickHandle(localX(evt)) ? 'ew-resize' : 'default'
      return
    }
    if (dragging === 'split') {
      const dx = localX(evt) - splitStartX
      if (Math.abs(dx) < 2) return
      dragging = dx < 0 ? 'min' : 'max'
    }
    applyDrag(dragging, localX(evt))
  }

  function onPointerUp(evt) {
    if (!dragging) return
    dragging = null
    canvas.releasePointerCapture?.(evt.pointerId)
    onChange?.({ ...values })
  }

  function onDblClick(evt) {
    if (!enabled) return
    const picked = pickHandle(localX(evt))
    if (!picked) return
    const handle = picked === 'split' ? 'min' : picked
    values[handle] = defaults[handle]
    // keep ordering sane after a reset
    values.min = Math.min(values.min, values.max)
    values.bias = clamp(values.bias, values.min, values.max)
    draw()
    onChange?.({ ...values })
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('dblclick', onDblClick)
  const onResize = () => draw()
  window.addEventListener('resize', onResize)
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
  resizeObserver?.observe(canvas)

  draw()

  return {
    setValues(next) {
      values = {
        min: clamp(next?.min ?? defaults.min, valueMin, valueMax),
        max: clamp(next?.max ?? defaults.max, valueMin, valueMax),
        bias: next?.bias ?? defaults.bias
      }
      values.min = Math.min(values.min, values.max)
      values.bias = clamp(values.bias, values.min, values.max)
      draw()
    },
    getValues() {
      return { ...values }
    },
    setEnabled(on) {
      enabled = Boolean(on)
      draw()
    },
    setBiasEnabled(on) {
      biasOn = Boolean(on)
      draw()
    },
    redraw: draw,
    destroy() {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('dblclick', onDblClick)
      window.removeEventListener('resize', onResize)
      resizeObserver?.disconnect()
    }
  }
}
