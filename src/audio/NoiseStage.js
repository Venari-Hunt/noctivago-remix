// Live Noise reduction (one engine). An AudioWorklet running the same spectral
// subtraction the app saves with (noiseReductionDsp.js), wired in right after
// the source, before Spectral repair - the order the saved clip runs them. Only
// wired while there is a noise profile, so a sound without noise reduction plays
// straight through with no extra delay (this one adds one 2048-sample frame,
// about 46 ms, equal for both voices).
import spectralDsp from './spectralRepairDsp.js?raw'
import noiseDsp from './noiseReductionDsp.js?raw'
import workletSource from './noiseReductionWorklet.js?raw'

const MODULE_KEY = Symbol('noctivago-noise-reduction-module')

function loadModule(context) {
  if (!context[MODULE_KEY]) {
    const strip = (text) => text.replace(/^export /gm, '').replace(/^import .*$/gm, '')
    const code = strip(spectralDsp) + '\n' + strip(noiseDsp) + '\n' + workletSource
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    context[MODULE_KEY] = context.audioWorklet.addModule(url)
  }
  return context[MODULE_KEY]
}

export class NoiseStage {
  constructor(context, source, destination) {
    this.context = context
    this.source = source
    this.destination = destination
    this.node = null
    this.wired = false
    this.profile = null
    this.strengthDb = 12
    this._creating = false
    this._disposed = false
  }

  // profile: Float32Array from computeNoiseProfile, or null for no noise reduction.
  set(profile, strengthDb) {
    this.profile = profile
    this.strengthDb = strengthDb
    if (profile && !this.node && !this._creating) this._create()
    this._sync()
  }

  _create() {
    this._creating = true
    loadModule(this.context)
      .then(() => {
        this._creating = false
        if (this._disposed) return
        this.node = new AudioWorkletNode(this.context, 'noctivago-noise-reduction', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
        this._sync()
      })
      .catch((err) => {
        this._creating = false
        console.error('Remix: noise reduction stage failed to start', err)
      })
  }

  _sync() {
    if (!this.node) return
    this.node.port.postMessage({ profile: this.profile, strength: this.strengthDb })
    const wanted = Boolean(this.profile)
    if (wanted && !this.wired) {
      this.source.disconnect(this.destination)
      this.source.connect(this.node)
      this.node.connect(this.destination)
      this.wired = true
    } else if (!wanted && this.wired) {
      this.source.disconnect(this.node)
      this.node.disconnect(this.destination)
      this.source.connect(this.destination)
      this.wired = false
    }
  }

  dispose() {
    this._disposed = true
    if (this.node) {
      try {
        this.node.disconnect()
      } catch {
        // already disconnected
      }
    }
    this.node = null
    this.wired = false
  }
}
