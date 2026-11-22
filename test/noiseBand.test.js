import test from 'node:test'
import assert from 'node:assert/strict'
import { MIN_NOISE_SEC, moveNoiseBand, noiseBand, noiseBandFromShape, visibleNoiseBand } from '../src/domain/spectralLayout.js'

const VIEW = { start: 2, end: 12 }

test('a noise band orders its ends, clamps to the window and rounds to 10 ms', () => {
  assert.deepEqual(noiseBand(5.004, 3.2, VIEW), { startSec: 3.2, endSec: 5 })
  assert.deepEqual(noiseBand(0, 20, VIEW), { startSec: 2, endSec: 12 })
})

test('a click is not a band', () => {
  assert.equal(noiseBand(4, 4.05, VIEW), null)
  assert.ok(noiseBand(4, 4 + MIN_NOISE_SEC, VIEW))
})

test('the typed fields draw as a band clipped to the window, or nothing', () => {
  assert.deepEqual(visibleNoiseBand(3, 5, VIEW), { startSec: 3, endSec: 5 })
  assert.deepEqual(visibleNoiseBand(0, 4, VIEW), { startSec: 2, endSec: 4 })
  assert.equal(visibleNoiseBand(0, 0, VIEW), null)
  assert.equal(visibleNoiseBand(5, 3, VIEW), null)
  assert.equal(visibleNoiseBand(0, 1.5, VIEW), null)
  assert.equal(visibleNoiseBand(12, 14, VIEW), null)
  assert.equal(visibleNoiseBand(Number.NaN, 4, VIEW), null)
})

test('moving a band keeps its length and stays inside the window', () => {
  assert.deepEqual(moveNoiseBand({ startSec: 3, endSec: 5 }, 1.234, VIEW), { startSec: 4.23, endSec: 6.23 })
  assert.deepEqual(moveNoiseBand({ startSec: 3, endSec: 5 }, -9, VIEW), { startSec: 2, endSec: 4 })
  assert.deepEqual(moveNoiseBand({ startSec: 3, endSec: 5 }, 99, VIEW), { startSec: 10, endSec: 12 })
})

test('a shape becomes a noise sample over its whole time range, whatever its frequencies', () => {
  const box = { startSec: 1.604, endSec: 2.8, lowHz: 180, highHz: 1100, reductionDb: 40 }
  assert.deepEqual(noiseBandFromShape(box), { startSec: 1.6, endSec: 2.8 })
  assert.equal(noiseBandFromShape({ startSec: 1, endSec: 1.05, lowHz: 100, highHz: 900 }), null)
  assert.equal(noiseBandFromShape(null), null)
})
