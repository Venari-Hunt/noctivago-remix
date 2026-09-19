// Coordinate math for the Spectral repair panel: x is time across the shown
// window (the loop region), y is frequency on a log scale with high
// frequencies at the top. Must match the app's spectrogram
// (src/main/ffmpeg/spectrogram.js: rows log-spaced between minHz and maxHz,
// row 0 lowest) so a box drawn over a bright spot lands on those same Hz.

export const MIN_HZ = 30
export const MAX_HZ = 20000
export const DEFAULT_REDUCTION_DB = 40

export function secToX(sec, view, width) {
  return ((sec - view.start) / (view.end - view.start)) * width
}

export function xToSec(x, view, width) {
  return view.start + (x / width) * (view.end - view.start)
}

export function hzToY(hz, height, minHz = MIN_HZ, maxHz = MAX_HZ) {
  const clamped = Math.min(Math.max(hz, minHz), maxHz)
  return height * (1 - Math.log(clamped / minHz) / Math.log(maxHz / minHz))
}

export function yToHz(y, height, minHz = MIN_HZ, maxHz = MAX_HZ) {
  const t = 1 - Math.min(Math.max(y / height, 0), 1)
  return minHz * Math.exp(t * Math.log(maxHz / minHz))
}

// A box from two drag corners, ordered, clamped to the view and the Hz
// range, rounded to what the fields show (10 ms, 1 Hz).
export function regionFromCorners(a, b, view, reductionDb = DEFAULT_REDUCTION_DB) {
  const clampSec = (s) => Math.min(Math.max(s, view.start), view.end)
  const clampHz = (h) => Math.min(Math.max(h, MIN_HZ), MAX_HZ)
  return {
    startSec: round(clampSec(Math.min(a.sec, b.sec)), 2),
    endSec: round(clampSec(Math.max(a.sec, b.sec)), 2),
    lowHz: Math.round(clampHz(Math.min(a.hz, b.hz))),
    highHz: Math.round(clampHz(Math.max(a.hz, b.hz))),
    reductionDb
  }
}

// Too small to mean anything (a click, not a drag): under 20 ms or under
// about a semitone.
export function isUsableRegion(region) {
  return region.endSec - region.startSec >= 0.02 && region.highHz / region.lowHz >= 1.06
}

function round(n, digits) {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

export function formatHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`
}

// Same key order/defaults the app's snapshot compare needs, so a region
// that only round-trips through storage never reads as an unsaved change.
export function normalizeRegions(regions) {
  return (Array.isArray(regions) ? regions : []).map((r) => ({
    startSec: r.startSec,
    endSec: r.endSec,
    lowHz: r.lowHz,
    highHz: r.highHz,
    reductionDb: r.reductionDb ?? DEFAULT_REDUCTION_DB
  }))
}

// Dark blue -> purple -> orange -> pale yellow, 0..255 -> [r, g, b].
const STOPS = [
  [0, [22, 26, 43]],
  [0.35, [72, 42, 120]],
  [0.65, [214, 88, 88]],
  [0.85, [255, 158, 100]],
  [1, [255, 236, 180]]
]
export function spectrogramColor(value) {
  const t = value / 255
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i]
    if (t <= t1) {
      const [t0, c0] = STOPS[i - 1]
      const f = (t - t0) / (t1 - t0)
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * f))
    }
  }
  return STOPS[STOPS.length - 1][1]
}
