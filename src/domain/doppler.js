// [copy of src/shared/doppler.js in the app - the Remix plugin can't import
// outside its own directory; test/coreParity.test.js keeps them equal.]
//
// The Doppler pitch contour, in semitones relative to the sound's own pitch.
// Physical model f'/f = c / (c + v*cos0): as a source passes on a straight
// line, cos0 swings from +1 approaching, through 0 at closest approach, to -1
// receding. That gives the flat-high / fast-drop / flat-low siren shape that a
// plain linear ramp can't.
//
// t is seconds into the loop region before Speed and Reverse (source time).
// closestFraction puts the marker (0 semitones) on the region; each side is
// scaled to its own length, so an off-centre marker swings faster on one side.
// sharpness01 maps exponentially to k, "how close the pass is": small k is a
// gentle glide, large k is plateaus with a fast drop. The contour is
// renormalized so Start/End land exactly on +/- intensity whatever k is.
// reversed: Start/End sit at natural pitch and the swing happens in a burst at
// the marker (raised-cosine window), a source darting past very close.

export const DEFAULT_DOPPLER_INTENSITY_SEMITONES = 5
export const DEFAULT_DOPPLER_SHARPNESS = 0.5
export const MIN_DOPPLER_FRACTION = 0.05

export function dopplerSemitones(
  t,
  durationSeconds,
  closestFraction = 0.5,
  intensitySemitones = DEFAULT_DOPPLER_INTENSITY_SEMITONES,
  reversed = false,
  sharpness01 = DEFAULT_DOPPLER_SHARPNESS
) {
  if (!(durationSeconds > 0)) return 0
  const frac = Math.min(Math.max(closestFraction, MIN_DOPPLER_FRACTION), 1 - MIN_DOPPLER_FRACTION)
  const closestT = frac * durationSeconds
  const sharp = Math.min(Math.max(sharpness01, 0), 1)
  const k = 0.6 * Math.pow(30, sharp) // ~0.6 (gentle glide) .. ~18 (hard plateaus)
  const edgeCos = k / Math.sqrt(1 + k * k)
  const tc = Math.min(Math.max(t, 0), durationSeconds)
  const s = tc <= closestT ? (tc - closestT) / closestT : (tc - closestT) / (durationSeconds - closestT)
  const contour = ((k * s) / Math.sqrt(1 + k * s * k * s)) / edgeCos
  return reversed
    ? -intensitySemitones * contour * Math.pow(Math.cos((Math.PI * s) / 2), 2)
    : -intensitySemitones * contour
}
