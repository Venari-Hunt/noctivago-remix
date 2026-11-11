import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heatColor, heatLevel, noteTicks, RULER_RANGES, spectrumColumns } from '../src/components/EqEditor.js'

test('heat colors run near black to amber, as in the mock', () => {
  assert.equal(heatColor(0), 'rgb(15,15,17)')
  assert.equal(heatColor(1), 'rgb(224,184,76)')
  assert.equal(heatColor(0.5), 'rgb(132,34,72)') // red-violet middle
})

test('heat level: loudest column is amber, 30 dB below is near black', () => {
  assert.ok(heatLevel(-30, -30) > 1, 'top is amber')
  assert.ok(heatLevel(-60, -30) < 0.1, 'bottom near black')
  assert.ok(heatLevel(-200, -30) < 0.1, 'never below black')
  assert.ok(heatLevel(-50, -30) > heatLevel(-60, -30), 'rises with level')
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

test('mean reduce averages a column instead of taking its loudest bin', () => {
  const bins = new Float32Array(2048).fill(-90)
  for (let i = 800; i < 1700; i += 2) bins[i] = -40 // every other treble bin loud
  const peak = spectrumColumns(400, bins, 48000, 20, 20000)
  const mean = spectrumColumns(400, bins, 48000, 20, 20000, 'mean')
  assert.ok(peak[380] - mean[380] > 2, `peak ${peak[380]} mean ${mean[380]}`)
})
