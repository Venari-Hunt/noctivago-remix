import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readBandFields, bandsDiffer } from '../src/components/useEqTarget.js'

describe('useEqTarget helpers', () => {
  test('field values are clamped like the old copies', () => {
    const b = readBandFields({ type: 'peaking', slope: 'gentle', freq: '5', gain: '99', q: '0' })
    assert.equal(b.freqHz, 20)
    assert.equal(b.gainDb, 24)
    assert.ok(b.q > 0)
    assert.equal(readBandFields({ freq: '99999', gain: '-99', q: '1' }).freqHz, 20000)
  })
  test('differs treats a missing saved list as empty', () => {
    assert.equal(bandsDiffer([], undefined), false)
    assert.equal(bandsDiffer([{ freqHz: 1 }], undefined), true)
  })
})
