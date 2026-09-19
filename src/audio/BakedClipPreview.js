const RAMP_SECONDS = 0.15

// The "Saved" half of the Remix preview toggle - reported directly:
// "Everything modifiable on the remix tab should be audible on the remix
// tab preview... If this isn't possible then when you hit save and an audio
// is baked you should be able to alternate between the baked audio and the
// preview." PreviewSource's live Web Audio chain can't accurately preview
// everything ffmpeg bakes (Doppler and Reverse have no live preview at all;
// Pitch is only a rough approximation - see PreviewSource.js's own doc
// comments) - rather than building real-time equivalents for each of those
// (a real-time pitch-bend engine for Doppler in particular is a lot of new
// DSP work for a bake-only, non-interactive effect), this plays the actual
// baked clip file instead, so switching to "Saved" is always 100% truthful
// to what the Mixer will really play.
//
// Deliberately minimal next to PreviewSource: no crossfade voices (the
// baked clip already has its own seam crossfade baked in by ffmpeg), no
// filter chain (already baked in) - just the decoded clip on a looping
// AudioBufferSourceNode through a single volume GainNode.
//
// BUG FIX (v0.1.222): this used to be an <audio loop> element, and
// Chromium doesn't loop media elements gaplessly. Measured via CDP on a
// pink-noise clip: 7.85 ms of pure silence exactly at every restart, which
// is the click the owner kept hearing "once the saved audio restarts" no
// matter how the seam itself was baked. A native buffer loop (the same
// thing the Mixer's BufferSoundSource uses) measured zero dropout on the
// same clip. It also reads the file once and closes it, so a re-bake can't
// hit the Windows rename lock v0.1.214 had to work around.
export class BakedClipPreview {
  constructor(engine, soundId, volume, presetId = null) {
    this.engine = engine
    this.volume = volume
    this.playing = false
    this.buffer = null
    this._node = null
    this._offset = 0
    this._startedAt = 0
    this._fadingNode = null
    this._disposed = false

    const ctx = engine.context
    this.inputNode = ctx.createGain()
    this.outputGainNode = ctx.createGain()
    this.outputGainNode.gain.value = 0
    this.inputNode.connect(this.outputGainNode)
    this.outputGainNode.connect(engine.masterGain)

    // Live spectrum analyzer tap for the EQ graph's backdrop - reported
    // directly ("the spectogram isn't visible either with the saved audio,
    // it is imperative that it works"). Tapped off the raw clip before the
    // volume gain, the same "decoupled from anything downstream" pattern
    // PreviewSource/WholeMixChain/SoundGroupChain all use. The clip already
    // has every filter baked in, so this is simply the actual final signal.
    this.analyserFeedNode = ctx.createGain()
    this.analyserFeedNode.gain.value = 1
    this.inputNode.connect(this.analyserFeedNode)
    this.analyserNode = ctx.createAnalyser()
    this.analyserNode.fftSize = 2048
    this.analyserFeedNode.connect(this.analyserNode)

    // variant=clip - see src/main/index.js's sound:// protocol handler. The
    // `v=` cache-buster matters: a Save in this same tab re-renders the clip
    // at this exact URL moments after a previous instance fetched it, and
    // index.js recreates this class right after each bake. `presetId`
    // resolves bake-eligibility against this editing session's preset
    // (library.js's getLoopClipPathForId).
    const url = `sound://${soundId}?variant=clip&v=${Date.now()}&presetId=${presetId ?? ''}`
    // Never rejects: a missing or broken clip leaves `buffer` null, and
    // play() reports it instead.
    this._ready = this._load(url).catch((err) => {
      this.error = err
    })
  }

  async _load(url) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Saved audio unavailable (${response.status})`)
    const buffer = await this.engine.context.decodeAudioData(await response.arrayBuffer())
    if (!this._disposed) this.buffer = buffer
  }

  get duration() {
    return this.buffer ? this.buffer.duration : NaN
  }

  // Clip-relative position, wrapped into [0, duration).
  get currentTime() {
    if (!this.buffer) return 0
    const t = this.playing ? this._offset + (this.engine.context.currentTime - this._startedAt) : this._offset
    return t % this.buffer.duration
  }

  waitForMetadata() {
    return this._ready.then(() => this.duration)
  }

  _startNode() {
    const ctx = this.engine.context
    const node = ctx.createBufferSource()
    node.buffer = this.buffer
    node.loop = true
    node.connect(this.inputNode)
    node.start(0, this._offset)
    this._node = node
    this._startedAt = ctx.currentTime
  }

  static _halt(node) {
    try {
      node.stop()
    } catch {
      // already stopped
    }
    node.disconnect()
  }

  // Stops the playing node now, or lets it ring out under pause()'s fade.
  _stopNode(fadeUntil = 0) {
    if (this._fadingNode) BakedClipPreview._halt(this._fadingNode)
    this._fadingNode = null
    const node = this._node
    this._node = null
    if (!node) return
    if (fadeUntil <= 0) {
      BakedClipPreview._halt(node)
      return
    }
    this._fadingNode = node
    node.stop(fadeUntil)
    node.onended = () => {
      node.disconnect()
      if (this._fadingNode === node) this._fadingNode = null
    }
  }

  scrubTo(t) {
    if (!this.buffer) {
      this._offset = Math.max(0, t || 0)
      return
    }
    this._offset = Math.min(Math.max(t || 0, 0), Math.max(0, this.buffer.duration - 1e-6))
    if (this.playing) {
      this._stopNode()
      this._startNode()
    }
  }

  async play() {
    if (this.playing) return
    await this._ready
    if (this._disposed) return
    if (!this.buffer) throw this.error ?? new Error('Saved audio unavailable')
    // Also cuts a previous pause's fade-out that may still be ringing.
    this._stopNode()
    this._offset = this._offset % this.buffer.duration
    this._startNode()
    const now = this.engine.context.currentTime
    this.outputGainNode.gain.cancelScheduledValues(now)
    this.outputGainNode.gain.setValueAtTime(this.outputGainNode.gain.value, now)
    this.outputGainNode.gain.linearRampToValueAtTime(this.volume, now + RAMP_SECONDS)
    this.playing = true
  }

  pause() {
    if (!this.playing) return
    this._offset = this.currentTime
    this.playing = false
    const now = this.engine.context.currentTime
    this.outputGainNode.gain.cancelScheduledValues(now)
    this.outputGainNode.gain.setValueAtTime(this.outputGainNode.gain.value, now)
    this.outputGainNode.gain.linearRampToValueAtTime(0, now + RAMP_SECONDS)
    this._stopNode(now + RAMP_SECONDS + 0.02)
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
    this._disposed = true
    this.playing = false
    this._stopNode()
    this.buffer = null
    this.inputNode.disconnect()
    this.outputGainNode.disconnect()
    this.analyserFeedNode.disconnect()
    this.analyserNode.disconnect()
  }
}
