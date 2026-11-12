import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heatColor, heatColumns, heatLevel, heatTopDb, HEAT_STOPS_BEFORE, noteTicks, RULER_RANGES, spectrumColumns } from '../src/components/EqEditor.js'

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

// Owner bug 2026-11-11: the heat looked unchanged by EQ edits, because each
// frame was scaled to its own loudest column. Now the Before heat sets the top.
function heatAt(bins, refBins, x) {
  const cols = heatColumns(400, bins, 48000, 20, 20000)
  const ref = refBins ? heatColumns(400, refBins, 48000, 20, 20000) : null
  return heatLevel(cols[x], heatTopDb(cols, ref))
}

test('a 10 dB boost on the loudest area shows; scaling to itself hid it', () => {
  const before = new Float32Array(2048).fill(-80)
  for (let i = 20; i < 60; i++) before[i] = -40 // loud low band
  const after = before.map((v, i) => (i >= 20 && i < 60 ? v + 10 : v))
  const x = heatColumns(400, before, 48000, 20, 20000).indexOf(Math.max(...heatColumns(400, before, 48000, 20, 20000)))
  const unedited = heatAt(before, before, x)
  const boosted = heatAt(after, before, x)
  assert.ok(boosted - unedited > 0.15, `boost ${unedited} -> ${boosted}`)
  assert.ok(Math.abs(heatAt(after, null, x) - heatAt(before, null, x)) < 0.01, 'self-scaled heat is blind to it')
})

test('a 6 dB cut darkens', () => {
  const before = new Float32Array(2048).fill(-80)
  for (let i = 1200; i < 1700; i++) before[i] = -40 // loud treble (the tilt favors it)
  const after = before.map((v, i) => (i >= 1200 && i < 1700 ? v - 6 : v))
  const cols = heatColumns(400, before, 48000, 20, 20000)
  const x = cols.indexOf(Math.max(...cols))
  assert.ok(heatAt(before, before, x) - heatAt(after, before, x) > 0.1)
})

test('Before heat runs cold, After warm', () => {
  const top = heatColor(0.9, HEAT_STOPS_BEFORE).match(/[0-9]+/g).map(Number)
  assert.ok(top[2] > top[0], `before is blue: ${top}`)
  const warm = heatColor(0.9).match(/[0-9]+/g).map(Number)
  assert.ok(warm[0] > warm[2], `after is warm: ${warm}`)
})
