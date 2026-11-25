import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadedFluctuation, fluctuationFingerprint, isFluctuationDirty, groupDriftFor, groupOverrideNotes } from '../src/domain/driftState.js'

test('loadedFluctuation fills all three axes', () => {
  const f = loadedFluctuation(undefined)
  assert.ok(f.volume && f.pitch && f.pan)
})

test('dirty compares against the saved fingerprint', () => {
  const f = loadedFluctuation(undefined)
  assert.equal(isFluctuationDirty(f, null), false)
  const fp = fluctuationFingerprint(f)
  assert.equal(isFluctuationDirty(f, fp), false)
  assert.equal(isFluctuationDirty({ ...f, volume: { ...f.volume, enabled: !f.volume.enabled } }, fp), true)
})

const presets = [{ id: 'p', groups: [{ name: 'Rain', soundIds: ['s'], filters: { fluctuation: { volume: { enabled: true }, pitch: { enabled: true }, pan: { enabled: true, perSound: true } } } }] }]

test('groupDriftFor splits per-sound and shared axes', () => {
  const info = groupDriftFor('s', presets, 'p')
  assert.deepEqual(info.perSound, ['pitch', 'pan'])
  assert.deepEqual(info.sharedAxes, ['volume'])
  assert.equal(groupDriftFor('x', presets, 'p'), null)
  assert.equal(groupDriftFor(null, presets, 'p'), null)
  assert.equal(groupDriftFor('s', presets, 'other'), null)
})

test('groupOverrideNotes words', () => {
  assert.deepEqual(groupOverrideNotes(null), { fluc: '', shot: '' })
  const n = groupOverrideNotes(groupDriftFor('s', presets, 'p'))
  assert.match(n.fluc, /pitch and pan drift comes from its group "Rain"/)
  assert.match(n.fluc, /drifts volume for the whole group/)
  assert.match(n.shot, /pitch and pan range/)
})
