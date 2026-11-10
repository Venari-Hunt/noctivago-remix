import test from 'node:test'
import assert from 'node:assert/strict'
import { knobFraction, knobValueAt } from '../src/components/Knob.js'
import { defaultScatter, defaultSchedule, defaultSpeedPitch } from '../src/domain/mixSettings.js'

test('knob fraction is the value position in the range, clamped', () => {
  assert.equal(knobFraction(1000, 0, 2000), 0.5)
  assert.equal(knobFraction(-5, 0, 100), 0)
  assert.equal(knobFraction(500, 0, 100), 1)
  assert.equal(knobFraction(5, 5, 5), 0)
})

test('knob value snaps to the input step and stays in range', () => {
  assert.equal(knobValueAt(0.5, 0, 2000, 10), 1000)
  assert.equal(knobValueAt(0.253, 0, 2000, 10), 510)
  assert.equal(knobValueAt(2, 1, 12, 1), 12)
  assert.equal(knobValueAt(-1, 1, 12, 1), 1)
  assert.equal(knobValueAt(0.5, 1, 12, 1), 7)
})

test('segment defaults are fresh objects with neutral values', () => {
  assert.notEqual(defaultScatter(), defaultScatter())
  assert.equal(defaultScatter().minGapSeconds, 5)
  assert.equal(defaultSchedule().type, 'times')
  assert.deepEqual(defaultSchedule().times, [])
  assert.equal(defaultSpeedPitch().speed, 1)
  assert.equal(defaultSpeedPitch().dopplerEnabled, false)
})
