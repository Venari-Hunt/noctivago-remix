import test from 'node:test'
import assert from 'node:assert/strict'
import { biquadQ } from '../src/domain/eqQ.js'

test('lowpass/highpass Q becomes dB, other types keep real Q', () => {
  assert.ok(Math.abs(biquadQ('lowpass', Math.SQRT1_2) - -3.0103) < 1e-3)
  assert.ok(Math.abs(biquadQ('highpass', 10) - 20) < 1e-9)
  assert.equal(biquadQ('peaking', 2), 2)
  assert.equal(biquadQ('bandpass', 4), 4)
})

test('bad Q falls back to Butterworth instead of NaN', () => {
  assert.ok(Number.isFinite(biquadQ('lowpass', NaN)))
  assert.equal(biquadQ('peaking', 0), Math.SQRT1_2)
})
