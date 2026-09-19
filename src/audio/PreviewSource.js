import { createReverbImpulse } from './reverbIR.js'
import { PanStage } from './PanStage.js'
import { SoundFluctuation } from './Modulator.js'
import { NoiseGate } from './NoiseGate.js'
import { rampEqualPower } from './equalPowerRamp.js'

const RAMP_SECONDS = 0.15
const LOOP_EPSILON_SECONDS = 0.03
const FILTER_SMOOTHING_SECONDS = 0.01
// Matches src/renderer/audio/SoundSource.js's core-playback copy of this
// same echo design - see that file for the full rationale (feedback delay
// tapped off the dry signal, one knob driving both send and feedback gain).
const MAX_ECHO_DELAY_SECONDS = 2.0

// Linear interpolation between a volume envelope's {position, gain} points
// (position 0..1, already sorted ascending - LoopEditor's own point-editing
// keeps them sorted, see its own comment). Mirrors src/main/ffmpeg's
// volumeEnvelope.js sampler (a completely different runtime, main-process
// ffmpeg baking vs. this live Web Audio preview) and src/renderer/audio/
// SoundSource.js's copy for the Mixer's stream-mode fallback - three
// independent copies for three separate JS realms, this plugin's usual
// cross-directory-import reason.
function sampleEnvelopeGain(points, position) {
  if (points.length === 0) return 1
  if (position <= points[0].position) return points[0].gain
  const last = points[points.length - 1]
  if (position >= last.position) return last.gain
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (position >= a.position && position <= b.position) {
      const span = b.position - a.position
      const t = span > 0 ? (position - a.position) / span : 0
      return a.gain + (b.gain - a.gain) * t
    }
  }
  return 1
}

// 'off' is a pseudo-type (not a real BiquadFilterNode type) - mapped to
// 'allpass' (leaves the amplitude spectrum unchanged, a true no-op for
// tone-shaping) rather than special-casing it out of the chain entirely.
// A muted band takes the same bypass regardless of its own real type,
// non-destructively (mute never touches band.type). Mirrors SoundSource.js's
// identical helper.
function eqNodeType(band) {
  return band.muted || band.type === 'off' ? 'allpass' : (band.type ?? 'peaking')
}

// Only the four filter-*shaped* types have a real "slope" (rolloff
// steepness) concept - peaking/shelf types are gain-shaped, 'off' does
// nothing. BiquadFilterNode is inherently one fixed 12dB/octave stage with
// no slope parameter of its own, so "Steep" is real cascading: N identical
// stages chained in series, each stage multiplying the rolloff by another
// ~12dB/octave. Mirrors SoundSource.js's identical helper (and EqEditor.js's
// copy, used for the response-curve preview) - duplicated per this plugin's
// usual cross-directory-import reason.
const SLOPE_CAPABLE_EQ_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch']
const STEEP_STAGE_COUNT = 4
function eqBandStageCount(band) {
  return band.slope === 'steep' && SLOPE_CAPABLE_EQ_TYPES.includes(band.type) ? STEEP_STAGE_COUNT : 1
}

// One playback "voice": its own <audio> element and full filter chain, so
// two voices can play simultaneously and be crossfaded against each other -
// see PreviewSource's _tick()/_startCrossfade() for how they're driven.
// Each voice has its own crossfadeGain, separate from PreviewSource's
// shared outputGainNode (which only ever handles the overall Play/Pause
// envelope) - that separation is what lets two voices overlap smoothly at
// a loop seam without fighting the volume ramp.
function createVoice(engine, soundId) {
  const audioEl = new Audio()
  audioEl.crossOrigin = 'anonymous'
  audioEl.preload = 'auto'
  audioEl.src = `sound://${soundId}`

  const sourceNode = engine.context.createMediaElementSource(audioEl)

  // Noise gate - first in the chain, before highpass, mirroring core's
  // LocalFileSoundSource. One per voice (like every other filter node here),
  // since the chain is per-voice up to crossfadeGain.
  const noiseGate = new NoiseGate(engine.context)

  const highpassNode = engine.context.createBiquadFilter()
  highpassNode.type = 'highpass'
  highpassNode.frequency.value = 0

  const lowpassNode = engine.context.createBiquadFilter()
  lowpassNode.type = 'lowpass'
  lowpassNode.frequency.value = 20000

  // Parametric EQ - a chain of BiquadFilterNodes, one *group* per band the
  // user has actually added on the graph (see EqEditor.js's +/trash
  // controls), mirrors core's LocalFileSoundSource
  // (src/renderer/audio/SoundSource.js) exactly, same position (between
  // lowpass and the overall filter gain) so this preview and the real Mixer
  // playback agree. A band's own group is 1 node normally, or
  // STEEP_STAGE_COUNT identical cascaded nodes when that band's slope is
  // 'steep' (see eqBandStageCount) - eqNodes stays the flat, fully-ordered
  // list of every real node for connect/disconnect purposes, eqNodeGroups is
  // the same nodes re-grouped per band for per-band parameter updates.
  // Starts empty - a voice exists before any sound/filters are actually
  // known - applyFiltersToVoice below rebuilds this chain (via
  // rebuildEqChain) the first time real filters arrive, and again any time
  // a band's own node count changes (added/removed, or its type/slope
  // changes how many stages it needs).
  const eqNodes = []
  const eqNodeGroups = []

  const filterGainNode = engine.context.createGain()
  filterGainNode.gain.value = 1

  const echoDelayNode = engine.context.createDelay(MAX_ECHO_DELAY_SECONDS)
  echoDelayNode.delayTime.value = 0

  const echoSendGain = engine.context.createGain()
  echoSendGain.gain.value = 0

  const echoFeedbackGain = engine.context.createGain()
  echoFeedbackGain.gain.value = 0

  // Reverb: a real convolution reverb (ConvolverNode), mirroring
  // SoundSource.js's identical addition - a third parallel send off
  // filterGainNode, independent of Echo rather than chained after it. See
  // reverbIR.js for why the impulse response is synthetic (procedurally
  // generated) rather than a bundled recorded IR.
  const reverbSendGain = engine.context.createGain()
  reverbSendGain.gain.value = 0
  const reverbConvolver = engine.context.createConvolver()
  reverbConvolver.normalize = true

  const crossfadeGain = engine.context.createGain()
  crossfadeGain.gain.value = 0

  sourceNode.connect(noiseGate.input)
  noiseGate.output.connect(highpassNode)
  highpassNode.connect(lowpassNode)
  const eqChainEnd = eqNodes.reduce((prev, node) => {
    prev.connect(node)
    return node
  }, lowpassNode)
  eqChainEnd.connect(filterGainNode)
  filterGainNode.connect(crossfadeGain)

  filterGainNode.connect(echoSendGain)
  echoSendGain.connect(echoDelayNode)
  echoDelayNode.connect(echoFeedbackGain)
  echoFeedbackGain.connect(echoDelayNode)
  echoDelayNode.connect(crossfadeGain)

  filterGainNode.connect(reverbSendGain)
  reverbSendGain.connect(reverbConvolver)
  reverbConvolver.connect(crossfadeGain)

  return { audioEl, sourceNode, noiseGate, highpassNode, lowpassNode, eqNodes, eqNodeGroups, eqTopology: '', filterGainNode, echoDelayNode, echoSendGain, echoFeedbackGain, reverbSendGain, reverbConvolver, reverbSizeMs: 0, crossfadeGain }
}

// Tears down and rebuilds a voice's eqNodes chain to match a new band
// topology (band count, or any band's own stage count via type/slope) -
// mirrors SoundSource.js's identical _rebuildEqChain method. .disconnect()
// with no arguments removes every outgoing connection from a node, so this
// is safe whether the old chain was empty (lowpassNode wired directly to
// filterGainNode) or had N nodes. New nodes get their values set directly
// (no smoothing) since there's no previous value on a brand-new node to
// smooth *from*. Each band becomes its own internal cascade of
// eqBandStageCount(band) identical nodes chained in series (1 normally, 4
// for a 'steep' filter-shaped band) - stacking identical stages is exactly
// how a steeper rolloff is achieved, since BiquadFilterNode has no slope
// parameter of its own.
function rebuildEqChain(voice, context, eq) {
  voice.lowpassNode.disconnect()
  for (const node of voice.eqNodes) node.disconnect()
  voice.eqNodeGroups = eq.map((band) => {
    const stageCount = eqBandStageCount(band)
    return Array.from({ length: stageCount }, () => {
      const node = context.createBiquadFilter()
      node.type = eqNodeType(band)
      node.frequency.value = band.freqHz
      node.Q.value = band.q
      node.gain.value = band.gainDb
      return node
    })
  })
  voice.eqNodes = voice.eqNodeGroups.flat()
  voice.eqTopology = eq.map(eqBandStageCount).join(',')
  const eqChainEnd = voice.eqNodes.reduce((prev, node) => {
    prev.connect(node)
    return node
  }, voice.lowpassNode)
  eqChainEnd.connect(voice.filterGainNode)
}

function applyFiltersToVoice(voice, context, filters) {
  const { highpassHz, lowpassHz, gainDb, echoDelayMs = 0, echoDecay = 0, reverbSizeMs = 0, reverbMix = 0, eq = [] } = filters
  const now = context.currentTime
  voice.noiseGate.configure(filters)
  voice.highpassNode.frequency.setTargetAtTime(highpassHz, now, FILTER_SMOOTHING_SECONDS)
  voice.lowpassNode.frequency.setTargetAtTime(lowpassHz, now, FILTER_SMOOTHING_SECONDS)
  voice.filterGainNode.gain.setTargetAtTime(Math.pow(10, gainDb / 20), now, FILTER_SMOOTHING_SECONDS)
  voice.echoDelayNode.delayTime.setTargetAtTime(echoDelayMs / 1000, now, FILTER_SMOOTHING_SECONDS)
  voice.echoSendGain.gain.setTargetAtTime(echoDecay, now, FILTER_SMOOTHING_SECONDS)
  voice.echoFeedbackGain.gain.setTargetAtTime(echoDecay, now, FILTER_SMOOTHING_SECONDS)
  voice.reverbSendGain.gain.setTargetAtTime(reverbMix, now, FILTER_SMOOTHING_SECONDS)
  if (reverbSizeMs !== voice.reverbSizeMs) {
    voice.reverbSizeMs = reverbSizeMs
    voice.reverbConvolver.buffer = reverbSizeMs > 0 ? createReverbImpulse(context, reverbSizeMs / 1000) : null
  }
  // The EQ chain's shape now varies with both how many bands exist AND how
  // many stages each one needs (a plain length check alone can't tell a
  // type/slope change apart from a same-length no-op) - only rebuild the
  // chain (real work: disconnecting/recreating nodes) when the per-band
  // topology fingerprint actually changes; an in-place param update on every
  // node already in a band's own group is enough whenever it hasn't, same
  // pattern as before.
  const topology = eq.map(eqBandStageCount).join(',')
  if (topology !== voice.eqTopology) {
    rebuildEqChain(voice, context, eq)
  } else {
    voice.eqNodeGroups.forEach((group, i) => {
      const band = eq[i]
      const newType = eqNodeType(band)
      for (const node of group) {
        if (node.type !== newType) node.type = newType
        node.frequency.setTargetAtTime(band.freqHz, now, FILTER_SMOOTHING_SECONDS)
        node.Q.setTargetAtTime(band.q, now, FILTER_SMOOTHING_SECONDS)
        node.gain.setTargetAtTime(band.gainDb, now, FILTER_SMOOTHING_SECONDS)
      }
    })
  }
  // Re-establish the spectrum analyser's pre-EQ tap every call, not just
  // once - see the constructor's own comment on voice.analyserFeed for why
  // (rebuildEqChain's lowpassNode.disconnect() above would otherwise sever
  // it whenever the topology branch runs). A no-op when it's already
  // connected.
  voice.lowpassNode.connect(voice.analyserFeed)
}

// Speed previews accurately via playbackRate alone (the browser's own
// default preservesPitch=true keeps a pure tempo change from also shifting
// pitch). Pitch has no equivalent native "shift pitch only" lever on
// <audio> - approximated by disabling preservesPitch and folding the
// desired pitch ratio into the SAME playbackRate value, which necessarily
// also nudges the apparent tempo away from the requested speed for as long
// as a nonzero pitch shift is active. This is a known, accepted trade-off
// (matches the note this feature was scoped from) - the saved clip renders
// speed and pitch independently and accurately via ffmpeg's rubberband
// filter (see src/main/ffmpeg/loopClip.js); this preview is only meant to
// give an immediate, rough sense of direction while dragging, not a
// faithful stand-in for the bake. Reverse has no live preview at all - it
// only takes effect once saved.
// pitchModFactor folds in live pitch fluctuation (see PreviewSource's
// this._fluctuation) - a plain multiplier on playbackRate, same limitation
// as Pitch itself here (also nudges tempo). 1 when no pitch drift is active.
function applySpeedPitchToVoice(voice, speedPitch, pitchModFactor = 1) {
  const speed = speedPitch?.speed ?? 1
  const pitchSemitones = speedPitch?.pitchSemitones ?? 0
  const pitchRatio = Math.pow(2, pitchSemitones / 12)
  voice.audioEl.preservesPitch = pitchSemitones === 0 && pitchModFactor === 1
  voice.audioEl.playbackRate = speed * pitchRatio * pitchModFactor
}

function disposeVoice(voice) {
  voice.audioEl.pause()
  voice.audioEl.removeAttribute('src')
  voice.audioEl.load()
  voice.sourceNode.disconnect()
  voice.noiseGate.dispose()
  voice.highpassNode.disconnect()
  voice.lowpassNode.disconnect()
  for (const node of voice.eqNodes) node.disconnect()
  voice.filterGainNode.disconnect()
  voice.echoDelayNode.disconnect()
  voice.echoSendGain.disconnect()
  voice.echoFeedbackGain.disconnect()
  voice.reverbSendGain.disconnect()
  voice.reverbConvolver.disconnect()
  voice.crossfadeGain.disconnect()
}

// Streams a sound for editing preview (same sound://<id> streaming approach
// as core's LocalFileSoundSource, so this works for files of any length)
// with an insertable live filter chain per voice: source -> highpass ->
// lowpass -> gain -> output. Filter params update instantly via
// BiquadFilterNode/GainNode automation, so dragging a slider gives
// real-time audible feedback with no ffmpeg round-trip - ffmpeg only runs
// once, to bake the final values in when the user saves.
//
// Simulates the loop-boundary crossfade the ffmpeg bake applies (see
// src/main/ffmpeg/loopClip.js) by ping-ponging between two identical voices:
// as the active voice nears loopEnd, the other voice starts playing from
// loopStart and both are cross-faded via their own crossfadeGain nodes,
// so dragging the crossfade slider is audible immediately instead of
// requiring a bake-then-listen round trip. This is only an approximation of
// the baked result - <audio> elements aren't sample-accurate the way the
// ffmpeg render or a decoded AudioBuffer are (same caveat stream-mode
// playback has everywhere else in this app) - good enough to judge "does
// this duration sound right," not a substitute for the real bake.
export class PreviewSource {
  constructor(engine, { soundId, loopStart, loopEnd, volume, looping = true, crossfadeSeconds = 0, speedPitch = null, fluctuation = null }) {
    this.engine = engine
    this.loopStart = loopStart ?? 0
    this.loopEnd = loopEnd ?? null
    this.volume = volume
    this.looping = looping
    this.crossfadeSeconds = crossfadeSeconds
    this.playing = false
    this._rafId = null
    this._pauseTimeoutId = null
    this._crossfading = false
    this._speedPitch = speedPitch
    this._pitchModFactor = 1

    this.voices = [createVoice(engine, soundId), createVoice(engine, soundId)]
    this.activeIndex = 0
    this.voices[0].crossfadeGain.gain.value = 1
    for (const voice of this.voices) applySpeedPitchToVoice(voice, speedPitch)

    // Fluctuation (v0.1.164): one shared drift stage after both crossfade
    // voices combine, so a loop-seam crossfade doesn't fight it. Mirrors
    // core's LocalFileSoundSource - volume rides a 0..1 multiplier below the
    // preview volume, pitch rides playbackRate. Only runs while previewing.
    this.fluctuationGain = engine.context.createGain()
    this.fluctuationGain.gain.value = 1
    this._fluctuation = new SoundFluctuation({
      onVolume: (v) => this.fluctuationGain.gain.setTargetAtTime(v, this.engine.context.currentTime, 0.12),
      onPitch: (semitones) => {
        this._pitchModFactor = Math.pow(2, semitones / 12)
        this._applyPlaybackRate()
      },
      onPan: (v) => this.driftPanStage.setPan(v)
    })
    this._fluctuation.configure(fluctuation ?? {})

    // Volume envelope (per-sound, Loop mode, drag points on the waveform to
    // shape volume over time - Audacity's classic tool). A dedicated gain
    // stage, same pattern as fluctuationGain above and placed right after it
    // (before the sound's own output volume), but driven differently: unlike
    // Fluctuation's open-ended random walk (its own timer callback),
    // envelope is a *fixed* timeline the user authored, so it's driven by
    // actual playback position instead - see setVolumeEnvelope/tickEnvelope,
    // called once per frame from the same tickPreviewPlayhead() rAF loop
    // that already drives the waveform playhead (no separate loop). Unlike
    // Fluctuation, this is never baked live-only forever - it also gets
    // rendered straight into the loop clip's own WAV on Save
    // (src/main/ffmpeg/volumeEnvelope.js), so buffer-mode/"Saved audio"
    // playback never needs this node at all, only the live streaming preview
    // does (same reason every other filter needs a live Web Audio
    // equivalent here despite also being bakeable).
    this.envelopeGain = engine.context.createGain()
    this.envelopeGain.gain.value = 1
    this._volumeEnvelope = null

    // Stereo pan (v0.1.216) - last stage before the preview volume, matching
    // core's LocalFileSoundSource and the ffmpeg bake.
    this.panStage = new PanStage(engine.context, 0)
    // Pan drift (v0.1.217) - a second stage after the static pan, same as
    // core's LocalFileSoundSource/BufferSoundSource.
    this.driftPanStage = new PanStage(engine.context, 0)

    this.outputGainNode = engine.context.createGain()
    this.outputGainNode.gain.value = 0
    for (const voice of this.voices) voice.crossfadeGain.connect(this.fluctuationGain)
    this.fluctuationGain.connect(this.envelopeGain)
    this.envelopeGain.connect(this.panStage.input)
    this.panStage.output.connect(this.driftPanStage.input)
    this.driftPanStage.output.connect(this.outputGainNode)
    this.outputGainNode.connect(engine.masterGain)

    // Real-time spectrum analyzer tap for the Remix EQ graph's live backdrop
    // (see EqEditor.js's tickSpectrum). BUG FIX (v0.1.51): this used to tap
    // outputGainNode directly, which carries the preview volume slider's
    // level AND the play/pause fade envelope - fixed by giving both voices a
    // second, parallel connection into a dedicated fixed-at-1 gain node
    // instead, decoupled from the volume slider.
    // BUG FIX (this pass): the tap point was crossfadeGain - *after* the EQ
    // chain - so the spectrum visibly shrank/reshaped as a band was dragged,
    // reported directly ("This creates a false sense that you're not cutting
    // out the frequencies" - the live-reacting display made it hard to judge
    // "how much of the original signal is actually there" against a moving
    // target). Retapped from lowpassNode instead - after the app's other two
    // filter controls (highpass/lowpass, which the user did *not* ask to
    // exclude) but *before* the parametric EQ bands - so the spectrum now
    // shows a stable reference of what's arriving at the EQ, while
    // drawEq's separate "will be cut" overlay (computed from the same
    // response-curve data already used for the curve line) shows what the
    // *current* band config would do to it. voice.analyserFeed is set once
    // here, then (re-)connected at the end of every applyFiltersToVoice call
    // rather than just once - rebuildEqChain's own `lowpassNode.disconnect()`
    // (needed to re-wire the EQ chain itself on a topology change) would
    // otherwise silently sever this tap too, since .disconnect() with no
    // arguments clears *every* outgoing connection from a node. Re-connecting
    // an already-connected pair is a harmless no-op, so this stays correct
    // whether or not a rebuild actually happened on a given call.
    this.analyserFeedNode = engine.context.createGain()
    this.analyserFeedNode.gain.value = 1
    for (const voice of this.voices) voice.analyserFeed = this.analyserFeedNode

    this.analyserNode = engine.context.createAnalyser()
    this.analyserNode.fftSize = 2048
    this.analyserFeedNode.connect(this.analyserNode)
  }

  // LoopEditor's playhead tracking and manual currentTime pokes only ever
  // touch whichever voice is currently active - this getter (rather than
  // renaming every external caller) keeps PreviewSource a drop-in
  // replacement for the single-<audio> version it replaced.
  get audioEl() {
    return this.voices[this.activeIndex].audioEl
  }

  // Same shape as BakedClipPreview.currentTime (source-file time here).
  get currentTime() {
    return this.audioEl.currentTime
  }

  _inactiveVoice() {
    return this.voices[1 - this.activeIndex]
  }

  waitForMetadata() {
    const el = this.voices[0].audioEl
    if (el.readyState >= 1) return Promise.resolve(el.duration)
    return new Promise((resolve) => {
      el.addEventListener('loadedmetadata', () => resolve(el.duration), { once: true })
    })
  }

  setLoopPoints(loopStart, loopEnd) {
    this.loopStart = loopStart
    this.loopEnd = loopEnd
    this._resetToSingleVoice()
  }

  setLooping(looping) {
    this.looping = looping
    if (!looping) this._resetToSingleVoice()
  }

  setCrossfadeSeconds(seconds) {
    this.crossfadeSeconds = seconds
  }

  setFilters(filters) {
    for (const voice of this.voices) applyFiltersToVoice(voice, this.engine.context, filters)
    this._syncGates()
    this.setVolumeEnvelope(filters.volumeEnvelope)
    if (!this.panStage.hasPan(filters.pan ?? 0)) this.panStage.setPan(filters.pan ?? 0)
  }

  // Only ever called from setFilters (never a separate call site elsewhere)
  // so every place that already updates preview filters picks this up for
  // free. `null`/disabled/fewer-than-2-points all collapse to "no envelope" -
  // resets the gain back to neutral (1) with a short ramp rather than
  // snapping, so turning it off mid-playback doesn't click.
  setVolumeEnvelope(envelope) {
    const active = envelope && envelope.enabled && Array.isArray(envelope.points) && envelope.points.length >= 2
    this._volumeEnvelope = active ? envelope : null
    if (!active) this.envelopeGain.gain.setTargetAtTime(1, this.engine.context.currentTime, 0.05)
  }

  // Called once per frame from index.js's tickPreviewPlayhead() (the same
  // rAF loop already driving the waveform playhead) - not pre-scheduled
  // AudioParam automation, because the <audio>-element-driven preview's
  // currentTime is only approximately known ahead of time (same documented
  // imprecision every other stream-mode timing in this app has); instead
  // this re-derives gain(t) from the live position every tick and re-arms a
  // short setTargetAtTime each time, so it self-corrects rather than relying
  // on a schedule computed from a clock that might drift. currentTime is
  // already the *original file's* absolute time (loopStart-relative math
  // happens here, not in the caller) - matches how setLoopPoints/loopStart
  // already work throughout this class.
  tickEnvelope(currentTime) {
    if (!this._volumeEnvelope) return
    const loopStart = this.loopStart
    const loopEnd = this.loopEnd ?? loopStart
    const span = Math.max(loopEnd - loopStart, 0.0001)
    const position = Math.min(Math.max((currentTime - loopStart) / span, 0), 1)
    const gain = sampleEnvelopeGain(this._volumeEnvelope.points, position)
    this.envelopeGain.gain.setTargetAtTime(gain, this.engine.context.currentTime, 0.05)
  }

  // The noise gate's poll loop only runs while previewing and while the gate
  // is actually enabled - same start/stop lifecycle as core's copy.
  _syncGates() {
    for (const voice of this.voices) voice.noiseGate.sync(this.playing)
  }

  setSpeedPitch(speedPitch) {
    this._speedPitch = speedPitch
    this._applyPlaybackRate()
  }

  _applyPlaybackRate() {
    for (const voice of this.voices) applySpeedPitchToVoice(voice, this._speedPitch, this._pitchModFactor)
  }

  setFluctuation(fluctuation) {
    this._fluctuation.configure(fluctuation ?? {})
    this._fluctuation.sync(this.playing)
  }

  // Cancels any in-progress crossfade and collapses back to a single active
  // voice - used whenever loop points change or scrubbing happens, since
  // resuming a crossfade against a moved boundary (or a manually-moved
  // playhead) has no sensible meaning.
  _resetToSingleVoice() {
    const now = this.engine.context.currentTime
    const active = this.voices[this.activeIndex]
    const inactive = this._inactiveVoice()
    active.crossfadeGain.gain.cancelScheduledValues(now)
    active.crossfadeGain.gain.setValueAtTime(1, now)
    inactive.crossfadeGain.gain.cancelScheduledValues(now)
    inactive.crossfadeGain.gain.setValueAtTime(0, now)
    if (this._crossfading) inactive.audioEl.pause()
    this._crossfading = false
  }

  scrubTo(t) {
    this._resetToSingleVoice()
    this.voices[this.activeIndex].audioEl.currentTime = t
  }

  _loopEnd() {
    return this.loopEnd ?? this.voices[0].audioEl.duration
  }

  _effectiveCrossfade() {
    const duration = this._loopEnd() - this.loopStart
    if (!Number.isFinite(duration) || duration <= 0) return 0
    return Math.max(0, Math.min(this.crossfadeSeconds, duration / 4))
  }

  _tick() {
    if (!this.playing) return
    const active = this.voices[this.activeIndex]
    const end = this._loopEnd()
    const fade = this.looping ? this._effectiveCrossfade() : 0

    if (!this.looping) {
      if (Number.isFinite(end) && active.audioEl.currentTime >= end - LOOP_EPSILON_SECONDS) {
        this.pause()
        this.onEnded?.()
        return
      }
    } else if (fade <= 0) {
      // No usable crossfade window (disabled, or too short a loop) - same
      // hard seek-back every other playback mode in this app falls back to.
      if (Number.isFinite(end) && active.audioEl.currentTime >= end - LOOP_EPSILON_SECONDS) {
        active.audioEl.currentTime = this.loopStart
      }
    } else if (!this._crossfading) {
      if (Number.isFinite(end) && active.audioEl.currentTime >= end - fade) {
        this._startCrossfade(fade)
      }
    } else if (Number.isFinite(end) && active.audioEl.currentTime >= end - LOOP_EPSILON_SECONDS) {
      this._finishCrossfade()
    }

    this._rafId = requestAnimationFrame(() => this._tick())
  }

  _startCrossfade(fade) {
    const active = this.voices[this.activeIndex]
    const incoming = this._inactiveVoice()
    const now = this.engine.context.currentTime

    incoming.audioEl.currentTime = this.loopStart
    incoming.audioEl.play().catch(() => {})

    rampEqualPower(active.crossfadeGain.gain, now, fade, 1, 0)
    rampEqualPower(incoming.crossfadeGain.gain, now, fade, 0, 1)

    this._crossfading = true
  }

  _finishCrossfade() {
    const outgoing = this.voices[this.activeIndex]
    outgoing.audioEl.pause()
    this.activeIndex = 1 - this.activeIndex
    this._crossfading = false
  }

  async play() {
    if (this.playing) return
    if (this._pauseTimeoutId) {
      clearTimeout(this._pauseTimeoutId)
      this._pauseTimeoutId = null
    }
    const active = this.voices[this.activeIndex]
    const end = this._loopEnd()
    if (active.audioEl.currentTime < this.loopStart || (Number.isFinite(end) && active.audioEl.currentTime >= end)) {
      active.audioEl.currentTime = this.loopStart
    }
    active.crossfadeGain.gain.setValueAtTime(1, this.engine.context.currentTime)
    await active.audioEl.play()
    const now = this.engine.context.currentTime
    this.outputGainNode.gain.cancelScheduledValues(now)
    this.outputGainNode.gain.setValueAtTime(this.outputGainNode.gain.value, now)
    this.outputGainNode.gain.linearRampToValueAtTime(this.volume, now + RAMP_SECONDS)
    this.playing = true
    this._fluctuation.sync(true)
    this._syncGates()
    this._tick()
  }

  pause() {
    if (!this.playing) return
    const now = this.engine.context.currentTime
    this.outputGainNode.gain.cancelScheduledValues(now)
    this.outputGainNode.gain.setValueAtTime(this.outputGainNode.gain.value, now)
    this.outputGainNode.gain.linearRampToValueAtTime(0, now + RAMP_SECONDS)
    this.playing = false
    this._fluctuation.stop()
    this._syncGates()
    if (this._rafId) cancelAnimationFrame(this._rafId)
    if (this._pauseTimeoutId) clearTimeout(this._pauseTimeoutId)
    this._pauseTimeoutId = setTimeout(() => {
      this._pauseTimeoutId = null
      for (const voice of this.voices) voice.audioEl.pause()
      this._resetToSingleVoice()
    }, RAMP_SECONDS * 1000 + 20)
  }

  setVolume(volume) {
    this.volume = volume
    if (this.playing) {
      const now = this.engine.context.currentTime
      this.outputGainNode.gain.cancelScheduledValues(now)
      this.outputGainNode.gain.linearRampToValueAtTime(volume, now + 0.05)
    }
  }

  dispose() {
    this.playing = false
    if (this._rafId) cancelAnimationFrame(this._rafId)
    if (this._pauseTimeoutId) clearTimeout(this._pauseTimeoutId)
    this._fluctuation.dispose()
    for (const voice of this.voices) disposeVoice(voice)
    this.fluctuationGain.disconnect()
    this.envelopeGain.disconnect()
    this.panStage.dispose()
    this.driftPanStage.dispose()
    this.outputGainNode.disconnect()
    this.analyserFeedNode.disconnect()
    this.analyserNode.disconnect()
  }
}
