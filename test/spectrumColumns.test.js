import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spectrumColumns } from '../src/components/EqEditor.js'

// 2048 bins at 48 kHz = 11.72 Hz per bin.
const SR = 48000
const flat = (db) => new Float32Array(2048).fill(db)

test('each column takes the peak of its bins, not the average', () => {
  const bins = flat(-90)
  const peakBin = Math.round(10000 / (SR / 2 / 2048)) // ~10 kHz
  bins[peakBin] = -20
  const cols = spectrumColumns(400, bins, SR, 20, 20000)
  const best = Math.max(...cols)
  // -20 dB plus the tilt at ~10 kHz (4.5 dB/oct * log2(10)) ~ -5 dB
  assert.ok(best > -8 && best < -2, `peak kept: ${best}`)
})

test('tilt: flat input rises 4.5 dB per octave around 1 kHz', () => {
  const cols = spectrumColumns(1000, flat(-60), SR, 20, 20000)
  const low = cols[0]      // ~20 Hz
  const high = cols[999]   // ~20 kHz
  const octaves = Math.log2(20000 / 20)
  assert.ok(Math.abs((high - low) - 4.5 * octaves) < 1.5, `span ${high - low}`)
})

test('lows interpolate between bins instead of stepping', () => {
  const bins = flat(-90)
  bins[2] = -30 // ~23 Hz
  bins[3] = -60 // ~35 Hz
  const cols = spectrumColumns(1000, bins, SR, 20, 20000)
  const distinct = new Set(cols.slice(0, 80).map((v) => v.toFixed(2)))
  assert.ok(distinct.size > 20, `smooth lows: ${distinct.size} distinct values`)
})
