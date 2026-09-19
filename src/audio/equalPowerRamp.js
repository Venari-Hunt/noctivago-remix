// Plugin copy of src/renderer/audio/equalPowerRamp.js - keep in sync.
// Equal-power (cos/sin) loop-seam crossfade, matching the baked clip's
// acrossfade c1=qsin:c2=qsin (src/main/ffmpeg/loopClip.js). The two sides
// of a loop seam are different moments of the source, so for noisy
// textures they're uncorrelated and a linear blend dips ~3 dB mid-seam.
// Scheduled as short linear ramps rather than setValueCurveAtTime, since a
// curve throws if a later cancel + setValueAtTime overlaps it (pause()
// mid-crossfade does exactly that).
const STEPS = 12

export function rampEqualPower(param, now, fade, from, to) {
  param.cancelScheduledValues(now)
  param.setValueAtTime(from, now)
  for (let i = 1; i <= STEPS; i++) {
    const x = (i / STEPS) * (Math.PI / 2)
    const shape = to > from ? Math.sin(x) : 1 - Math.cos(x)
    param.linearRampToValueAtTime(from + (to - from) * shape, now + (fade * i) / STEPS)
  }
}
