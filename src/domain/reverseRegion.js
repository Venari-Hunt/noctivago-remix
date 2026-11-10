// Live Reverse preview (one engine, step 1): the trimmed loop region played
// backwards, sample for sample what ffmpeg's `areverse` writes into the
// saved clip (src/main/ffmpeg/loopClip.js in core). Pure functions, no Web
// Audio or DOM, so node:test covers them directly.

// Same ceiling as the bake: loops of 10 minutes or more are never saved as
// a clip, so Reverse never applies to them at all. The whole source file is
// decoded to slice the region, so the file itself is capped too - an
// hours-long file would hold gigabytes of decoded audio in the renderer.
export const LIVE_REVERSE_MAX_SECONDS = 600

export function canReverseLive(fileDurationSeconds, loopStart, loopEnd) {
  if (!Number.isFinite(fileDurationSeconds) || fileDurationSeconds <= 0) return false
  if (fileDurationSeconds > LIVE_REVERSE_MAX_SECONDS) return false
  return loopEnd - loopStart > 0 && loopEnd - loopStart < LIVE_REVERSE_MAX_SECONDS
}

// `buffer` is anything AudioBuffer-shaped (sampleRate, numberOfChannels,
// length, getChannelData). Returns one reversed Float32Array per channel for
// [start, end) in seconds, clamped to the buffer.
export function reverseRegion(buffer, start, end) {
  const from = Math.max(0, Math.min(buffer.length, Math.round(start * buffer.sampleRate)))
  const to = Math.max(from, Math.min(buffer.length, Math.round(end * buffer.sampleRate)))
  const length = to - from
  const channels = []
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const source = buffer.getChannelData(c)
    const out = new Float32Array(length)
    for (let i = 0; i < length; i++) out[i] = source[to - 1 - i]
    channels.push(out)
  }
  return channels
}

// 16-bit PCM WAV, the same sample format the bake writes (pcm_s16le), so
// the live preview can stream it through the existing <audio> voices and
// their filter chain unchanged.
export function encodeWav16(channels, sampleRate) {
  const channelCount = channels.length
  const frames = channelCount > 0 ? channels[0].length : 0
  const dataBytes = frames * channelCount * 2
  const out = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(out)
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * 2, true)
  view.setUint16(32, channelCount * 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]))
      view.setInt16(offset, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true)
      offset += 2
    }
  }
  return out
}

// Reversed playback runs on its own 0..length timeline; the waveform,
// scrubbing and the sticky bar all speak source-file time. Playing forward
// through the reversed copy walks the source backwards from `end`.
export function reversedToSource(region, t) {
  return region.end - t
}

export function sourceToReversed(region, s) {
  return Math.min(Math.max(region.end - s, 0), region.end - region.start)
}
