import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterPickerSounds, stepHighlight, enterPick } from '../src/domain/pickerList.js'

const sounds = [{ id: 1, name: 'Rain' }, { id: 2, name: 'Brain wave' }, { id: 3, name: 'Fire' }]

test('filter is case-insensitive and trims; empty returns all', () => {
  assert.deepEqual(filterPickerSounds(sounds, '  RAIN ').map((s) => s.id), [1, 2])
  assert.equal(filterPickerSounds(sounds, ''), sounds)
  assert.equal(filterPickerSounds(sounds, undefined), sounds)
})

test('stepHighlight wraps', () => {
  assert.equal(stepHighlight(-1, 3, 1), 0)
  assert.equal(stepHighlight(2, 3, 1), 0)
  assert.equal(stepHighlight(-1, 3, -1), 1) // same as the old inline math
  assert.equal(stepHighlight(0, 3, -1), 2)
  assert.equal(stepHighlight(5, 0, 1), 5)
})

test('enterPick falls back to the first', () => {
  assert.equal(enterPick(sounds, 1).id, 2)
  assert.equal(enterPick(sounds, -1).id, 1)
  assert.equal(enterPick([], -1), undefined)
})
