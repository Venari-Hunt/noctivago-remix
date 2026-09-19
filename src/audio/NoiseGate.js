// [bundled copy of src/renderer/audio/NoiseGate.js - the Remix plugin can't
// import outside its own directory; keep in sync if that file changes.]
//
// A downward noise gate for the live playback / preview chains. Web Audio has
// no native gate node - DynamicsCompressorNode only ever acts *above* its
// threshold, never below - so this is a polled envelope follower: an
// AnalyserNode reads the incoming signal's short-term RMS a few dozen times a
// second, and when it sits below the threshold the gate's own GainNode is
// ramped down toward `range` (the reduction floor); back to unity when it
// rises above again. The ramp itself is a sample-accurate setTargetAtTime
// automation, so the coarse poll rate only affects how *promptly* the gate
// reacts, not how smooth it sounds - the same "poll the decision, let Web
// Audio do the smoothing" split Modulator.js (Fluctuation) uses.
//
// This is the live counterpart of the ffmpeg `agate` filter the Remix bake
// applies (src/main/ffmpeg/loopClip.js's buildFilterChain) - close enough for
// a "is my threshold in the right place" preview; the baked clip is the
// source of truth (hear it via Remix's Live edit / Saved audio toggle, or in
// the Mixer once a sound is baked - buffer mode plays the clip with the gate
// already rendered in, so it never needs this node at all).
//
// setInterval, not requestAnimationFrame: a minimized-to-tray window freezes
// rAF outright but only *clamps* setInterval to ~1s, so a gated ambient sound
// keeps behaving (coarsely) in the background instead of sticking open or
// shut - same reasoning as Modulator.js.

const POLL_MS = 25
// Re-close only once the level drops a few dB back below threshold, so a
// signal hovering right at the threshold doesn't machine-gun the gate.
const HYSTERESIS_DB = 3

function dbToGain(db) {
  return Math.pow(10, db / 20)
}

export class NoiseGate {
  constructor(context) {
    this.context = context
    // input feeds both the (inline) output gain and the detector tap.
    this.input = context.createGain()
    this.output = context.createGain()
    this.output.gain.value = 1
    this._analyser = context.createAnalyser()
    this._analyser.fftSize = 1024
    this._buf = new Float32Array(this._analyser.fftSize)
    this.input.connect(this.output)
    this.input.connect(this._analyser)

    this.enabled = false
    this.thresholdDb = -80
    this.floorGain = 1
    this.attackTau = 0.01
    this.releaseTau = 0.05

    this._open = true
    this._timer = null
  }

  // Reads the flat gate fields off a `filters` object (same bag highpassHz /
  // echoDelayMs etc. live on). Off unless a real threshold is set AND a real
  // reduction is asked for - either at its neutral end means "do nothing",
  // matching every other 0-means-off control in this app.
  configure(filters) {
    const f = filters ?? {}
    const thr = Number.isFinite(f.gateThresholdDb) ? f.gateThresholdDb : -80
    const rangeDb = Number.isFinite(f.gateRangeDb) ? f.gateRangeDb : 0
    this.thresholdDb = thr
    this.enabled = thr > -80 && rangeDb > 0
    this.floorGain = dbToGain(-Math.abs(rangeDb))
    // setTargetAtTime reaches ~95% of the way in 3*tau, so tau = ms/3 lands
    // the audible open/close roughly on the requested attack/release time.
    this.attackTau = Math.max(0.001, (Number(f.gateAttackMs) || 10) / 1000 / 3)
    this.releaseTau = Math.max(0.005, (Number(f.gateReleaseMs) || 150) / 1000 / 3)
  }

  // Brings the poll loop in line with whether the sound is actually playing
  // and whether the gate is even enabled - called from play()/pause() and
  // from a live setFilters() while already playing.
  sync(playing) {
    if (playing && this.enabled) this._start()
    else this._stop()
  }

  _start() {
    if (this._timer) return
    this._open = true
    this.output.gain.cancelScheduledValues(this.context.currentTime)
    this.output.gain.setValueAtTime(1, this.context.currentTime)
    this._timer = setInterval(() => this._tick(), POLL_MS)
  }

  _stop() {
    if (!this._timer) return
    clearInterval(this._timer)
    this._timer = null
    this.output.gain.setTargetAtTime(1, this.context.currentTime, 0.02)
  }

  _tick() {
    this._analyser.getFloatTimeDomainData(this._buf)
    let sum = 0
    for (let i = 0; i < this._buf.length; i++) sum += this._buf[i] * this._buf[i]
    const rms = Math.sqrt(sum / this._buf.length)
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity
    const openAt = this._open ? this.thresholdDb - HYSTERESIS_DB : this.thresholdDb
    const shouldOpen = db > openAt
    if (shouldOpen === this._open) return
    this._open = shouldOpen
    this.output.gain.setTargetAtTime(
      shouldOpen ? 1 : this.floorGain,
      this.context.currentTime,
      shouldOpen ? this.attackTau : this.releaseTau
    )
  }

  dispose() {
    this._stop()
    this.input.disconnect()
    this.output.disconnect()
    this._analyser.disconnect()
  }
}
