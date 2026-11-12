import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { faderToGain, gainToFader, formatGain, groupDetail, presetDetail, soundDetail, panOverride, withSoundVolume } from '../src/domain/detailPanel.js'

const library = [
  { id: 'a', name: 'wind howls', filters: { pan: 0, gainDb: 2 } },
  { id: 'b', name: 'gusty trees', filters: { pan: 0.5 } },
  { id: 'c', name: 'rain on window', filters: {} }
]
const preset = {
  id: 'p',
  name: 'Rain Inside',
  sounds: [
    { soundId: 'a', volume: 0.8, overrides: null },
    { soundId: 'c', volume: 0.5, overrides: { filters: { pan: -0.4 } } }
  ],
  groups: [{ id: 'g', name: 'Wind', soundIds: ['a', 'b'] }]
}

describe('detail panel fader', () => {
  test('ends: silence and unity', () => {
    assert.equal(faderToGain(0), 0)
    assert.equal(faderToGain(1), 1)
    assert.equal(gainToFader(0), 0)
    assert.equal(gainToFader(1), 1)
  })
  test('round-trips and caps a boost at the full fader', () => {
    for (const p of [0.1, 0.37, 0.5, 0.9]) assert.ok(Math.abs(gainToFader(faderToGain(p)) - p) < 1e-9)
    assert.equal(gainToFader(1.6), 1)
    assert.equal(formatGain(1.6), '160%')
  })
})

describe('detail panel lists', () => {
  test('group members carry their preset volume, unknown ones 100%', () => {
    const d = groupDetail(preset.groups[0], preset, library)
    assert.deepEqual(d.members.map((m) => [m.name, m.gain]), [['wind howls', 0.8], ['gusty trees', 1]])
    assert.equal(d.meta, 'Group · 2 sounds')
    assert.deepEqual(d.members.map((m) => m.inMix), [true, false])
  })
  test('live Mixer volumes win over stored ones', () => {
    const d = groupDetail(preset.groups[0], preset, library, (id) => (id === 'a' ? 0.3 : undefined))
    assert.equal(d.members[0].gain, 0.3)
  })
  test('a preset lists groups, then only the sounds outside them', () => {
    const d = presetDetail(preset, library)
    assert.deepEqual(d.groups, [{ id: 'g', name: 'Wind', count: 2 }])
    assert.deepEqual(d.sounds.map((s) => s.name), ['rain on window'])
    assert.equal(d.meta, 'Preset · 1 group, 1 sound')
    assert.equal(presetDetail({ id: 'e', name: 'Empty', sounds: [], groups: [] }, library).meta, 'Preset · empty')
  })
  test('a sound reads its pan from the preset override', () => {
    assert.equal(soundDetail(preset, 'c', library).pan, -0.4)
    assert.equal(soundDetail(preset, 'a', library).pan, 0)
    assert.equal(soundDetail(preset, 'b', library), null) // not stored in the preset
  })
})

describe('detail panel writes', () => {
  test('pan keeps the baseline filters when there is no filters override', () => {
    assert.deepEqual(panOverride(preset, 'a', library, 0.25), { filters: { pan: 0.25, gainDb: 2 } })
    assert.deepEqual(panOverride(preset, 'c', library, 2), { filters: { pan: 1 } })
  })
  test('volume edits one sound and never adds one to the mix', () => {
    assert.equal(withSoundVolume(preset, 'a', 0.4).find((s) => s.soundId === 'a').volume, 0.4)
    assert.equal(withSoundVolume(preset, 'b', 0.6), null)
  })
})
