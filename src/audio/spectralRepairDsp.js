// [copy of src/shared/spectralRepairDsp.js in the app - the Remix plugin cannot import
// outside its own directory; test/coreParity.test.js keeps them equal.]
// Spectral repair DSP (one engine). The same code runs live in Remix (inside an
// AudioWorklet) and in the saved clip (src/main/ffmpeg/clipPasses.js),
// so the box you hear turned down while editing is the box that gets saved.
// noctivago-remix keeps an identical copy (src/audio/spectralRepairDsp.js);
// keep them in sync (a parity test checks it). No imports, no DOM, no Electron:
// the Remix worklet loads this file's text, so it must stay plain JS.
//
// What it does: short-time Fourier transform with a Hann window and 75%
// overlap (4096-sample frames, a new frame every 1024 samples), turn down the
// bins that sit inside a box at the box's time, overlap-add back. The overlap
// spreads every on/off transition over about one frame (~90 ms at 44.1 kHz),
// so box edges fade instead of clicking. A box is { startSec, endSec, lowHz,
// highHz, reductionDb }; several boxes multiply where they overlap.
//
// Streaming and 1:1: it takes N samples in and gives N out, LATENCY samples
// late (one frame, ~93 ms at 44.1 kHz; the first frames see zeros before the
// clip, so every real sample is covered by four frames). Offline callers push LATENCY extra zeros and drop the first
// LATENCY outputs.

export const FRAME = 4096
export const HOP = FRAME / 4
export const LATENCY = FRAME

// In-place radix-2 FFT of separate real/imag arrays (length a power of two).
// inverse=true runs the inverse transform and scales by 1/n.
export function fft(re, im, inverse) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

const windowCache = {}
function hannWindow(n) {
  if (!windowCache[n]) {
    const w = new Float32Array(n)
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
    windowCache[n] = w
  }
  return windowCache[n]
}

// Streaming STFT with a Hann window and 75% overlap, one channel: a frame is
// cut every frame/4 samples, windowed, handed to shape(re, im, centreIndex)
// (which turns the windowed samples into the wanted result, usually
// fft -> change bins -> inverse fft), and overlap-added. Hann windows at 75%
// overlap add up to 2, so the overlap-add is scaled by 0.5 to be unity.
// Subclasses supply shape(). Output is 1:1 with input, one frame (this.latency)
// samples late.
export class StftChannel {
  constructor(frame = FRAME) {
    this.frame = frame
    this.hop = frame / 4
    this.latency = frame
    this.window = hannWindow(frame)
    this.inRing = new Float32Array(frame)
    this.outAcc = new Float32Array(frame)
    this.fifo = new Float32Array(frame * 2)
    this.fifoRead = 0
    this.fifoWrite = 0
    this.pos = 0
    this.re = new Float64Array(frame)
    this.im = new Float64Array(frame)
    // A frame is only ready every hop samples and covers the frame before it,
    // so the first hop pops need seeds; after that, one sample out per sample
    // in, one frame late.
    for (let i = 0; i < this.hop; i++) this._push(0)
  }

  _push(v) {
    this.fifo[this.fifoWrite] = v
    this.fifoWrite = (this.fifoWrite + 1) % this.fifo.length
  }

  _pop() {
    const v = this.fifo[this.fifoRead]
    this.fifoRead = (this.fifoRead + 1) % this.fifo.length
    return v
  }

  // Overridden: re holds the windowed frame, im zeros; leave the result in re.
  // centreIndex is the input sample index at the frame's middle.
  shape() {}

  _processFrame() {
    const frame = this.frame
    const re = this.re
    const im = this.im
    const start = this.pos - frame
    for (let i = 0; i < frame; i++) {
      const idx = (((start + i) % frame) + frame) % frame
      re[i] = this.inRing[idx] * this.window[i]
      im[i] = 0
    }
    this.shape(re, im, this.pos - frame / 2)
    for (let i = 0; i < frame; i++) {
      const idx = (((start + i) % frame) + frame) % frame
      this.outAcc[idx] += re[i] * 0.5
    }
    // The oldest hop samples are now covered by every frame they will get.
    for (let i = 0; i < this.hop; i++) {
      const idx = (((start + i) % frame) + frame) % frame
      this._push(this.outAcc[idx])
      this.outAcc[idx] = 0
    }
  }

  // Reads input[0..n) and writes output[0..n).
  process(input, output, n = input.length) {
    for (let k = 0; k < n; k++) {
      this.inRing[this.pos % this.frame] = input[k]
      this.pos++
      if (this.pos % this.hop === 0) this._processFrame()
      output[k] = this._pop()
    }
  }

  // A whole clip in one go (offline): pushes one frame plus one hop of zeros
  // after it so the last samples are finished, drops the first frame of output.
  processWhole(input) {
    const length = input.length
    const out = new Float32Array(length)
    const chunk = 4096
    const inBuf = new Float32Array(chunk)
    const outBuf = new Float32Array(chunk)
    const total = length + this.latency + this.hop
    for (let i = 0; i < total; i += chunk) {
      const n = Math.min(chunk, total - i)
      for (let k = 0; k < n; k++) inBuf[k] = i + k < length ? input[i + k] : 0
      this.process(inBuf, outBuf, n)
      for (let k = 0; k < n; k++) {
        const o = i + k - this.latency
        if (o >= 0 && o < length) out[o] = outBuf[k]
      }
    }
    return out
  }
}

// One channel of Spectral repair. timeOf(i) gives the box time in seconds for
// input sample index i (offline: i / sampleRate; live: where the audio sits in
// the source file).
export class SpectralRepairChannel extends StftChannel {
  constructor(sampleRate, timeOf) {
    super(FRAME)
    this.sampleRate = sampleRate
    this.timeOf = timeOf
    this.regions = []
    this.gains = new Float32Array(FRAME / 2 + 1)
  }

  setRegions(regions) {
    this.regions = regions
  }

  // Per-bin gain for a frame centred at box time t: the product over boxes of
  // (1 - inTime * inBand * loss), loss = 1 - 10^(-dB/20).
  _computeGains(t) {
    const gains = this.gains
    gains.fill(1)
    const binHz = this.sampleRate / FRAME
    for (const r of this.regions) {
      if (t < r.startSec || t > r.endSec) continue
      const loss = 1 - Math.pow(10, -r.reductionDb / 20)
      const lo = Math.max(0, Math.ceil(r.lowHz / binHz))
      const hi = Math.min(FRAME / 2, Math.floor(r.highHz / binHz))
      for (let b = lo; b <= hi; b++) gains[b] *= 1 - loss
    }
  }

  _hasActiveBox(t) {
    for (const r of this.regions) if (t >= r.startSec && t <= r.endSec) return true
    return false
  }

  shape(re, im, centreIndex) {
    const centre = this.timeOf(centreIndex)
    // No box here: the windowed samples overlap-add straight back (unity).
    if (!this._hasActiveBox(centre)) return
    fft(re, im, false)
    this._computeGains(centre)
    for (let b = 0; b <= FRAME / 2; b++) {
      const g = this.gains[b]
      re[b] *= g
      im[b] *= g
      if (b > 0 && b < FRAME / 2) {
        re[FRAME - b] *= g
        im[FRAME - b] *= g
      }
    }
    fft(re, im, true)
  }
}

// Offline: a whole clip. channels are Float32Arrays; regions' times are
// seconds from the start of the clip. Returns new Float32Arrays, same length.
export function repairChannels(channels, sampleRate, regions) {
  return channels.map((input) => {
    const ch = new SpectralRepairChannel(sampleRate, (i) => i / sampleRate)
    ch.setRegions(regions)
    return ch.processWhole(input)
  })
}
