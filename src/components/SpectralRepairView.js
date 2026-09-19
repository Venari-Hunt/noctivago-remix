import { resizeCanvasForDisplay } from '../audio/waveform.js'
import {
  MAX_HZ,
  MIN_HZ,
  hzToY,
  isUsableRegion,
  normalizeRegions,
  regionFromCorners,
  secToX,
  spectrogramColor,
  xToSec,
  yToHz
} from '../domain/spectralLayout.js'

// Spectral repair panel: the loop region's spectrogram (fetched from the app,
// src/main/ffmpeg/spectrogram.js) with the user's repair boxes drawn over it.
// Drag on empty space to draw a box, drag a box to move it, drag its edge to
// resize it, right-click it (or select it and press Delete) to remove it.
// Boxes are in absolute file seconds + Hz, the shape the app bakes
// (spectralRepair.js). Bake-only: nothing here touches live audio.

const EDGE_HIT_PX = 6
const GRID_HZ = [100, 1000, 10000]
const COLORS = {
  background: '#161a2b',
  grid: 'rgba(255, 255, 255, 0.12)',
  label: '#c0caf5',
  dim: '#8892b0',
  boxFill: 'rgba(122, 162, 247, 0.16)',
  box: 'rgba(255, 255, 255, 0.7)',
  selected: '#7aa2f7',
  draft: 'rgba(255, 255, 255, 0.9)'
}

export function createSpectralRepairController(canvas) {
  const ctx = canvas.getContext('2d')
  let view = { start: 0, end: 1 }
  let image = null // offscreen canvas holding the spectrogram at 1px per cell
  let status = ''
  let regions = []
  let selected = -1
  let drag = null // { kind: 'create' | 'move' | 'resize', ... }
  const changeListeners = []
  const selectListeners = []

  const size = () => canvas.getBoundingClientRect()

  function pointAt(event) {
    const rect = size()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    return { x, y, sec: xToSec(x, view, rect.width), hz: yToHz(y, rect.height) }
  }

  function boxRect(region, width, height) {
    const x0 = secToX(region.startSec, view, width)
    const x1 = secToX(region.endSec, view, width)
    const y0 = hzToY(region.highHz, height)
    const y1 = hzToY(region.lowHz, height)
    return { x0, x1, y0, y1 }
  }

  // Topmost box under the point, and which of its edges (if any) are close
  // enough to grab.
  function hitTest(p) {
    const { width, height } = size()
    for (let i = regions.length - 1; i >= 0; i--) {
      const b = boxRect(regions[i], width, height)
      if (p.x < b.x0 - EDGE_HIT_PX || p.x > b.x1 + EDGE_HIT_PX || p.y < b.y0 - EDGE_HIT_PX || p.y > b.y1 + EDGE_HIT_PX) continue
      const edges = {
        left: Math.abs(p.x - b.x0) <= EDGE_HIT_PX,
        right: Math.abs(p.x - b.x1) <= EDGE_HIT_PX,
        top: Math.abs(p.y - b.y0) <= EDGE_HIT_PX,
        bottom: Math.abs(p.y - b.y1) <= EDGE_HIT_PX
      }
      const onEdge = edges.left || edges.right || edges.top || edges.bottom
      const inside = p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1
      if (onEdge || inside) return { index: i, edges: onEdge ? edges : null }
    }
    return null
  }

  function cursorFor(hit) {
    if (!hit) return 'crosshair'
    if (!hit.edges) return 'move'
    const { left, right, top, bottom } = hit.edges
    if ((left && top) || (right && bottom)) return 'nwse-resize'
    if ((right && top) || (left && bottom)) return 'nesw-resize'
    return left || right ? 'ew-resize' : 'ns-resize'
  }

  function select(index) {
    if (selected === index) return
    selected = index
    for (const cb of selectListeners) cb(selected)
  }

  function emitChange() {
    for (const cb of changeListeners) cb(getRegions())
  }

  function onPointerDown(event) {
    if (event.button !== 0) return
    canvas.focus()
    const p = pointAt(event)
    const hit = hitTest(p)
    canvas.setPointerCapture(event.pointerId)
    if (hit) {
      select(hit.index)
      drag = { kind: hit.edges ? 'resize' : 'move', index: hit.index, edges: hit.edges, from: p, original: { ...regions[hit.index] } }
    } else {
      select(-1)
      drag = { kind: 'create', from: p, to: p }
    }
    draw()
  }

  function onPointerMove(event) {
    const p = pointAt(event)
    if (!drag) {
      canvas.style.cursor = cursorFor(hitTest(p))
      return
    }
    if (drag.kind === 'create') {
      drag.to = p
    } else if (drag.kind === 'move') {
      const o = drag.original
      const length = o.endSec - o.startSec
      let start = o.startSec + (p.sec - drag.from.sec)
      start = Math.min(Math.max(start, view.start), view.end - length)
      // Move in log-Hz so a box keeps its shape on screen.
      const ratio = o.highHz / o.lowHz
      let low = o.lowHz * (p.hz / drag.from.hz)
      low = Math.min(Math.max(low, MIN_HZ), MAX_HZ / ratio)
      regions[drag.index] = { ...o, startSec: round2(start), endSec: round2(start + length), lowHz: Math.round(low), highHz: Math.round(low * ratio) }
    } else {
      const o = drag.original
      const e = drag.edges
      const a = { sec: e.left ? p.sec : o.startSec, hz: e.bottom ? p.hz : o.lowHz }
      const b = { sec: e.right ? p.sec : o.endSec, hz: e.top ? p.hz : o.highHz }
      regions[drag.index] = regionFromCorners(a, b, view, o.reductionDb)
    }
    draw()
  }

  function onPointerUp(event) {
    if (!drag) return
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    const finished = drag
    drag = null
    if (finished.kind === 'create') {
      const region = regionFromCorners(finished.from, finished.to, view)
      if (isUsableRegion(region)) {
        regions.push(region)
        select(regions.length - 1)
        emitChange()
      }
    } else if (!isUsableRegion(regions[finished.index])) {
      regions[finished.index] = finished.original // resized to nothing: undo
    } else if (JSON.stringify(regions[finished.index]) !== JSON.stringify(finished.original)) {
      emitChange()
    }
    draw()
  }

  function onContextMenu(event) {
    const hit = hitTest(pointAt(event))
    if (!hit) return
    event.preventDefault()
    removeAt(hit.index)
  }

  function onKeyDown(event) {
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== -1) {
      event.preventDefault()
      event.stopPropagation()
      removeAt(selected)
    }
  }

  function removeAt(index) {
    regions.splice(index, 1)
    select(-1)
    emitChange()
    draw()
  }

  function drawImage(width, height) {
    if (!image) return
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(image, 0, 0, width, height)
  }

  function drawGrid(width, height) {
    ctx.font = '10px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    for (const hz of GRID_HZ) {
      const y = Math.round(hzToY(hz, height)) + 0.5
      ctx.strokeStyle = COLORS.grid
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
      ctx.fillStyle = COLORS.label
      ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), 4, y - 7)
    }
  }

  function drawBox(region, width, height, style) {
    const b = boxRect(region, width, height)
    ctx.fillStyle = COLORS.boxFill
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0)
    ctx.strokeStyle = style.stroke
    ctx.lineWidth = style.lineWidth
    ctx.setLineDash(style.dash ?? [])
    ctx.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0 - 1, b.y1 - b.y0 - 1)
    ctx.setLineDash([])
  }

  function draw() {
    const { width, height, dpr } = resizeCanvasForDisplay(canvas)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = COLORS.background
    ctx.fillRect(0, 0, width, height)
    drawImage(width, height)
    drawGrid(width, height)
    regions.forEach((region, i) => {
      if (i === selected) return
      drawBox(region, width, height, { stroke: COLORS.box, lineWidth: 1, dash: [4, 3] })
    })
    if (selected !== -1 && regions[selected]) drawBox(regions[selected], width, height, { stroke: COLORS.selected, lineWidth: 2 })
    if (drag?.kind === 'create') {
      drawBox(regionFromCorners(drag.from, drag.to, view), width, height, { stroke: COLORS.draft, lineWidth: 1 })
    }
    if (status) {
      ctx.fillStyle = COLORS.dim
      ctx.font = '12px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(status, width / 2, height / 2)
      ctx.textAlign = 'start'
    }
  }

  function getRegions() {
    return normalizeRegions(regions)
  }

  canvas.tabIndex = 0
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('contextmenu', onContextMenu)
  canvas.addEventListener('keydown', onKeyDown)
  const resizeObserver = new ResizeObserver(() => draw())
  resizeObserver.observe(canvas)

  return {
    setView(start, end) {
      if (!(end > start)) return
      view = { start, end }
      draw()
    },
    // spec: the app's getSpectrogram() result, or null. `message` shows in
    // place of the image (loading / error).
    setSpectrogram(spec, message = '') {
      status = message
      image = null
      if (spec?.values?.length === spec?.columns * spec?.rows) {
        const off = document.createElement('canvas')
        off.width = spec.columns
        off.height = spec.rows
        const data = off.getContext('2d').createImageData(spec.columns, spec.rows)
        for (let c = 0; c < spec.columns; c++) {
          for (let r = 0; r < spec.rows; r++) {
            const [red, green, blue] = spectrogramColor(spec.values[c * spec.rows + r])
            const i = ((spec.rows - 1 - r) * spec.columns + c) * 4
            data.data[i] = red
            data.data[i + 1] = green
            data.data[i + 2] = blue
            data.data[i + 3] = 255
          }
        }
        off.getContext('2d').putImageData(data, 0, 0)
        image = off
      }
      draw()
    },
    // Size to ask the app for: one column per CSS pixel, rows to match the
    // canvas's device-pixel height (both capped by the app).
    requestSize() {
      const rect = size()
      const dpr = window.devicePixelRatio || 1
      return {
        columns: Math.min(2000, Math.max(16, Math.round(rect.width))),
        rows: Math.min(512, Math.max(16, Math.round(rect.height * dpr)))
      }
    },
    setRegions(list) {
      regions = normalizeRegions(list)
      if (selected >= regions.length) select(-1)
      draw()
    },
    getRegions,
    getSelectedIndex: () => selected,
    getSelected: () => (selected === -1 ? null : { ...regions[selected] }),
    setSelectedReduction(db) {
      if (selected === -1) return
      regions[selected] = { ...regions[selected], reductionDb: db }
      emitChange()
    },
    removeSelected() {
      if (selected !== -1) removeAt(selected)
    },
    clear() {
      if (regions.length === 0) return
      regions = []
      select(-1)
      emitChange()
      draw()
    },
    onChange(cb) {
      changeListeners.push(cb)
    },
    onSelect(cb) {
      selectListeners.push(cb)
    },
    redraw: draw,
    destroy() {
      resizeObserver.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('keydown', onKeyDown)
    }
  }
}

function round2(n) {
  return Math.round(n * 100) / 100
}
