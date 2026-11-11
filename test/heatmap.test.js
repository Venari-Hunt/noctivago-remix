import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heatColor, heatLevel, noteTicks, RULER_RANGES } from '../src/components/EqEditor.js'

test('heat colors run near black to amber, as in the mock', () => {
  assert.equal(heatColor(0), 'rgb(15,15,17)')
  assert.equal(heatColor(1), 'rgb(224,184,76)')
  assert.equal(heatColor(0.5), 'rgb(132,34,72)') // red-violet middle
})

test('heat level rises with dB and stays inside 0..1.2', () => {
  const quiet = heatLevel(-100)
  const loud = heatLevel(-12)
  assert.ok(quiet < 0.1, `quiet ${quiet}`)
  assert.ok(loud > 1, `loud ${loud}`)
  assert.ok(heatLevel(-50) > heatLevel(-70))
})

test('note ruler: one C per octave, C4 is middle C', () => {
  const ticks = noteTicks(20, 20000)
  assert.equal(ticks[0][0], 'C1')
  assert.equal(ticks.at(-1)[0], 'C10') // 16.7 kHz
  const c4 = ticks.find(([l]) => l === 'C4')[1]
  assert.ok(Math.abs(c4 - 261.63) < 0.01, `C4 ${c4}`)
  assert.deepEqual(noteTicks(200, 300).map(([l]) => l), ['C4'])
})

test('ranges cover 20 Hz to 20 kHz with no gaps, SUB to TREBLE', () => {
  assert.equal(RULER_RANGES[0][0], 'SUB')
  assert.equal(RULER_RANGES.at(-1)[0], 'TREBLE')
  assert.equal(RULER_RANGES[0][1], 20)
  assert.equal(RULER_RANGES.at(-1)[2], 20000)
  for (let i = 1; i < RULER_RANGES.length; i++) assert.equal(RULER_RANGES[i][1], RULER_RANGES[i - 1][2])
})
