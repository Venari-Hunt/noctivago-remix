// [copy of src/shared/noiseReductionDsp.js in the app - the Remix plugin cannot import
// outside its own directory; test/coreParity.test.js keeps them equal.]
// Noise reduction DSP (one engine). Runs live in Remix (inside an AudioWorklet)
// and in the saved clip (src/main/ffmpeg/clipPasses.js), the same code, so the
// hiss you hear removed while editing is the hiss that gets removed from the
// save. It replaced ffmpeg's afftdn. noctivago-remix keeps an identical copy
// (src/audio/noiseReductionDsp.js); a parity test keeps them equal. It builds on
// spectralRepairDsp.js (the STFT frame loop); the Remix worklet loads both
// files' text, so this file's `import` line is stripped there.
//
// Same idea as Audacity's "Get noise profile, then apply": a noise-only stretch
// of the sound is analysed once into a profile (the average power in each
// frequency bin), then every frame has that much taken away, bin by bin
// (spectral subtraction). Strength is in dB: it sets both how hard the profile
// is subtracted and the floor a bin can be turned down to.
//
// Frames are 2048 samples (46 ms at 44.1 kHz): short enough to keep the delay
// small, long enough to resolve hum.
import { fft, StftChannel } from './spectralRepairDsp.js'

export const NOISE_FRAME = 2048
export const MIN_STRENGTH_DB = 1
export const MAX_STRENGTH_DB = 48
export const DEFAULT_STRENGTH_DB = 12

// The sample window the way the bake has always resolved it: absolute file
// seconds, clamped to the loop; unset or shorter than 0.1 s falls back to the
// first third of the loop, up to 1.5 s. Returns { start, end } in the same
// (absolute) seconds, or null when there is nothing usable to sample.
export function resolveNoiseWindow(startSec, endSec, loopStart, loopEnd) {
  const duration = loopEnd - loopStart
  if (!(duration > 0.2)) return null
  let ns = Number(startSec)
  let ne = Number(endSec)
  if (!Number.isFinite(ns) || !Number.isFinite(ne) || ne - ns < 0.1) {
    ns = loopStart
    ne = loopStart + Math.min(1.5, duration / 3)
  }
  ns = Math.min(Math.max(ns, loopStart), loopEnd)
  ne = Math.min(Math.max(ne, ns), loopEnd)
  if (ne - ns < 0.05) return null
  return { start: ns, end: ne }
}

// The noise profile: average |X|^2 per bin (NOISE_FRAME / 2 + 1 of them) over
// the frames inside [fromSec, toSec] of the given channels (Float32Array each,
// averaged together). Returns null when the window is shorter than one frame.
export function computeNoiseProfile(channels, sampleRate, fromSec, toSec) {
  const a = Math.max(0, Math.floor(fromSec * sampleRate))
  const b = Math.min(channels[0].length, Math.ceil(toSec * sampleRate))
  const bins = NOISE_FRAME / 2 + 1
  const hop = NOISE_FRAME / 4
  const window = new Float32Array(NOISE_FRAME)
  for (let i = 0; i < NOISE_FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NOISE_FRAME)
  const profile = new Float64Array(bins)
  const re = new Float64Array(NOISE_FRAME)
  const im = new Float64Array(NOISE_FRAME)
  let frames = 0
  for (let start = a; start + NOISE_FRAME <= b; start += hop) {
    for (const data of channels) {
      for (let i = 0; i < NOISE_FRAME; i++) {
        re[i] = data[start + i] * window[i]
        im[i] = 0
      }
      fft(re, im, false)
      for (let k = 0; k < bins; k++) profile[k] += re[k] * re[k] + im[k] * im[k]
      frames++
    }
  }
  if (frames === 0) return null
  const out = new Float32Array(bins)
  for (let k = 0; k < bins; k++) out[k] = profile[k] / frames
  return out
}

export class NoiseReductionChannel extends StftChannel {
  constructor() {
    super(NOISE_FRAME)
    this.profile = null
    this.strengthDb = DEFAULT_STRENGTH_DB
    this.gains = new Float32Array(NOISE_FRAME / 2 + 1)
    this.smoothed = new Float32Array(NOISE_FRAME / 2 + 1).fill(1)
    this._configure()
  }

  // profile: from computeNoiseProfile, or null to pass audio through.
  setProfile(profile) {
    this.profile = profile
  }

  setStrength(strengthDb) {
    this.strengthDb = Math.min(MAX_STRENGTH_DB, Math.max(MIN_STRENGTH_DB, Number(strengthDb) || DEFAULT_STRENGTH_DB))
    this._configure()
  }

  _configure() {
    // How far past "exactly the profile" to subtract, and the lowest a bin can go.
    this.oversubtract = 2 + this.strengthDb / 8
    this.floorGain = Math.pow(10, -this.strengthDb / 20)
  }

  shape(re, im) {
    const profile = this.profile
    if (!profile) return
    const n = NOISE_FRAME
    fft(re, im, false)
    const gains = this.gains
    for (let k = 0; k <= n / 2; k++) {
      const power = re[k] * re[k] + im[k] * im[k]
      const g2 = power > 0 ? 1 - (this.oversubtract * profile[k]) / power : 0
      gains[k] = Math.max(this.floorGain, Math.sqrt(Math.max(0, g2)))
    }
    // Smooth over time (fast to open, slow to close) and across three bins, so
    // single bins that flicker don't leave "musical noise" warbles.
    const s = this.smoothed
    for (let k = 0; k <= n / 2; k++) {
      const prev = s[k]
      const target = gains[k]
      s[k] = target > prev ? target : prev * 0.6 + target * 0.4
    }
    for (let k = 0; k <= n / 2; k++) {
      const left = s[k > 0 ? k - 1 : 0]
      const right = s[k < n / 2 ? k + 1 : k]
      const g = (left + 2 * s[k] + right) / 4
      re[k] *= g
      im[k] *= g
      if (k > 0 && k < n / 2) {
        re[n - k] *= g
        im[n - k] *= g
      }
    }
    fft(re, im, true)
  }
}

// Offline: a whole clip. noiseFromSec/noiseToSec are seconds from the start of
// the clip (the sample window). Returns new Float32Arrays, same length, or the
// input unchanged when no profile can be made.
export function reduceNoise(channels, sampleRate, { noiseFromSec, noiseToSec, strengthDb }) {
  const profile = computeNoiseProfile(channels, sampleRate, noiseFromSec, noiseToSec)
  if (!profile) return channels
  return channels.map((input) => {
    const ch = new NoiseReductionChannel()
    ch.setProfile(profile)
    ch.setStrength(strengthDb)
    return ch.processWhole(input)
  })
}
