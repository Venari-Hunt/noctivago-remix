import { routeDevAudioOutput } from './devAudioOutput.js'

export class AudioEngine {
  constructor() {
    this.context = new AudioContext()
    this.masterGain = this.context.createGain()
    this.masterGain.connect(this.context.destination)
    routeDevAudioOutput(this.context)
  }

  async resume() {
    if (this.context.state === 'suspended') await this.context.resume()
  }
}
