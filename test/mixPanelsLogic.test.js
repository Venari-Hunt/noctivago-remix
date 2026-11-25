import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FILTER_ROWS, effectChips } from '../src/components/mixPanelsLogic.js'

describe('mix panel rows', () => {
  test('preset order and Fade in number field', () => {
    assert.deepEqual(FILTER_ROWS.preset.map((r) => r.key), ['highpass', 'lowpass', 'gain', 'echo-delay', 'echo-decay', 'reverb-size', 'reverb-mix', 'fadein'])
    assert.equal(FILTER_ROWS.preset.at(-1).kind, 'number')
  })
  test('group adds Pan after Gain and Occlusion last', () => {
    assert.deepEqual(FILTER_ROWS.group.map((r) => r.key), ['highpass', 'lowpass', 'gain', 'pan', 'echo-delay', 'echo-decay', 'reverb-size', 'reverb-mix', 'occlusion'])
    assert.match(FILTER_ROWS.group.at(-1).title, /behind a wall/)
  })
  test('ranges match the old markup', () => {
    const lp = FILTER_ROWS.group.find((r) => r.key === 'lowpass')
    assert.deepEqual([lp.min, lp.max, lp.step, lp.value, lp.initial], [150, 20000, 50, 20000, 'Off'])
    assert.equal(FILTER_ROWS.group.find((r) => r.key === 'pan').initial, 'C')
  })
  test('seven effect chips in order', () => {
    assert.deepEqual(effectChips().map((c) => c[0]), ['muffled', 'phone', 'radio', 'distant', 'echo', 'reverb', 'underwater'])
  })
})
