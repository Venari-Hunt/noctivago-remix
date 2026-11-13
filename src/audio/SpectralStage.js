// Live Spectral repair (one engine). An AudioWorklet running the same STFT code
// the app saves with (spectralRepairDsp.js), wired in right after the source,
// before the pitch stage - the order the saved clip uses (repair works on source
// time, then Speed/Pitch). Only wired while at least one box exists, so a sound
// without boxes plays straight through with no extra delay (the repair adds one
// frame, about 93 ms, equal for both voices).
import dspSource from './spectralRepairDsp.js?raw'
import workletSource from './spectralRepairWorklet.js?raw'

const MODULE_KEY = Symbol('noctivago-spectral-repair-module')

function loadModule(context) {
  if (!context[MODULE_KEY]) {
    const code = dspSource.replace(/^export /gm, '') + '\n' + workletSource
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    context[MODULE_KEY] = context.audioWorklet.addModule(url)
  }
  return context[MODULE_KEY]
}

// A box the DSP can use, or null: finite numbers, some area, some reduction.
export function usableRegion(r) {
  if (!r) return null
  const startSec = Number(r.startSec)
  const endSec = Number(r.endSec)
  const lowHz = Number(r.lowHz)
  const highHz = Number(r.highHz)
  const reductionDb = Number(r.reductionDb ?? 40)
  if (![startSec, endSec, lowHz, highHz, reductionDb].every(Number.isFinite)) return null
  if (endSec - startSec < 0.005 || highHz - lowHz < 1 || reductionDb <= 0) return null
  const region = { startSec, endSec, lowHz, highHz, reductionDb: Math.min(reductionDb, 80) }
  // A freehand shape: [sec, hz] pairs; a bad pair drops it back to the plain box.
  if (Array.isArray(r.points) && r.points.length >= 3 && r.points.length <= 64 && r.points.every((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))) {
    region.points = r.points.map((p) => [Number(p[0]), Number(p[1])])
  }
  return region
}

export class SpectralStage {
  constructor(context, source, destination) {
    this.context = context
    this.source = source
    this.destination = destination
    this.node = null
    this.wired = false
    this.regions = []
    this._creating = false
    this._disposed = false
  }

  setRegions(regions) {
    this.regions = (regions ?? []).map(usableRegion).filter(Boolean)
    if (this.regions.length > 0 && !this.node && !this._creating) this._create()
    this._sync()
  }

  // Where the audio flowing in now sits in the source file (see the worklet).
  setAnchor(t0, rate) {
    if (this.node && this.wired) this.node.port.postMessage({ anchor: { ctxTime: this.context.currentTime, t0, rate } })
  }

  _create() {
    this._creating = true
    loadModule(this.context)
      .then(() => {
        this._creating = false
        if (this._disposed) return
        this.node = new AudioWorkletNode(this.context, 'noctivago-spectral-repair', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
        this._sync()
      })
      .catch((err) => {
        this._creating = false
        console.error('Remix: spectral repair stage failed to start', err)
      })
  }

  _sync() {
    if (!this.node) return
    this.node.port.postMessage({ regions: this.regions })
    const wanted = this.regions.length > 0
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
