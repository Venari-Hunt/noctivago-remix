// Runs inside an AudioWorklet: the DSP file's text (spectralRepairDsp.js, with
// its `export`s stripped) is put in front of this one, see SpectralStage.js.
// Plain script: no imports here.
//
// One processor per voice. It turns down the bins inside each box at the box's
// time in the SOURCE file, so it needs to know where in the source the audio
// now flowing in comes from. The page sends an anchor every frame:
// { ctxTime, t0, rate }: at audio-context time ctxTime the audio was at source
// time t0, moving rate source-seconds per second (speed, negative when the
// voices play the reversed copy). The saved clip uses the same DSP over the
// same boxes, so what you hear is what gets saved.
class SpectralRepairProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.channels = []
    this.regions = []
    this.anchor = null
    this.firstFrame = null
    this.port.onmessage = (event) => {
      const msg = event.data
      if (msg.regions) {
        this.regions = msg.regions
        for (const ch of this.channels) ch.setRegions(this.regions)
      }
      if (msg.anchor) this.anchor = msg.anchor
    }
  }

  // Box time (source seconds) of input sample index i, counted from the first
  // block this processor saw. With no anchor yet no box is active (NaN).
  timeOf(i) {
    const a = this.anchor
    if (!a) return NaN
    const ctxTime = (this.firstFrame + i) / sampleRate
    return a.t0 + (ctxTime - a.ctxTime) * a.rate
  }

  process(inputs, outputs) {
    const output = outputs[0]
    const input = inputs[0]
    if (this.firstFrame === null) this.firstFrame = currentFrame
    while (this.channels.length < output.length) {
      const ch = new SpectralRepairChannel(sampleRate, (i) => this.timeOf(i))
      ch.setRegions(this.regions)
      this.channels.push(ch)
    }
    for (let c = 0; c < output.length; c++) {
      const src = input && input.length ? input[Math.min(c, input.length - 1)] : null
      this.channels[c].process(src || new Float32Array(output[c].length), output[c], output[c].length)
    }
    return true
  }
}
registerProcessor('noctivago-spectral-repair', SpectralRepairProcessor)
