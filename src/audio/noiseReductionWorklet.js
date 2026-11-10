// Runs inside an AudioWorklet: spectralRepairDsp.js and noiseReductionDsp.js
// (their `export`s and `import` stripped) are put in front of this file, see
// NoiseStage.js. Plain script: no imports here.
//
// One processor per voice. The page sends { profile, strength }: the noise
// profile (average power per bin, from computeNoiseProfile) and the strength in
// dB. With no profile the audio passes straight through. The saved clip runs the
// same DSP, so what you hear is what gets saved.
class NoiseReductionProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.channels = []
    this.profile = null
    this.strength = DEFAULT_STRENGTH_DB
    this.port.onmessage = (event) => {
      const msg = event.data
      if ('profile' in msg) this.profile = msg.profile
      if ('strength' in msg) this.strength = msg.strength
      for (const ch of this.channels) {
        ch.setProfile(this.profile)
        ch.setStrength(this.strength)
      }
    }
  }

  process(inputs, outputs) {
    const output = outputs[0]
    const input = inputs[0]
    while (this.channels.length < output.length) {
      const ch = new NoiseReductionChannel()
      ch.setProfile(this.profile)
      ch.setStrength(this.strength)
      this.channels.push(ch)
    }
    for (let c = 0; c < output.length; c++) {
      const src = input && input.length ? input[Math.min(c, input.length - 1)] : null
      this.channels[c].process(src || new Float32Array(output[c].length), output[c], output[c].length)
    }
    return true
  }
}
registerProcessor('noctivago-noise-reduction', NoiseReductionProcessor)
