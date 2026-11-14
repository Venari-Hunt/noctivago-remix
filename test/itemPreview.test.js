import { test } from 'node:test'
import assert from 'node:assert/strict'
import { previewKind, nextGapSeconds, shotVariation, effectiveSound, soundPlan, groupPlan, SCHEDULED_PREVIEW_GAP_SECONDS } from '../src/domain/itemPreview.js'

const lib = [
  { id: 'a', name: 'Rain', playMode: 'loop', filters: { pan: 0 } },
  { id: 'b', name: 'Bird', playMode: 'scatter', scatter: { minGapSeconds: 2, maxGapSeconds: 6, minVolume: 0.5, maxVolume: 1, minPitchSemitones: -2, maxPitchSemitones: 2 } },
  { id: 'c', name: 'Bell', playMode: 'scheduled', schedule: { minVolume: 1, maxVolume: 1 } }
]
const preset = {
  id: 'p',
  sounds: [
    { soundId: 'a', volume: 0.4, overrides: { filters: { pan: -0.5 } } },
    { soundId: 'b', volume: 0.8 }
  ],
  groups: [{ id: 'g', name: 'G', soundIds: ['a', 'b', 'c'], filters: { gainDb: -3 } }]
}

test('previewKind maps the stored play modes', () => {
  assert.equal(previewKind(lib[0]), 'loop')
  assert.equal(previewKind(lib[1]), 'random')
  assert.equal(previewKind(lib[2]), 'scheduled')
  assert.equal(previewKind({}), 'loop')
})

test('a Random gap stays inside its range; Scheduled uses the short preview gap', () => {
  assert.equal(nextGapSeconds(lib[1], () => 0), 2)
  assert.equal(nextGapSeconds(lib[1], () => 1), 6)
  assert.equal(nextGapSeconds(lib[2], () => 0.5), SCHEDULED_PREVIEW_GAP_SECONDS)
})

test('the gap bias pulls toward its value', () => {
  const biased = { ...lib[1], scatter: { ...lib[1].scatter, gapBiasEnabled: true, gapBiasSeconds: 6 } }
  assert.equal(nextGapSeconds(biased, () => 0), 4)
})

test('shot variation draws from the sound range; a loop has none', () => {
  assert.deepEqual(shotVariation(lib[0]), { volume: 1, pitchSemitones: 0 })
  assert.deepEqual(shotVariation(lib[1], () => 0), { volume: 0.5, pitchSemitones: -2 })
  assert.deepEqual(shotVariation(lib[1], () => 1), { volume: 1, pitchSemitones: 2 })
})

test('the effective sound carries the preset override', () => {
  assert.equal(effectiveSound(lib, preset, 'a').filters.pan, -0.5)
  assert.equal(effectiveSound(lib, null, 'a').filters.pan, 0)
  assert.equal(effectiveSound(lib, preset, 'zz'), null)
})

test('soundPlan: stored volume, live volume wins; a loop always repeats; Loop decides a one-shot', () => {
  assert.equal(soundPlan(lib, preset, 'a').gain, 0.4)
  assert.equal(soundPlan(lib, preset, 'a', { gain: 0.9 }).gain, 0.9)
  assert.equal(soundPlan(lib, preset, 'a').repeat, true)
  assert.equal(soundPlan(lib, preset, 'b').repeat, false)
  assert.equal(soundPlan(lib, preset, 'b', { repeat: true }).repeat, true)
})

test('groupPlan: only members in the mix, all repeating, with the group filters', () => {
  const plan = groupPlan(lib, preset, preset.groups[0])
  assert.deepEqual(plan.members.map((m) => m.id), ['a', 'b'])
  assert.ok(plan.members.every((m) => m.repeat))
  assert.equal(plan.filters.gainDb, -3)
  assert.equal(groupPlan(lib, preset, null), null)
})
