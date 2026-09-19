import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { loopLayout, clipToSource, sourceToClip } from '../src/domain/loopLayout.js'
import { formatDuration, parseDuration } from '../src/domain/time.js'
import { applySoundOverride, cloneWholeMix, wholeMixEqual, NEUTRAL_WHOLE_MIX, defaultFluctuation, formatPan } from '../src/domain/mixSettings.js'
import { escapeHtml } from '../src/domain/html.js'

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
