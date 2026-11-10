// Live pitch (one engine). A Signalsmith Stretch node, the same engine the app
// saves with (src/main/ffmpeg/pitchShift.js), sits right after each voice's
// source: the <audio> element plays at Speed with its own pitch-keeping
// stretch, and this node shifts the pitch in semitones with no change to
// tempo. Doppler and Fluctuation pitch ride the same node as a changing
// semitone value, so there is one pitch path for all three.
//
// The node is only wired in while a shift is needed, so a sound with neutral
// pitch plays straight through with no extra delay (the engine adds about
// 120 ms, equal for both voices so the loop crossfade is unaffected).
import SignalsmithStretch from 'signalsmith-stretch'

// Below this change the node is left alone (no message to the audio thread).
const MIN_STEP_SEMITONES = 0.005

export class PitchStage {
  constructor(context, sourceNode, destination) {
    this.context = context
    this.sourceNode = sourceNode
    this.destination = destination
    this.node = null
    this.wired = false
    this.wanted = false
    this.semitones = 0
    this._creating = null
    this._disposed = false
  }

  // semitones: the shift to apply right now. 0 unwires the node.
  set(semitones) {
    const wanted = Math.abs(semitones) >= MIN_STEP_SEMITONES
    this.wanted = wanted
    if (wanted && !this.node && !this._creating) this._create()
    if (!this.node) {
      this.semitones = semitones
      return
    }
    if (wanted && !this.wired) this._wire()
    else if (!wanted && this.wired) this._unwire()
    if (wanted && Math.abs(semitones - this.semitones) >= MIN_STEP_SEMITONES) {
      this.node.schedule({ semitones })
    }
    this.semitones = semitones
  }

  _create() {
    this._creating = SignalsmithStretch(this.context, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
      .then((node) => {
        this._creating = null
        if (this._disposed) {
          node.disconnect()
          return
        }
        node.schedule({ active: true, semitones: this.semitones })
        this.node = node
        this.set(this.semitones)
      })
      .catch((err) => {
        this._creating = null
        console.error('Remix: pitch stage failed to start', err)
      })
  }

  _wire() {
    this.sourceNode.disconnect(this.destination)
    this.sourceNode.connect(this.node)
    this.node.connect(this.destination)
    this.wired = true
  }

  _unwire() {
    this.sourceNode.disconnect(this.node)
    this.node.disconnect(this.destination)
    this.sourceNode.connect(this.destination)
    this.wired = false
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
