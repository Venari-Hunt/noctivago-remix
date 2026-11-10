import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { canReverseLive, reverseRegion, encodeWav16, reversedToSource, sourceToReversed, LIVE_REVERSE_MAX_SECONDS } from '../src/domain/reverseRegion.js'

function fakeBuffer(channels, sampleRate = 10) {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0].length,
    getChannelData: (c) => Float32Array.from(channels[c])
  }
}

describe('reverseRegion', () => {
  test('reverses only the loop region, per channel', () => {
    const buffer = fakeBuffer([
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
    ])
    const [left, right] = reverseRegion(buffer, 0.2, 0.6)
    assert.deepEqual(Array.from(left), [5, 4, 3, 2])
    assert.deepEqual(Array.from(right), [15, 14, 13, 12])
  })

  test('clamps a region past the end of the file', () => {
    const [mono] = reverseRegion(fakeBuffer([[0, 1, 2, 3]]), 0.2, 5)
    assert.deepEqual(Array.from(mono), [3, 2])
  })
})

describe('encodeWav16', () => {
  test('writes a 16-bit PCM WAV with interleaved, clipped samples', () => {
    const wav = encodeWav16([Float32Array.from([0, 1]), Float32Array.from([-1, 2])], 44100)
    const view = new DataView(wav)
    const text = (o) => String.fromCharCode(...new Uint8Array(wav, o, 4))
    assert.equal(text(0), 'RIFF')
    assert.equal(text(8), 'WAVE')
    assert.equal(view.getUint16(22, true), 2)
    assert.equal(view.getUint32(24, true), 44100)
    assert.equal(view.getUint16(34, true), 16)
    assert.equal(view.getUint32(40, true), 8)
    assert.deepEqual([44, 46, 48, 50].map((o) => view.getInt16(o, true)), [0, -32768, 32767, 32767])
  })
})

describe('reversed timeline', () => {
  const region = { start: 2, end: 10 }
  test('playing the reversed copy walks the source backwards from the loop end', () => {
    assert.equal(reversedToSource(region, 0), 10)
    assert.equal(reversedToSource(region, 8), 2)
    assert.equal(sourceToReversed(region, 7), 3)
  })
  test('source times outside the loop clamp into the copy', () => {
    assert.equal(sourceToReversed(region, 11), 0)
    assert.equal(sourceToReversed(region, 0), 8)
  })
})

describe('canReverseLive', () => {
  test('needs a known file of at most 10 minutes and a real loop', () => {
    assert.equal(canReverseLive(120, 0, 120), true)
    assert.equal(canReverseLive(LIVE_REVERSE_MAX_SECONDS + 1, 0, 60), false)
    assert.equal(canReverseLive(NaN, 0, 60), false)
    assert.equal(canReverseLive(120, 5, 5), false)
  })
})
