import test from 'node:test'
import assert from 'node:assert/strict'
import { filterSummaries, formatPan } from '../src/components/filterSummary.js'

const OFF = {
  highpassHz: 0,
  lowpassHz: 20000,
  gainDb: 0,
  pan: 0,
  gateThresholdDb: -80,
  gateRangeDb: 0,
  denoiseEnabled: false,
  echoDelayMs: 0,
  echoDecay: 0,
  reverbSizeMs: 0,
  reverbMix: 0
}

test('pan reads Center, then side and percent', () => {
  assert.equal(formatPan(0), 'Center')
  assert.equal(formatPan(-0.3), 'L 30')
  assert.equal(formatPan(1), 'R 100')
})

test('every group reads Off at the defaults', () => {
  assert.deepEqual(filterSummaries(OFF), { tone: 'Off', clean: 'Off', space: 'Off' })
})

test('summaries name what is on', () => {
  const s = filterSummaries({ ...OFF, highpassHz: 200, gainDb: 3, gateThresholdDb: -40, gateRangeDb: 12, denoiseEnabled: true, reverbSizeMs: 800, reverbMix: 0.3 })
  assert.equal(s.tone, 'High-pass · +3 dB')
  assert.equal(s.clean, 'Gate · Noise reduction')
  assert.equal(s.space, 'Reverb')
})

test('a half-set gate or echo still reads Off', () => {
  const s = filterSummaries({ ...OFF, gateThresholdDb: -40, echoDelayMs: 300 })
  assert.equal(s.clean, 'Off')
  assert.equal(s.space, 'Off')
})
