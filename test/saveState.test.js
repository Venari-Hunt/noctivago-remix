import { test } from 'node:test'
import assert from 'node:assert/strict'
import { saveButtonState } from '../src/domain/saveState.js'

test('last saved view locks everything', () => {
  const s = saveButtonState({ compareSaved: true, eqViewingB: false, isDirty: () => { throw new Error('lazy') } })
  assert.equal(s.label, 'Viewing last saved')
  assert.equal(s.saveDisabled, true)
  assert.equal(s.undoDisabled, true)
  assert.equal(s.cancelDisabled, true)
})

test('EQ B view disables save and copy', () => {
  const s = saveButtonState({ compareSaved: false, eqViewingB: true, isDirty: () => true })
  assert.equal(s.label, 'Viewing saved mix')
  assert.equal(s.saveAsCopyDisabled, true)
})

test('now view follows dirty', () => {
  assert.deepEqual(saveButtonState({ compareSaved: false, eqViewingB: false, isDirty: () => true }), { view: 'now', saveDisabled: false, label: 'Save', saveAsCopyDisabled: false })
  assert.equal(saveButtonState({ compareSaved: false, eqViewingB: false, isDirty: () => false }).label, 'Nothing to save')
})
