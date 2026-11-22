import { PALETTE, withAlpha } from '../domain/palette.js'
import { resizeCanvasForDisplay } from '../audio/waveform.js'
import { createMarkerLayer } from './markerLayer.js'
import { CURVE_STEPS, MAX_HANDLES, flattenHandles } from '../audio/spectralRepairDsp.js'
import { BRUSH_R_DEFAULT, BRUSH_R_MAX, BRUSH_R_MIN, commitMask, handleAt, newMask, raster, regionFromHandles, stampLine } from '../domain/repairBrush.js'
import {
  DEFAULT_REDUCTION_DB,
  MAX_HZ,
  MIN_HZ,
  hzToY,
  isUsableRegion,
  MIN_NOISE_SEC,
  moveNoiseBand,
  noiseBand,
  normalizeRegions,
  pointInShape,
  regionFromCorners,
  secToX,
  spectrogramColor,
  visibleNoiseBand,
  xToSec,
  yToHz
} from '../domain/spectralLayout.js'

// Spectral repair panel: the loop region's spectrogram (fetched from the app,
// src/main/ffmpeg/spectrogram.js) with the user's repair shapes drawn over it.
// Tools (as in the approved brush mock): Select (V) drags a shape or its
// handles, double-click on the outline adds a handle, Delete removes the picked
// handle or shape; Box (R) drags a rectangle; Lasso (L) draws a loop and Brush
// (B, [ ] sets the size, Alt cuts) paints, both turned into a smooth shape of
// at most 14 handles by domain/repairBrush.js (a brush stroke merges into every
// shape it touches); Noise sample (N). Ctrl+Z / Ctrl+Y undo and redo shape edits.
// Shapes are in absolute file seconds + Hz, the form the app bakes
// (spectralRepair.js): a Brush/Lasso shape is its handles (the shared DSP joins
// them with one smooth curve, drawn here from the same code), an older freehand
// shape is its polygon. Bake-only: nothing here touches live audio.
//
// The Noise sample tool (Repair tab) drags a time band across every frequency:
// the stretch that is noise only, which Noise reduction learns from. Its
// edges have handles; the band is in absolute file seconds, like the fields.

const EDGE_HIT_PX = 6
const NOISE_EDGE_HIT_PX = 8
const NOISE_HANDLE = { w: 8, h: 24 }
const VERTEX_HIT_PX = 8
const LASSO_STEP_PX = 4
const ADD_HANDLE_PX = 10 // a double-click this near the outline adds a handle
const UNDO_LIMIT = 100
const TOOLS = ['select', 'box', 'lasso', 'brush', 'noise']
const TOOL_KEYS = { v: 'select', r: 'box', l: 'lasso', b: 'brush', n: 'noise' }
const GRID_HZ = [100, 1000, 10000]
const COLORS = {
  background: PALETTE.surface,
  grid: 'rgba(255, 255, 255, 0.12)',
  label: PALETTE.text,
  dim: PALETTE.textDim,
  boxFill: withAlpha(PALETTE.accent, 0.16),
  boxFillOn: withAlpha(PALETTE.accent, 0.26),
  box: 'rgba(255, 255, 255, 0.7)',
  selected: PALETTE.accent,
  draft: 'rgba(255, 255, 255, 0.9)',
  stroke: 'rgba(255, 255, 255, 0.3)',
  cutStroke: 'rgba(255, 255, 255, 0.55)',
  handle: PALETTE.surface,
  playhead: PALETTE.accent,
  noiseHatch: withAlpha(PALETTE.textDim, 0.28),
  noiseEdge: PALETTE.textDim,
  noiseHandle: PALETTE.text
}

const SELECTED_STYLE = { stroke: COLORS.selected, lineWidth: 2 }

export function createSpectralRepairController(canvas) {
  const ctx = canvas.getContext('2d')
  let view = { start: 0, end: 1 }
  let image = null // offscreen canvas holding the spectrogram at 1px per cell
  let status = ''
  let regions = []
  let selected = -1
  let selectedHandle = -1 // the picked handle of the selected shape (Select tool), -1 none
  let drag = null // { kind: 'create' | 'lasso' | 'brush' | 'move' | 'resize' | 'vertex' | 'seek' | 'noise-create' | 'noise-edge' | 'noise-move', ... }
  // The tool: 'select', 'box', 'lasso', 'brush' or the 'noise' sample band.
  let shape = 'box'
  let brushRadius = BRUSH_R_DEFAULT
  let hoverPx = null // pointer position in px, for the brush ring
  // Undo / redo of shape edits: JSON snapshots of the regions list.
  let lastJson = '[]'
  let lastRecord = { key: '', at: 0 }
  const undoStack = []
  const redoStack = []
  const toolListeners = []
  // The noise sample, { startSec, endSec } in absolute file seconds (null =
  // none), and the band being dragged right now (shown instead of it).
  let noise = null
  let draftNoise = null
  const noiseListeners = []
  // Playback needle in absolute file seconds (null = hidden), so the
  // spectrogram shows which part of the sound is playing.
  let playhead = null
  let playheadX = null
  const changeListeners = []
  const selectListeners = []
  const seekListeners = []
  const resizeListeners = []
  // Timing markers: RemixTab owns the list and pushes it in. A box edge,
  // corner or lasso point snaps to one within 8 px (Ctrl held = free).
  let onMarkersChange = () => {}
  let onMarkerEdit = () => {}
  const markerLayer = createMarkerLayer({
    onChange: (list) => onMarkersChange(list),
    onEdit: (marker, x, y) => onMarkerEdit(marker, x, y)
  })
  // The needle is 2px wide; grab it from this far either side.
  const NEEDLE_GRAB_PX = 8

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
  // The handle list a shape edits: a Brush/Lasso shape's handles, an older
  // freehand shape's points, none for a box.
  const handlesOf = (region) => region?.handles ?? region?.points ?? null
  // The shape's outline as [sec, hz] pairs (null for a box): the curve through
  // its handles (the shared DSP's own flatten), or the polygon.
  const outlineOf = (region) => (region.handles ? flattenHandles(region.handles) : region.points ?? null)

  function hitTest(p) {
    const { width, height } = size()
    // The selected shape's handles come first (Select tool).
    const sel = regions[selected]
    const own = handlesOf(sel)
    if (own) {
      for (let v = 0; v < own.length; v++) {
        const vx = secToX(own[v][0], view, width)
        const vy = hzToY(own[v][1], height)
        if (Math.hypot(p.x - vx, p.y - vy) <= VERTEX_HIT_PX) return { index: selected, edges: null, vertex: v }
      }
    }
    for (let i = regions.length - 1; i >= 0; i--) {
      const outline = outlineOf(regions[i])
      if (outline) {
        if (pointInShape(outline, p.sec, p.hz)) return { index: i, edges: null }
        continue
      }
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
    if (hit.vertex !== undefined) return 'pointer'
    if (!hit.edges) return 'move'
    const { left, right, top, bottom } = hit.edges
    if ((left && top) || (right && bottom)) return 'nwse-resize'
    if ((right && top) || (left && bottom)) return 'nesw-resize'
    return left || right ? 'ew-resize' : 'ns-resize'
  }

  function select(index) {
    selectedHandle = -1
    if (selected === index) return
    selected = index
    for (const cb of selectListeners) cb(selected)
  }

  // --- Undo / redo ---
  // Every shape edit calls record() once it is done (before it, lastJson still
  // holds the state it started from). Quick repeats of one kind (typing a dB
  // value) fold into one step.
  function record(key = '') {
    const now = Date.now()
    const fold = key && lastRecord.key === key && now - lastRecord.at < 800
    lastRecord = { key, at: now }
    if (!fold) {
      undoStack.push(lastJson)
      if (undoStack.length > UNDO_LIMIT) undoStack.shift()
    }
    redoStack.length = 0
    lastJson = JSON.stringify(regions)
    emitChange()
  }

  function restoreFrom(json) {
    regions = normalizeRegions(JSON.parse(json))
    lastJson = JSON.stringify(regions)
    lastRecord = { key: '', at: 0 }
    select(selected >= regions.length ? -1 : selected)
    selectedHandle = -1
    emitChange()
    draw()
  }

  function undo() {
    if (!undoStack.length) return
    redoStack.push(lastJson)
    restoreFrom(undoStack.pop())
  }

  function redo() {
    if (!redoStack.length) return
    undoStack.push(lastJson)
    restoreFrom(redoStack.pop())
  }

  function frame() {
    const { width, height } = size()
    return { view, W: width, H: height }
  }

  function setTool(mode) {
    const next = mode === 'free' ? 'lasso' : TOOLS.includes(mode) ? mode : 'box'
    if (next === shape) return
    shape = next
    drag = null
    canvas.style.cursor = shape === 'noise' ? 'col-resize' : shape === 'brush' ? 'none' : shape === 'select' ? 'default' : 'crosshair'
    for (const cb of toolListeners) cb(shape)
    draw()
  }

  const markerTimeToX = (t) => secToX(t, view, size().width)
  function markerAt(p) {
    return markerLayer.getMarkers().length ? markerLayer.hitTag(p.x, p.y, markerTimeToX) : null
  }
  // The point with its time snapped to a marker (and the layer told which).
  function snapPoint(p, event) {
    const rect = size()
    const snapped = markerLayer.snap(p.sec, (view.end - view.start) / rect.width, !event.ctrlKey)
    markerLayer.setSnapped(snapped.marker)
    return snapped.marker ? { ...p, sec: snapped.time } : p
  }

  function emitChange() {
    for (const cb of changeListeners) cb(getRegions())
  }

  const nearNeedle = (p) => playheadX !== null && Math.abs(p.x - playheadX) <= NEEDLE_GRAB_PX

  function seekTo(p) {
    const sec = Math.min(Math.max(p.sec, view.start), view.end)
    for (const cb of seekListeners) cb(sec)
  }

  // --- Noise sample band ---
  // The band as drawn: the dragged draft, else the stored sample clipped to
  // the shown window. Edges clipped by the window have no handle.
  function shownNoise() {
    const band = draftNoise ?? noise
    const vis = band && visibleNoiseBand(band.startSec, band.endSec, view)
    if (!vis) return null
    return { ...vis, clippedStart: band.startSec < view.start, clippedEnd: band.endSec > view.end }
  }

  // What the point grabs on the band: an edge handle, or (Noise sample tool
  // only) an edge anywhere along its height, or the body to move it.
  function noiseHit(p) {
    const band = shownNoise()
    if (!band) return null
    const { width, height } = size()
    const x0 = secToX(band.startSec, view, width)
    const x1 = secToX(band.endSec, view, width)
    const toolOn = shape === 'noise'
    const onHandleRow = Math.abs(p.y - height / 2) <= NOISE_HANDLE.h / 2 + 4
    const near = (x) => Math.abs(p.x - x) <= NOISE_EDGE_HIT_PX && (toolOn || onHandleRow)
    if (!band.clippedStart && near(x0)) return { kind: 'edge', edge: 'start' }
    if (!band.clippedEnd && near(x1)) return { kind: 'edge', edge: 'end' }
    if (toolOn && p.x > x0 && p.x < x1) return { kind: 'body' }
    return null
  }

  function emitNoise(band, final) {
    for (const cb of noiseListeners) cb({ startSec: band.startSec, endSec: band.endSec, final })
  }

  function onPointerDown(event) {
    if (event.button !== 0) return
    canvas.focus()
    const p = pointAt(event)
    const tag = markerAt(p)
    if (tag) {
      const timeAt = (clientX) => xToSec(clientX - size().left, view, size().width)
      markerLayer.startDrag(event, tag, { timeAt, duration: view.end, redraw: draw })
      return
    }
    if (nearNeedle(p)) {
      canvas.setPointerCapture(event.pointerId)
      drag = { kind: 'seek' }
      seekTo(p)
      return
    }
    const nh = noiseHit(p)
    if (nh) {
      canvas.setPointerCapture(event.pointerId)
      drag = nh.kind === 'edge' ? { kind: 'noise-edge', edge: nh.edge, original: { ...noise } } : { kind: 'noise-move', from: p, original: { ...noise } }
      draw()
      return
    }
    if (shape === 'noise') {
      canvas.setPointerCapture(event.pointerId)
      select(-1)
      drag = { kind: 'noise-create', from: snapPoint(p, event) }
      draw()
      return
    }
    canvas.setPointerCapture(event.pointerId)
    if (shape === 'select') {
      const hit = hitTest(p)
      if (hit && hit.vertex !== undefined) {
        selectedHandle = hit.vertex
        drag = { kind: 'vertex', index: hit.index, vertex: hit.vertex, original: JSON.parse(JSON.stringify(regions[hit.index])) }
      } else if (hit) {
        select(hit.index)
        drag = { kind: hit.edges ? 'resize' : 'move', index: hit.index, edges: hit.edges, from: p, original: JSON.parse(JSON.stringify(regions[hit.index])) }
      } else select(-1)
    } else if (shape === 'brush') {
      select(selected) // keeps the pick, drops a picked handle
      drag = { kind: 'brush', mask: newMask(), pts: [p], cut: event.altKey }
      stampLine(drag.mask, [p.x / size().width, p.y / size().height], [p.x / size().width, p.y / size().height], brushRadius, frame())
    } else if (shape === 'lasso') {
      drag = { kind: 'lasso', pts: [p] }
    } else {
      const from = snapPoint(p, event)
      drag = { kind: 'create', from, to: from }
    }
    draw()
  }

  function onPointerMove(event) {
    const p = pointAt(event)
    hoverPx = p
    if (!drag) {
      const nh = noiseHit(p)
      const free = shape === 'select' ? cursorFor(hitTest(p)) : shape === 'brush' ? 'none' : shape === 'noise' ? 'col-resize' : 'crosshair'
      canvas.style.cursor = markerAt(p) ? 'grab' : nearNeedle(p) ? 'ew-resize' : nh ? (nh.kind === 'edge' ? 'ew-resize' : 'move') : free
      if (shape === 'brush') draw()
      return
    }
    if (drag.kind === 'seek') {
      seekTo(p)
      return
    }
    markerLayer.setSnapped(null)
    if (drag.kind === 'noise-create' || drag.kind === 'noise-edge' || drag.kind === 'noise-move') {
      let band = null
      if (drag.kind === 'noise-create') {
        band = noiseBand(drag.from.sec, snapPoint(p, event).sec, view)
      } else if (drag.kind === 'noise-edge') {
        const o = drag.original
        const fixed = drag.edge === 'start' ? o.endSec : o.startSec
        const sec = snapPoint(p, event).sec
        // Never shorter than a click: the dragged edge stops short of the other.
        const dir = sec >= fixed ? 1 : -1
        const clamped = Math.abs(sec - fixed) < MIN_NOISE_SEC ? fixed + dir * MIN_NOISE_SEC : sec
        band = noiseBand(fixed, clamped, view)
      } else {
        band = moveNoiseBand(drag.original, p.sec - drag.from.sec, view)
      }
      draftNoise = band
      if (band) {
        emitNoise(band, false)
        drag.live = true
      }
      draw()
      return
    }
    if (drag.kind === 'brush') {
      const { width, height } = size()
      const last = drag.pts[drag.pts.length - 1]
      stampLine(drag.mask, [last.x / width, last.y / height], [p.x / width, p.y / height], brushRadius, frame())
      drag.pts.push(p)
    } else if (drag.kind === 'lasso') {
      const last = drag.pts[drag.pts.length - 1]
      if (Math.hypot(p.x - last.x, p.y - last.y) >= LASSO_STEP_PX) drag.pts.push(p)
    } else if (drag.kind === 'vertex') {
      const o = drag.original
      const sec = Math.min(Math.max(snapPoint(p, event).sec, view.start), view.end)
      const hz = Math.min(Math.max(p.hz, MIN_HZ), MAX_HZ)
      if (o.handles) {
        const handles = o.handles.map((q) => [q[0], q[1]])
        handles[drag.vertex] = [Math.round(sec * 1e4) / 1e4, Math.round(hz * 100) / 100]
        regions[drag.index] = regionFromHandles(handles, o.reductionDb)
      } else {
        const pts = o.points.map((q) => [q[0], q[1]])
        pts[drag.vertex] = [sec, hz]
        regions[drag.index] = { ...o, ...boundsOf(pts), points: pts.map((q) => [round2(q[0]), Math.round(q[1])]) }
      }
    } else if (drag.kind === 'create') {
      drag.to = snapPoint(p, event)
    } else if (drag.kind === 'move') {
      const o = drag.original
      const length = o.endSec - o.startSec
      let start = o.startSec + (p.sec - drag.from.sec)
      // Snap whichever end of the box lands nearer a marker.
      const rectW = size().width
      const spp = (view.end - view.start) / rectW
      const sa = markerLayer.snap(start, spp, !event.ctrlKey)
      const sb = markerLayer.snap(start + length, spp, !event.ctrlKey)
      markerLayer.setSnapped(sa.marker || sb.marker)
      if (sa.marker) start = sa.time
      else if (sb.marker) start = sb.time - length
      start = Math.min(Math.max(start, view.start), view.end - length)
      // Move in log-Hz so a box keeps its shape on screen.
      const ratio = o.highHz / o.lowHz
      let low = o.lowHz * (p.hz / drag.from.hz)
      low = Math.min(Math.max(low, MIN_HZ), MAX_HZ / ratio)
      const moved = { ...o, startSec: round2(start), endSec: round2(start + length), lowHz: Math.round(low), highHz: Math.round(low * ratio) }
      if (o.points) {
        const dSec = start - o.startSec
        const mul = low / o.lowHz
        moved.points = o.points.map((q) => [round2(q[0] + dSec), Math.round(Math.min(Math.max(q[1] * mul, MIN_HZ), MAX_HZ))])
      }
      if (o.handles) {
        const dSec = start - o.startSec
        const mul = low / o.lowHz
        const shifted = o.handles.map((q) => [
          Math.min(Math.max(Math.round((q[0] + dSec) * 1e4) / 1e4, view.start), view.end),
          Math.min(Math.max(Math.round(q[1] * mul * 100) / 100, MIN_HZ), MAX_HZ)
        ])
        regions[drag.index] = regionFromHandles(shifted, o.reductionDb)
      } else regions[drag.index] = moved
    } else {
      const o = drag.original
      const e = drag.edges
      const ps = e.left || e.right ? snapPoint(p, event).sec : p.sec
      const a = { sec: e.left ? ps : o.startSec, hz: e.bottom ? p.hz : o.lowHz }
      const b = { sec: e.right ? ps : o.endSec, hz: e.top ? p.hz : o.highHz }
      regions[drag.index] = regionFromCorners(a, b, view, o.reductionDb)
    }
    draw()
  }

  function onPointerUp(event) {
    if (!drag) return
    markerLayer.setSnapped(null)
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    const finished = drag
    drag = null
    if (finished.kind === 'seek') return
    if (finished.kind === 'noise-create' || finished.kind === 'noise-edge' || finished.kind === 'noise-move') {
      const band = draftNoise
      draftNoise = null
      // A click (no band) changes nothing; a drag that ended on a valid band commits it.
      if (band) {
        noise = band
        emitNoise(band, true)
      } else if (finished.live && noise) {
        emitNoise(noise, false) // the fields followed the drag; put them back
      }
      draw()
      return
    }
    if (finished.kind === 'brush' || finished.kind === 'lasso') {
      const { width, height } = size()
      let mask = finished.mask
      let op = finished.cut ? 'cut' : 'merge'
      if (finished.kind === 'lasso') {
        if (finished.pts.length < 3) return draw()
        mask = raster(finished.pts.map((q) => [q.x / width, q.y / height]))
        op = 'new'
      }
      const result = commitMask(regions, selected, mask, op, frame(), DEFAULT_REDUCTION_DB)
      if (result.changed) {
        regions = result.regions
        select(result.selected)
        record()
      }
    } else if (finished.kind === 'create') {
      const region = regionFromCorners(finished.from, finished.to, view)
      if (isUsableRegion(region)) {
        regions.push(region)
        select(regions.length - 1)
        record()
      }
    } else if (!isUsableRegion(regions[finished.index])) {
      regions[finished.index] = finished.original // resized to nothing: undo
    } else if (JSON.stringify(regions[finished.index]) !== JSON.stringify(finished.original)) {
      record()
    }
    draw()
  }

  function onDoubleClick(event) {
    const p = pointAt(event)
    const tag = markerAt(p)
    if (tag) {
      markerLayer.edit(tag, event.clientX, event.clientY)
      return
    }
    // Select tool: double-click on the selected shape's outline adds a handle there.
    const sel = regions[selected]
    const own = handlesOf(sel)
    if (shape !== 'select' || !own || own.length >= MAX_HANDLES) return
    const { width, height } = size()
    const outline = outlineOf(sel)
    const perHandle = sel.handles ? CURVE_STEPS : 1
    let best = -1
    let bestDist = ADD_HANDLE_PX
    // Closest outline vertex within reach; its segment is the one to split.
    outline.forEach(([sec, hz], i) => {
      const d = Math.hypot(secToX(sec, view, width) - p.x, hzToY(hz, height) - p.y)
      if (d < bestDist) {
        bestDist = d
        best = Math.floor(i / perHandle)
      }
    })
    if (best < 0) return
    const at = handleAt(p.x, p.y, frame())
    if (sel.handles) {
      const handles = sel.handles.map((q) => [q[0], q[1]])
      handles.splice(best + 1, 0, at)
      regions[selected] = regionFromHandles(handles, sel.reductionDb)
    } else {
      const pts = sel.points.map((q) => [q[0], q[1]])
      pts.splice(best + 1, 0, [round2(at[0]), Math.round(at[1])])
      regions[selected] = { ...sel, ...boundsOf(pts), points: pts }
    }
    selectedHandle = best + 1
    record()
    draw()
  }

  function onContextMenu(event) {
    const tag = markerAt(pointAt(event))
    if (tag) {
      event.preventDefault()
      markerLayer.edit(tag, event.clientX, event.clientY)
      return
    }
    const hit = hitTest(pointAt(event))
    if (!hit) return
    event.preventDefault()
    removeAt(hit.index)
  }

  function onKeyDown(event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      event.preventDefault()
      event.stopPropagation()
      if (key === 'y' || event.shiftKey) redo()
      else undo()
      return
    }
    if (event.key === 'Escape' && selected !== -1) {
      select(-1)
      draw()
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== -1) {
      event.preventDefault()
      event.stopPropagation()
      const own = handlesOf(regions[selected])
      if (selectedHandle >= 0 && own) {
        if (own.length <= 3) return // a shape keeps at least 3 handles
        removeHandle(selected, selectedHandle)
        return
      }
      removeAt(selected)
    }
  }

  // Tool letters and the brush size keys work anywhere on the page while the
  // Repair view is shown, except in a field or menu.
  function onDocumentKeyDown(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !canvas.isConnected || size().width < 40) return
    const t = event.target
    if (t instanceof Element && (t.closest('input, textarea, select, [contenteditable], [role="listbox"], [role="menu"]') || t.isContentEditable)) return
    const key = event.key.toLowerCase()
    if (key === '[' || key === ']') {
      brushRadius = Math.max(BRUSH_R_MIN, Math.min(BRUSH_R_MAX, brushRadius + (key === ']' ? 4 : -4)))
      for (const cb of toolListeners) cb(shape)
      draw()
    } else if (TOOL_KEYS[key]) setTool(TOOL_KEYS[key])
  }

  function removeHandle(index, handle) {
    const sel = regions[index]
    if (sel.handles) {
      regions[index] = regionFromHandles(sel.handles.filter((_, i) => i !== handle), sel.reductionDb)
    } else {
      const pts = sel.points.filter((_, i) => i !== handle)
      regions[index] = { ...sel, ...boundsOf(pts), points: pts }
    }
    selectedHandle = -1
    record()
    draw()
  }

  function removeAt(index) {
    regions.splice(index, 1)
    select(-1)
    record()
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

  // A shape: its outline (the handles' curve, or the older polygon), filled;
  // with the Select tool the picked shape also shows its handles.
  function drawShape(region, width, height, style, handles) {
    ctx.beginPath()
    outlineOf(region).forEach(([sec, hz], i) => {
      const x = secToX(sec, view, width)
      const y = hzToY(hz, height)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.fillStyle = style === SELECTED_STYLE ? COLORS.boxFillOn : COLORS.boxFill
    ctx.fill()
    ctx.strokeStyle = style.stroke
    ctx.lineWidth = style.lineWidth
    ctx.setLineDash(style.dash ?? [])
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.setLineDash([])
    if (handles) {
      handlesOf(region).forEach(([sec, hz], i) => {
        ctx.beginPath()
        ctx.arc(secToX(sec, view, width), hzToY(hz, height), 5, 0, Math.PI * 2)
        ctx.fillStyle = i === selectedHandle ? COLORS.selected : COLORS.handle
        ctx.fill()
        ctx.strokeStyle = COLORS.selected
        ctx.lineWidth = 2
        ctx.stroke()
      })
    }
  }

  function drawBox(region, width, height, style) {
    if (handlesOf(region)) return drawShape(region, width, height, style, style === SELECTED_STYLE && shape === 'select')
    const b = boxRect(region, width, height)
    ctx.fillStyle = COLORS.boxFill
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0)
    ctx.strokeStyle = style.stroke
    ctx.lineWidth = style.lineWidth
    ctx.setLineDash(style.dash ?? [])
    ctx.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0 - 1, b.y1 - b.y0 - 1)
    ctx.setLineDash([])
  }

  // The noise sample: a hatched full-height band, an outline, and a handle on
  // each edge that is really the band's edge (as in the approved mock).
  function drawNoiseBand(width, height) {
    const band = shownNoise()
    if (!band) return
    const x0 = secToX(band.startSec, view, width)
    const x1 = secToX(band.endSec, view, width)
    ctx.save()
    ctx.beginPath()
    ctx.rect(x0, 0, x1 - x0, height)
    ctx.clip()
    ctx.strokeStyle = COLORS.noiseHatch
    ctx.lineWidth = 3
    for (let x = x0 - height; x < x1; x += 8) {
      ctx.beginPath()
      ctx.moveTo(x, height)
      ctx.lineTo(x + height, 0)
      ctx.stroke()
    }
    ctx.restore()
    ctx.strokeStyle = COLORS.noiseEdge
    ctx.lineWidth = 1.5
    ctx.strokeRect(x0 + 0.75, 0.75, x1 - x0 - 1.5, height - 1.5)
    ctx.fillStyle = COLORS.noiseHandle
    for (const [x, clipped] of [[x0, band.clippedStart], [x1, band.clippedEnd]]) {
      if (clipped) continue
      ctx.beginPath()
      ctx.roundRect(x - NOISE_HANDLE.w / 2, (height - NOISE_HANDLE.h) / 2, NOISE_HANDLE.w, NOISE_HANDLE.h, 3)
      ctx.fill()
    }
  }

  function draw() {
    const { width, height, dpr } = resizeCanvasForDisplay(canvas)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = COLORS.background
    ctx.fillRect(0, 0, width, height)
    drawImage(width, height)
    drawGrid(width, height)
    drawNoiseBand(width, height)
    regions.forEach((region, i) => {
      if (i === selected) return
      drawBox(region, width, height, { stroke: COLORS.box, lineWidth: 1, dash: [4, 3] })
    })
    if (selected !== -1 && regions[selected]) drawBox(regions[selected], width, height, SELECTED_STYLE)
    if (drag?.kind === 'lasso' && drag.pts.length > 1) {
      ctx.beginPath()
      drag.pts.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)))
      ctx.strokeStyle = COLORS.draft
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (drag?.kind === 'brush') {
      ctx.save()
      ctx.beginPath()
      drag.pts.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)))
      if (drag.pts.length === 1) ctx.lineTo(drag.pts[0].x + 0.01, drag.pts[0].y)
      ctx.strokeStyle = drag.cut ? COLORS.cutStroke : COLORS.stroke
      ctx.lineWidth = brushRadius * 2
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      if (drag.cut) ctx.setLineDash([2, 6])
      ctx.stroke()
      ctx.restore()
    }
    if (shape === 'brush' && hoverPx && !drag?.kind?.startsWith('noise') && drag?.kind !== 'seek') {
      ctx.beginPath()
      ctx.arc(hoverPx.x, hoverPx.y, brushRadius, 0, Math.PI * 2)
      ctx.strokeStyle = COLORS.draft
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (drag?.kind === 'create') {
      drawBox(regionFromCorners(drag.from, drag.to, view), width, height, { stroke: COLORS.draft, lineWidth: 1 })
    }
    markerLayer.draw(ctx, { width, height, timeToX: (t) => secToX(t, view, width) })
    playheadX = null
    if (playhead !== null && playhead >= view.start && playhead <= view.end) {
      playheadX = Math.round(secToX(playhead, view, width))
      ctx.fillStyle = COLORS.playhead
      ctx.fillRect(playheadX - 1, 0, 2, height)
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
  canvas.addEventListener('dblclick', onDoubleClick)
  canvas.addEventListener('keydown', onKeyDown)
  const onPointerLeave = () => {
    hoverPx = null
    if (shape === 'brush') draw()
  }
  canvas.addEventListener('pointerleave', onPointerLeave)
  document.addEventListener('keydown', onDocumentKeyDown)
  const resizeObserver = new ResizeObserver(() => {
    draw()
    for (const cb of resizeListeners) cb()
  })
  resizeObserver.observe(canvas)

  return {
    // Called every animation frame while a preview plays; redraws only when
    // the needle moves to a new pixel (or shows/hides).
    setPlayhead(sec) {
      playhead = Number.isFinite(sec) ? sec : null
      const visible = playhead !== null && playhead >= view.start && playhead <= view.end
      const x = visible ? Math.round(secToX(playhead, view, size().width)) : null
      if (x !== playheadX) draw()
    },
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
    // Hidden (or not laid out yet): too small to ask for a real image.
    isShown() {
      return size().width >= 40 && size().height >= 40
    },
    requestSize() {
      const rect = size()
      const dpr = window.devicePixelRatio || 1
      return {
        columns: Math.min(2000, Math.max(16, Math.round(rect.width))),
        rows: Math.min(512, Math.max(16, Math.round(rect.height * dpr)))
      }
    },
    // The list from outside (a sound loaded, a preset picked): an edit made
    // here comes back equal and keeps the undo steps; anything else starts over.
    setRegions(list) {
      regions = normalizeRegions(list)
      const json = JSON.stringify(regions)
      if (json !== lastJson) {
        undoStack.length = 0
        redoStack.length = 0
        lastJson = json
      }
      if (selected >= regions.length) select(-1)
      draw()
    },
    // 'select', 'box', 'lasso', 'brush' (paint round the sound) or 'noise' (drag
    // a time band: the noise sample). 'free' is the old name of 'lasso'.
    setShape: setTool,
    getShape: () => shape,
    getBrushRadius: () => brushRadius,
    undo,
    redo,
    // Fired with the tool name when the tool (or the brush size) changes,
    // including from the keyboard.
    onToolChange(cb) {
      toolListeners.push(cb)
    },
    // The noise sample in absolute file seconds, or null/empty for none.
    // Never calls the listeners (the fields are the source of truth).
    setNoiseSample(startSec, endSec) {
      noise = Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec ? { startSec, endSec } : null
      draw()
    },
    getNoiseSample: () => (noise ? { ...noise } : null),
    // Fired with { startSec, endSec, final } while the band is dragged
    // (final: false) and when the drag ends (final: true).
    onNoiseChange(cb) {
      noiseListeners.push(cb)
    },
    getRegions,
    getSelectedIndex: () => selected,
    getSelected: () => (selected === -1 ? null : { ...regions[selected] }),
    setSelectedReduction(db) {
      if (selected === -1) return
      regions[selected] = { ...regions[selected], reductionDb: db }
      record('reduction' + selected)
    },
    removeSelected() {
      if (selected !== -1) removeAt(selected)
    },
    clear() {
      if (regions.length === 0) return
      regions = []
      select(-1)
      record()
      draw()
    },
    onChange(cb) {
      changeListeners.push(cb)
    },
    onSelect(cb) {
      selectListeners.push(cb)
    },
    // Fired with absolute file seconds while the needle is dragged.
    onSeek(cb) {
      seekListeners.push(cb)
    },
    // Fired when the canvas changes size, including when its tab is first shown
    // (it is display:none until then, so its size is 0).
    onResize(cb) {
      resizeListeners.push(cb)
    },
    // Markers (see the layer above): the list is RemixTab's, pushed in here.
    setMarkers(list) {
      markerLayer.setMarkers(list)
      draw()
    },
    selectMarker(id) {
      markerLayer.select(id)
      draw()
    },
    onMarkersChange(cb) {
      onMarkersChange = cb
    },
    onMarkerEdit(cb) {
      onMarkerEdit = cb
    },
    redraw: draw,
    destroy() {
      resizeObserver.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('dblclick', onDoubleClick)
      canvas.removeEventListener('keydown', onKeyDown)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      document.removeEventListener('keydown', onDocumentKeyDown)
    }
  }
}

function boundsOf(pts) {
  const secs = pts.map((q) => q[0])
  const hzs = pts.map((q) => q[1])
  return { startSec: round2(Math.min(...secs)), endSec: round2(Math.max(...secs)), lowHz: Math.round(Math.min(...hzs)), highHz: Math.round(Math.max(...hzs)) }
}

function round2(n) {
  return Math.round(n * 100) / 100
}
