// The Repair brush, as plain functions (no DOM): ported from the approved mock
// (design-system mock-noctivago-repair-brush.html in the Global Management repo).
//
// Merge by painting a mask, not polygon math: the stroke and the shapes it
// touches are painted onto a time x log-Hz grid (GW x GH cells over the shown
// window), joined (or cut), rounded (close then open, about 8 px, so there are
// no sharp notches or corners), and the outer outline is traced back out (holes
// are filled on purpose, specks under 8 cells dropped). The outline is smoothed
// and 6 to 14 handles are spaced evenly along it (about one per 45 px). A
// shape saves just those handles; the shared DSP (src/audio/spectralRepairDsp.js,
// the app keeps the same file) joins them with a closed centripetal Catmull-Rom
// curve with control points clamped to the handles' bounds, so what is drawn,
// what you hear live and what gets saved are one curve.
//
// Everything works in a "frame": { view: { start, end } (shown seconds), W, H
// (canvas size in px) }. u runs 0..1 across the view, v runs 0..1 from 20 kHz
// down to 30 Hz (the canvas's log-Hz scale, spectralLayout.js).
import { flattenHandles } from '../audio/spectralRepairDsp.js'
import { MAX_HZ, MIN_HZ, hzToY, isUsableRegion, yToHz } from './spectralLayout.js'

export const GW = 220
export const GH = 85
export const MIN_HANDLES = 6
export const MAX_BRUSH_HANDLES = 14
export const HANDLE_SPACING_PX = 45
export const MIN_BLOB_CELLS = 8
export const BRUSH_R_MIN = 6
export const BRUSH_R_MAX = 48
export const BRUSH_R_DEFAULT = 20

const c01 = (x) => Math.max(0, Math.min(1, x))
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

export const secToU = (sec, frame) => (sec - frame.view.start) / (frame.view.end - frame.view.start)
export const uToSec = (u, frame) => frame.view.start + u * (frame.view.end - frame.view.start)
export const hzToV = (hz) => hzToY(hz, 1)
export const vToHz = (v) => yToHz(v, 1)

// The shape's outline as a polygon of [u, v]: a box's corners, an older
// freehand polygon's points, or a Brush/Lasso shape's curve (made by the same
// code the DSP uses).
export function polygonUV(region, frame) {
  let pts
  if (Array.isArray(region.handles) && region.handles.length >= 3) pts = flattenHandles(region.handles)
  else if (Array.isArray(region.points) && region.points.length >= 3) pts = region.points
  else pts = [[region.startSec, region.highHz], [region.endSec, region.highHz], [region.endSec, region.lowHz], [region.startSec, region.lowHz]]
  return pts.map(([sec, hz]) => [secToU(sec, frame), hzToV(hz)])
}

// Mask grid (time x log-Hz), filled by scanlines.
export function raster(poly) {
  const g = new Uint8Array(GW * GH)
  for (let j = 0; j < GH; j++) {
    const v = (j + 0.5) / GH
    const xs = []
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % n]
      if (a[1] <= v !== b[1] <= v) xs.push(a[0] + ((v - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
    }
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] * GW - 0.5))
      const i1 = Math.min(GW - 1, Math.floor(xs[k + 1] * GW - 0.5))
      for (let i = i0; i <= i1; i++) g[j * GW + i] = 1
    }
  }
  return g
}

export const maskOf = (region, frame) => raster(polygonUV(region, frame))

export function newMask() {
  return new Uint8Array(GW * GH)
}

// One brush dab (an ellipse of radius brushR px) at (u, v).
export function stamp(g, u, v, brushR, frame) {
  const rx = brushR / frame.W
  const ry = brushR / frame.H
  const i0 = Math.max(0, Math.floor((u - rx) * GW))
  const i1 = Math.min(GW - 1, Math.ceil((u + rx) * GW))
  const j0 = Math.max(0, Math.floor((v - ry) * GH))
  const j1 = Math.min(GH - 1, Math.ceil((v + ry) * GH))
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const du = ((i + 0.5) / GW - u) / rx
      const dv = ((j + 0.5) / GH - v) / ry
      if (du * du + dv * dv <= 1) g[j * GW + i] = 1
    }
  }
}

// A stroke from (u0, v0) to (u1, v1): dabs a third of a radius apart.
export function stampLine(g, from, to, brushR, frame) {
  const steps = Math.max(1, Math.ceil(Math.hypot((to[0] - from[0]) * frame.W, (to[1] - from[1]) * frame.H) / (brushR / 3)))
  for (let k = 1; k <= steps; k++) stamp(g, from[0] + ((to[0] - from[0]) * k) / steps, from[1] + ((to[1] - from[1]) * k) / steps, brushR, frame)
}

// Round the mask: close (fills sharp notches where shapes join) then open
// (rounds sharp outer corners). Radius about 8 px.
function morph(g, dil, frame) {
  const rx = Math.max(1, Math.round(8 / (frame.W / GW)))
  const ry = Math.max(1, Math.round(8 / (frame.H / GH)))
  const out = new Uint8Array(g.length)
  const stop = dil ? 0 : 1
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      let v = stop
      for (let dy = -ry; dy <= ry && v === stop; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
          if ((dx / rx) ** 2 + (dy / ry) ** 2 > 1) continue
          const x = i + dx
          const y = j + dy
          if (x < 0 || y < 0 || x >= GW || y >= GH) continue // the view edge never eats into a shape
          if (dil && g[y * GW + x]) {
            v = 1
            break
          }
          if (!dil && !g[y * GW + x]) {
            v = 0
            break
          }
        }
      }
      out[j * GW + i] = v
    }
  }
  return out
}
export const soften = (g, frame) => morph(morph(morph(morph(g, true, frame), false, frame), false, frame), true, frame)

// Average each outline point with its neighbours: removes the grid's stair steps before thinning.
export function smoothRing(px, half = 2, passes = 1) {
  for (let p = 0; p < passes; p++) {
    const n = px.length
    px = px.map((_, i) => {
      let x = 0
      let y = 0
      for (let k = -half; k <= half; k++) {
        const q = px[(i + k + n) % n]
        x += q[0]
        y += q[1]
      }
      return [x / (2 * half + 1), y / (2 * half + 1)]
    })
  }
  return px
}

const perimeter = (px) => px.reduce((s, p, i) => s + Math.hypot(p[0] - px[(i + 1) % px.length][0], p[1] - px[(i + 1) % px.length][1]), 0)

// Each connected blob -> its outer outline (Moore neighbour tracing; holes are
// filled by design), biggest first, in px.
const D8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
export function outlines(g, frame) {
  const lab = new Int32Array(GW * GH)
  const res = []
  let L = 0
  for (let s = 0; s < g.length; s++) {
    if (!g[s] || lab[s]) continue
    L++
    lab[s] = L
    const stack = [s]
    let count = 0
    while (stack.length) {
      const c = stack.pop()
      count++
      const ci = c % GW
      const cj = (c / GW) | 0
      for (const [dx, dy] of D8) {
        const i = ci + dx
        const j = cj + dy
        if (i < 0 || j < 0 || i >= GW || j >= GH) continue
        const k = j * GW + i
        if (g[k] && !lab[k]) {
          lab[k] = L
          stack.push(k)
        }
      }
    }
    if (count >= MIN_BLOB_CELLS) res.push({ count, px: trace(lab, L, s, frame) })
  }
  return res.sort((a, b) => b.count - a.count).map((r) => r.px)
}

function trace(lab, L, s, frame) {
  const inn = (i, j) => i >= 0 && j >= 0 && i < GW && j < GH && lab[j * GW + i] === L
  const si = s % GW
  const sj = (s / GW) | 0
  const pts = [[si, sj]]
  let ci = si
  let cj = sj
  let b = 4
  let first = -1
  for (let guard = 0; guard < GW * GH * 4; guard++) {
    let k = -1
    for (let t = 1; t <= 8; t++) {
      const d = (b + t) % 8
      if (inn(ci + D8[d][0], cj + D8[d][1])) {
        k = d
        break
      }
    }
    if (k < 0) break
    if (ci === si && cj === sj) {
      if (k === first) break
      if (first < 0) first = k
    }
    ci += D8[k][0]
    cj += D8[k][1]
    b = (k + 5) % 8
    pts.push([ci, cj])
  }
  if (pts.length > 1) pts.pop()
  return pts.map(([i, j]) => [((i + 0.5) / GW) * frame.W, ((j + 0.5) / GH) * frame.H])
}

// Handles evenly spaced along the smoothed outline (px): one per about 45 px,
// 6 to 14. Even spacing = no tight turns.
export function resampleClosed(px) {
  const perim = perimeter(px)
  const n = Math.max(MIN_HANDLES, Math.min(MAX_BRUSH_HANDLES, Math.round(perim / HANDLE_SPACING_PX)))
  const out = []
  let i = 0
  let walked = 0
  for (let k = 0; k < n; k++) {
    const target = (k * perim) / n
    for (;;) {
      const a = px[i % px.length]
      const b = px[(i + 1) % px.length]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (walked + len >= target || i > px.length * 2) {
        const t = len ? (target - walked) / len : 0
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
        break
      }
      walked += len
      i++
    }
  }
  return out
}

// A handle from a position in px: clamped to the shown window and the Hz range,
// rounded to what is worth saving (0.1 ms, 0.01 Hz), and clamped again so the
// rounding cannot leave the window.
export function handleAt(x, y, frame) {
  const sec = clamp(Math.round(uToSec(c01(x / frame.W), frame) * 1e4) / 1e4, frame.view.start, frame.view.end)
  const hz = clamp(Math.round(vToHz(c01(y / frame.H)) * 100) / 100, MIN_HZ, MAX_HZ)
  return [sec, hz]
}

// The region for a set of handles: its box is the handles' bounds.
export function regionFromHandles(handles, reductionDb) {
  const secs = handles.map((p) => p[0])
  const hzs = handles.map((p) => p[1])
  return { startSec: Math.min(...secs), endSec: Math.max(...secs), lowHz: Math.min(...hzs), highHz: Math.max(...hzs), reductionDb, handles }
}

// Every blob in the mask becomes a shape (the biggest first).
export function shapesFrom(g, reductionDb, frame) {
  // A shape thinner than the rounding (a thin lasso loop, the smallest brush)
  // would vanish in it: then it is used as drawn.
  let blobs = outlines(soften(g, frame), frame)
  if (!blobs.length) blobs = outlines(g, frame)
  return blobs
    .map((px) => regionFromHandles(resampleClosed(smoothRing(px)).map(([x, y]) => handleAt(x, y, frame)), reductionDb))
    .filter((r) => r.handles.length >= 3 && isUsableRegion(r))
}

export function touches(mask, frame) {
  return (region) => {
    const r = maskOf(region, frame)
    for (let k = 0; k < r.length; k++) if (r[k] && mask[k]) return true
    return false
  }
}

// Paints `mask` (a stroke or a lasso loop) into the shapes list.
//   'merge'  the mask and every shape it touches become one shape (the selected
//            one, if it is among them, keeps its place and level);
//   'cut'    the mask is taken out of every shape it touches (a shape cut in
//            two becomes two shapes);
//   'new'    the mask alone is a new shape;
//   'add'    Shift with Box or Lasso: the mask joins the selected shape only
//            (it keeps its place and level); with none selected it is 'new';
//   'cutSelected'  Alt with Box or Lasso: the mask is taken out of the selected
//            shape only (a box becomes a smooth shape, a split gives several,
//            nothing left removes it); with none selected nothing happens.
// Returns { regions, selected, changed }: a new list (the old one is left as
// it was), the index to select (-1 none), and whether anything happened.
export function commitMask(regions, selected, mask, op, frame, reductionDb = 40) {
  let list = regions.slice()
  let sel = selected
  if (op === 'cut' || op === 'cutSelected') {
    const hit = touches(mask, frame)
    const targets = op === 'cut' ? list.filter(hit) : regions[selected] && hit(regions[selected]) ? [regions[selected]] : []
    if (!targets.length) return { regions, selected, changed: false }
    const selectedRegion = regions[selected]
    let newSel = -2
    for (const t of targets) {
      const r = maskOf(t, frame)
      for (let k = 0; k < r.length; k++) if (mask[k]) r[k] = 0
      const made = shapesFrom(r, t.reductionDb, frame)
      const at = list.indexOf(t)
      list.splice(at, 1, ...made)
      if (t === selectedRegion) newSel = made.length ? at : -1
    }
    sel = newSel === -2 ? (selectedRegion ? list.indexOf(selectedRegion) : -1) : newSel
    return { regions: list, selected: sel, changed: true }
  }
  const targets = op === 'merge' ? list.filter(touches(mask, frame)) : op === 'add' && regions[selected] ? [regions[selected]] : []
  targets.sort((a, b) => (b === regions[selected]) - (a === regions[selected])) // the selected shape's level wins
  const u = mask.slice()
  for (const t of targets) {
    const r = maskOf(t, frame)
    for (let k = 0; k < r.length; k++) if (r[k]) u[k] = 1
  }
  const made = shapesFrom(u, targets[0] ? targets[0].reductionDb : reductionDb, frame)
  if (!made.length) return { regions, selected, changed: false }
  const at = targets.length ? Math.min(...targets.map((t) => list.indexOf(t))) : list.length
  list = list.filter((s) => !targets.includes(s))
  const insertAt = Math.min(at, list.length)
  list.splice(insertAt, 0, ...made)
  return { regions: list, selected: insertAt, changed: true }
}

// The line under the canvas: what the picked tool does (as in the mock).
export function toolHint(tool, brushR = BRUSH_R_DEFAULT) {
  const k = (s) => `<kbd>${s}</kbd>`
  const hints = {
    brush: `<span>Strokes merge into any shape they touch</span> · <span>${k('Alt')} cuts</span> · <span>${k('[')} ${k(']')} size <b>${brushR} px</b></span>`,
    select: `<span>Drag a handle or the shape</span> · <span>Double-click the outline to add a handle</span> · <span>${k('Delete')} removes</span>`,
    box: `<span>Drag a box</span> · <span>${k('Shift')} adds to the selected shape</span> · <span>${k('Alt')} cuts from it</span>`,
    lasso: `<span>Draw round the sound</span> · <span>${k('Shift')} adds to the selected shape</span> · <span>${k('Alt')} cuts from it</span>`,
    noise: '<span>Drag across a part with only noise</span> · <span>0.5 s or more works best</span>'
  }
  return hints[tool] ?? ''
}
