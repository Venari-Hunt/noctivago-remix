import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CURVE_STEPS, curveSegmentsLn, flattenHandles } from '../src/audio/spectralRepairDsp.js'
import { MAX_BRUSH_HANDLES, MIN_HANDLES, commitMask, handleAt, maskOf, newMask, polygonUV, raster, stampLine, toolHint } from '../src/domain/repairBrush.js'
import { MAX_HZ, MIN_HZ, hzToY, normalizeRegions } from '../src/domain/spectralLayout.js'

const frame = { view: { start: 0, end: 5 }, W: 880, H: 340 }
const px = (x, y) => [x / frame.W, y / frame.H]
const BRUSH = 20

// A stroke through points given in px.
function stroke(points) {
  const g = newMask()
  stampLine(g, px(...points[0]), px(...points[0]), BRUSH, frame)
  for (let i = 1; i < points.length; i++) stampLine(g, px(...points[i - 1]), px(...points[i]), BRUSH, frame)
  return g
}
const paint = (regions, selected, points, op = 'merge') => commitMask(regions, selected, stroke(points), op, frame, 40)

// A box in seconds and Hz from px corners, like the Box tool makes.
function boxAt(x0, y0, x1, y1, reductionDb = 24) {
  const sec = (x) => (x / frame.W) * 5
  const hz = (y) => MIN_HZ * Math.exp((1 - y / frame.H) * Math.log(MAX_HZ / MIN_HZ))
  return { startSec: sec(x0), endSec: sec(x1), lowHz: hz(y1), highHz: hz(y0), reductionDb }
}

function inView(region) {
  for (const [sec, hz] of region.handles) {
    assert.ok(sec >= 0 && sec <= 5, `handle sec ${sec} in the view`)
    assert.ok(hz >= MIN_HZ && hz <= MAX_HZ, `handle hz ${hz} in range`)
  }
  const ln = region.handles.map(([sec, hz]) => [sec, Math.log(hz)])
  for (const seg of curveSegmentsLn(ln)) {
    for (const [sec, lnHz] of seg) {
      assert.ok(sec >= 0 && sec <= 5, `curve point sec ${sec} in the view`)
      assert.ok(lnHz >= Math.log(MIN_HZ) - 1e-9 && lnHz <= Math.log(MAX_HZ) + 1e-9, `curve point ln hz ${lnHz} in range`)
    }
  }
  for (const [sec, hz] of flattenHandles(region.handles)) {
    assert.ok(sec >= 0 && sec <= 5 && hz >= MIN_HZ * (1 - 1e-9) && hz <= MAX_HZ * (1 + 1e-9), `flattened point ${sec}, ${hz} in range`)
  }
}

test('a stroke on empty space becomes one smooth shape of 6 to 14 handles', () => {
  const r = paint([], -1, [[200, 150], [300, 130], [420, 160], [520, 200]])
  assert.equal(r.changed, true)
  assert.equal(r.regions.length, 1)
  const s = r.regions[0]
  assert.ok(s.handles.length >= MIN_HANDLES && s.handles.length <= MAX_BRUSH_HANDLES, `handles: ${s.handles.length}`)
  assert.equal(s.reductionDb, 40)
  assert.equal(r.selected, 0)
  inView(s)
  assert.equal(flattenHandles(s.handles).length, s.handles.length * CURVE_STEPS)
})

test('a long winding stroke still has at most 14 handles', () => {
  const pts = []
  for (let i = 0; i <= 40; i++) pts.push([40 + i * 20, 170 + 110 * Math.sin(i / 3)])
  const r = paint([], -1, pts)
  assert.equal(r.regions.length, 1)
  assert.equal(r.regions[0].handles.length, MAX_BRUSH_HANDLES)
  inView(r.regions[0])
})

test('painting from one shape into another merges them into one shape, keeping the first one\'s place and level', () => {
  const a = boxAt(100, 60, 220, 140, 30)
  const b = boxAt(420, 120, 540, 220, 12)
  const first = paint([a, b], 0, [[160, 100], [300, 130], [480, 170]])
  assert.equal(first.regions.length, 1, 'two shapes and a stroke over both = one shape')
  assert.equal(first.regions[0].reductionDb, 30, 'the selected shape keeps its level')
  assert.equal(first.selected, 0)
  assert.ok(first.regions[0].handles.length >= MIN_HANDLES && first.regions[0].handles.length <= MAX_BRUSH_HANDLES)
  // The merged shape covers both old shapes' centres.
  const m = maskOf(first.regions[0], frame)
  const cell = (x, y) => m[Math.floor((y / frame.H) * 85) * 220 + Math.floor((x / frame.W) * 220)]
  assert.equal(cell(160, 100), 1)
  assert.equal(cell(480, 170), 1)
  assert.equal(cell(300, 130), 1)
})

test('a stroke that touches no shape leaves the others alone and adds one', () => {
  const a = boxAt(100, 60, 220, 140)
  const r = paint([a], 0, [[500, 250], [640, 250]])
  assert.equal(r.regions.length, 2)
  assert.equal(r.regions[0], a)
  assert.equal(r.selected, 1)
})

test('Alt cut through the middle of a shape splits it into two', () => {
  const made = paint([], -1, [[150, 170], [420, 170], [700, 170]]).regions
  assert.equal(made.length, 1)
  const cut = commitMask(made, 0, stroke([[420, 110], [420, 240]]), 'cut', frame)
  assert.equal(cut.changed, true)
  assert.equal(cut.regions.length, 2, 'cut in two = two shapes')
  assert.equal(cut.regions[0].reductionDb, 40)
  for (const s of cut.regions) inView(s)
  const [left, right] = [...cut.regions].sort((p, q) => p.startSec - q.startSec)
  assert.ok(left.endSec < right.startSec, `the two halves sit side by side: ${left.endSec} / ${right.startSec}`)
})

test('Alt cut where there is no shape changes nothing', () => {
  const a = boxAt(100, 60, 220, 140)
  const r = commitMask([a], 0, stroke([[600, 250], [700, 250]]), 'cut', frame)
  assert.equal(r.changed, false)
  assert.deepEqual(r.regions, [a])
})

test('painting past the edges keeps every handle and control point inside the view', () => {
  for (const pts of [[[-40, 100], [60, 100], [60, 300]], [[820, 20], [920, 20], [920, 120]], [[300, -30], [300, 40], [500, 40]], [[300, 380], [300, 300], [500, 300]]]) {
    const r = paint([], -1, pts.map(([x, y]) => [Math.max(0, Math.min(frame.W, x)), Math.max(0, Math.min(frame.H, y))]))
    assert.equal(r.regions.length, 1)
    inView(r.regions[0])
  }
  // Pointer positions outside the canvas clamp to its edge too.
  const [sec, hz] = handleAt(-50, 999, frame)
  assert.equal(sec, 0)
  assert.equal(hz, MIN_HZ)
})

test('a lasso loop goes through the same pipeline: a few handles, not hundreds of dots', () => {
  const loop = []
  for (let i = 0; i < 360; i++) loop.push([0.45 + 0.2 * Math.cos((i / 360) * 2 * Math.PI), 0.5 + 0.25 * Math.sin((i / 360) * 2 * Math.PI)])
  const r = commitMask([], -1, raster(loop), 'new', frame, 40)
  assert.equal(r.regions.length, 1)
  assert.ok(r.regions[0].handles.length >= MIN_HANDLES && r.regions[0].handles.length <= MAX_BRUSH_HANDLES)
  inView(r.regions[0])
})

test('old polygon shapes and boxes still turn into masks, and handles survive a save round trip', () => {
  const polygon = { startSec: 1, endSec: 2, lowHz: 1000, highHz: 3000, reductionDb: 30, points: [[1, 1000], [2, 1000], [1.5, 3000]] }
  const poly = polygonUV(polygon, frame)
  assert.equal(poly.length, 3)
  assert.ok(poly.every(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1))
  const filled = maskOf(polygon, frame).reduce((n, v) => n + v, 0)
  assert.ok(filled > 20, `the polygon paints ${filled} cells`)
  const made = paint([], -1, [[200, 150], [400, 150]]).regions
  const back = normalizeRegions(JSON.parse(JSON.stringify(made)))
  assert.deepEqual(back, made)
  assert.equal(normalizeRegions([polygon])[0].points.length, 3)
  assert.equal(normalizeRegions([polygon])[0].handles, undefined)
  assert.ok(hzToY(1000, 1) > 0)
})

// A box as a mask, the way the Box tool turns its corners into one.
const boxMask = (x0, y0, x1, y1) => maskOf(boxAt(x0, y0, x1, y1), frame)

test('Shift: a box onto the selected shape joins it into one shape that keeps its level', () => {
  const a = boxAt(100, 100, 300, 200, 30)
  const r = commitMask([a], 0, boxMask(250, 150, 450, 260), 'add', frame, 40)
  assert.equal(r.changed, true)
  assert.equal(r.regions.length, 1, 'the box joined the shape')
  assert.equal(r.regions[0].reductionDb, 30)
  assert.equal(r.selected, 0)
  assert.ok(Array.isArray(r.regions[0].handles), 'a smooth shape now')
  const m = maskOf(r.regions[0], frame)
  const cell = (x, y) => m[Math.floor((y / frame.H) * 85) * 220 + Math.floor((x / frame.W) * 220)]
  assert.equal(cell(150, 150), 1)
  assert.equal(cell(400, 230), 1)
  inView(r.regions[0])
})

test('Shift joins only the selected shape, not other shapes the box touches', () => {
  const a = boxAt(100, 100, 300, 200, 30)
  const b = boxAt(400, 100, 600, 200, 12)
  const r = commitMask([a, b], 0, boxMask(250, 120, 450, 180), 'add', frame, 40)
  assert.equal(r.regions.length, 2, 'a and the box are one; b stays its own shape')
  assert.equal(r.regions[0].reductionDb, 30)
  assert.equal(r.regions[1], b)
})

test('Shift with no selected shape acts as plain: the box is a new shape', () => {
  const r = commitMask([], -1, boxMask(250, 150, 450, 260), 'add', frame, 40)
  assert.equal(r.regions.length, 1)
  assert.equal(r.regions[0].reductionDb, 40)
})

test('Alt: a box through the middle of the selected shape splits it into two', () => {
  const a = boxAt(100, 100, 700, 200, 30)
  const r = commitMask([a], 0, boxMask(380, 60, 420, 260), 'cutSelected', frame, 40)
  assert.equal(r.changed, true)
  assert.equal(r.regions.length, 2)
  assert.equal(r.regions[0].reductionDb, 30)
  for (const s of r.regions) inView(s)
  const [left, right] = [...r.regions].sort((p, q) => p.startSec - q.startSec)
  assert.ok(left.endSec < right.startSec)
})

test('Alt: a box that covers the whole shape removes it', () => {
  const a = boxAt(100, 100, 300, 200)
  const keep = boxAt(500, 100, 600, 200)
  const r = commitMask([a, keep], 0, boxMask(60, 60, 340, 240), 'cutSelected', frame, 40)
  assert.equal(r.changed, true)
  assert.deepEqual(r.regions, [keep])
  assert.equal(r.selected, -1)
})

test('Alt cuts only the selected shape, even where the box touches another', () => {
  const a = boxAt(100, 100, 300, 200)
  const b = boxAt(320, 100, 500, 200)
  const r = commitMask([a, b], 0, boxMask(280, 60, 340, 240), 'cutSelected', frame, 40)
  assert.equal(r.regions.length, 2)
  assert.equal(r.regions[1], b, 'the other shape is untouched')
})

test('Alt with no selected shape, or one the box misses, does nothing', () => {
  const a = boxAt(100, 100, 300, 200)
  assert.equal(commitMask([a], -1, boxMask(150, 120, 250, 180), 'cutSelected', frame, 40).changed, false)
  assert.equal(commitMask([a], 0, boxMask(500, 120, 600, 180), 'cutSelected', frame, 40).changed, false)
})

test('Shift and Alt work the same with a lasso loop', () => {
  const loop = (cx, cy, rx, ry) => {
    const pts = []
    for (let i = 0; i < 90; i++) pts.push([cx + rx * Math.cos((i / 90) * 2 * Math.PI), cy + ry * Math.sin((i / 90) * 2 * Math.PI)])
    return pts
  }
  const first = commitMask([], -1, raster(loop(0.3, 0.5, 0.12, 0.2)), 'new', frame, 40)
  const added = commitMask(first.regions, 0, raster(loop(0.45, 0.5, 0.12, 0.2)), 'add', frame, 40)
  assert.equal(added.regions.length, 1, 'the lasso joined the shape')
  const cut = commitMask(added.regions, 0, raster(loop(0.37, 0.5, 0.03, 0.4)), 'cutSelected', frame, 40)
  assert.equal(cut.regions.length, 2, 'a lasso through the middle splits it')
})

test('the hint line names the tool\'s keys', () => {
  assert.match(toolHint('box'), /Shift.*adds to the selected shape.*Alt.*cuts from it/)
  assert.match(toolHint('lasso'), /Shift.*adds to the selected shape.*Alt.*cuts from it/)
  assert.match(toolHint('brush', 24), /Alt.*size <b>24 px/)
  assert.match(toolHint('select'), /Delete/)
})

test('a lasso loop thinner than the rounding still makes a shape', () => {
  const thin = { view: { start: 0, end: 20 }, W: 880, H: 200 }
  const v = (hz) => 1 - Math.log(hz / 30) / Math.log(20000 / 30)
  const loop = [[0.01, v(1900)], [0.99, v(1900)], [0.99, v(1200)], [0.01, v(1200)]]
  const r = commitMask([], -1, raster(loop), 'new', thin, 40)
  assert.equal(r.regions.length, 1)
  assert.ok(r.regions[0].handles.length >= MIN_HANDLES)
})
