import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { loopLayout, clipToSource, sourceToClip } from '../src/domain/loopLayout.js'
import { formatDuration, parseDuration } from '../src/domain/time.js'
import { applySoundOverride, cloneWholeMix, wholeMixEqual, NEUTRAL_WHOLE_MIX, defaultFluctuation, formatPan } from '../src/domain/mixSettings.js'
import { escapeHtml } from '../src/domain/html.js'
import { MIN_HZ, MAX_HZ, secToX, xToSec, hzToY, yToHz, regionFromCorners, isUsableRegion, normalizeRegions, formatHz, spectrogramColor } from '../src/domain/spectralLayout.js'

describe('loopLayout', () => {
  test('a fade of 0 is a plain trim', () => {
    const layout = loopLayout(2, 10, 0)
    assert.equal(layout.length, 8)
    assert.equal(clipToSource(layout, 3), 5)
    assert.equal(sourceToClip(layout, 5), 3)
  })

  test('the fade is capped at a quarter of the trim and shortens the clip', () => {
    const layout = loopLayout(0, 8, 5)
    assert.equal(layout.fade, 2)
    assert.equal(layout.length, 6)
    assert.equal(layout.mid, 4)
  })

  test('clip and source times round-trip outside the blend', () => {
    const layout = loopLayout(1, 11, 1)
    for (let t = 0; t < layout.length; t += 0.37) {
      if (t >= layout.blendStart && t < layout.blendEnd) continue
      assert.ok(Math.abs(sourceToClip(layout, clipToSource(layout, t)) - t) < 1e-9, `t=${t}`)
    }
  })
})

test('formatDuration and parseDuration', () => {
  assert.equal(formatDuration(75), '1:15')
  assert.equal(formatDuration(3725), '1:02:05')
  assert.equal(parseDuration('1:15'), 75)
  assert.equal(parseDuration('a'), null)
})

test('applySoundOverride only applies overridable keys', () => {
  const entry = { id: 'a', volume: 1, filters: {} }
  assert.deepEqual(applySoundOverride(entry, { filters: { gainDb: 3 }, volume: 0 }), { id: 'a', volume: 1, filters: { gainDb: 3 } })
})

test('a cloned whole-mix setting is equal but separate', () => {
  const copy = cloneWholeMix(NEUTRAL_WHOLE_MIX)
  assert.ok(wholeMixEqual(copy, NEUTRAL_WHOLE_MIX))
  assert.notEqual(copy, NEUTRAL_WHOLE_MIX)
})

test('defaultFluctuation returns a fresh object each call', () => {
  assert.notEqual(defaultFluctuation(), defaultFluctuation())
  assert.deepEqual(defaultFluctuation(), defaultFluctuation())
})

test('formatPan and escapeHtml', () => {
  assert.equal(typeof formatPan(0), 'string')
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;')
})

test('spectral layout: Hz and seconds round-trip through canvas coordinates', () => {
  const view = { start: 2, end: 6 }
  assert.equal(secToX(4, view, 400), 200)
  assert.equal(xToSec(100, view, 400), 3)
  assert.equal(hzToY(MAX_HZ, 200), 0)
  assert.equal(hzToY(MIN_HZ, 200), 200)
  for (const hz of [50, 440, 3000, 15000]) assert.ok(Math.abs(yToHz(hzToY(hz, 200), 200) - hz) < 1e-6)
  // Log scale: an octave is the same height anywhere.
  assert.ok(Math.abs(hzToY(200, 200) - hzToY(400, 200) - (hzToY(2000, 200) - hzToY(4000, 200))) < 1e-9)
})

test('spectral layout: boxes from drag corners', () => {
  const view = { start: 1, end: 5 }
  const r = regionFromCorners({ sec: 3.456, hz: 4000.4 }, { sec: 0, hz: 900 }, view)
  assert.deepEqual(r, { startSec: 1, endSec: 3.46, lowHz: 900, highHz: 4000, reductionDb: 40 })
  assert.equal(isUsableRegion(r), true)
  assert.equal(isUsableRegion(regionFromCorners({ sec: 2, hz: 1000 }, { sec: 2.001, hz: 3000 }, view)), false)
  assert.equal(isUsableRegion(regionFromCorners({ sec: 2, hz: 1000 }, { sec: 3, hz: 1010 }, view)), false)
  assert.deepEqual(normalizeRegions([{ endSec: 2, startSec: 1, highHz: 9, lowHz: 5 }]), [
    { startSec: 1, endSec: 2, lowHz: 5, highHz: 9, reductionDb: 40 }
  ])
  assert.deepEqual(normalizeRegions(undefined), [])
  assert.equal(formatHz(440), '440 Hz')
  assert.equal(formatHz(2500), '2.5 kHz')
  assert.equal(formatHz(12000), '12 kHz')
  assert.deepEqual(spectrogramColor(0), [22, 26, 43])
  assert.deepEqual(spectrogramColor(255), [255, 236, 180])
})
