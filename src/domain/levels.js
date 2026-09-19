// Level-history math for the live level strip. No DOM.

// Live loudness-over-time strip for Preset/Group mode ("where's the
// waveform so I can see where the audio is louder") - a rolling peak-level
// history, most recent sample at the right edge, scrolling left as older
// samples age out. Deliberately not a per-file trim waveform like Sound
// mode's - there's no single file here, and the mix keeps playing
// indefinitely, so a live scrolling strip (closer to a DAW meter bridge)
// is the shape that actually answers "where is it louder" for a live mix.
export const LEVEL_HISTORY_LENGTH = 600

export function pushLevel(history, level) {
  history.push(level)
  if (history.length > LEVEL_HISTORY_LENGTH) history.shift()
}

export function peakFromTimeDomain(buffer) {
  let peak = 0
  for (let i = 0; i < buffer.length; i++) {
    const v = Math.abs(buffer[i] - 128) / 128
    if (v > peak) peak = v
  }
  return peak
}
