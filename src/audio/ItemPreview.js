// Remix's per-item preview player (Group and Preset mode rows; rules in
// domain/itemPreview.js). Each sound runs on its own PreviewSource, the same
// live chain Sound mode hears (filters, EQ, space, pan, drift, speed and
// pitch), so a row's Play sounds like the sound in the mix and never
// touches the Mixer. One item plays at a time.
import { PreviewSource } from './PreviewSource.js'
import { NEUTRAL_FILTERS } from '../domain/mixSettings.js'
import { nextGapSeconds, shotVariation } from '../domain/itemPreview.js'
import { biquadQ } from '../domain/eqQ.js'

const filtersOf = (entry) => ({ ...NEUTRAL_FILTERS, ...(entry.filters ?? {}), eq: entry.filters?.eq ?? [] })

// One sound inside a preview: plays its region; a one-shot fires once, or
// again after its gap while repeat is on.
class SoundVoice {
  constructor(engine, plan, destination, { onShot, onDone }) {
    this.plan = plan
    this.repeat = plan.repeat
    this.onShot = onShot
    this.onDone = onDone
    this.stopped = false
    this.timer = null
    this.raf = null
    const e = plan.entry
    this.speedPitch = e.speedPitch ?? null
    this.src = new PreviewSource(engine, {
      soundId: e.id,
      loopStart: e.loopStart,
      loopEnd: e.loopEnd,
      volume: plan.gain,
      looping: plan.kind === 'loop',
      crossfadeSeconds: e.crossfadeSeconds ?? 0.2,
      speedPitch: this.speedPitch,
      fluctuation: e.fluctuation ?? null
    })
    this.src.outputGainNode.disconnect()
    this.src.outputGainNode.connect(destination)
    this.src.onEnded = () => this.ended()
  }

  async start() {
    const duration = await this.src.waitForMetadata()
    if (this.stopped) return
    const e = this.plan.entry
    this.src.setLoopPoints(e.loopStart ?? 0, e.loopEnd ?? duration)
    this.src.setFilters(filtersOf(e))
    this.tick()
    // Inside a group a one-shot starts after a first gap, as in the mix.
    if (this.plan.kind !== 'loop' && this.plan.waitFirst) this.wait()
    else await this.shot()
  }

  async shot() {
    if (this.stopped) return
    const v = shotVariation(this.plan.entry)
    this.src.setVolume(this.plan.gain * v.volume)
    if (v.pitchSemitones && this.speedPitch) this.src.setSpeedPitch({ ...this.speedPitch, pitchSemitones: (this.speedPitch.pitchSemitones ?? 0) + v.pitchSemitones })
    this.src.scrubTo(this.plan.entry.loopStart ?? 0)
    this.onShot?.(this.plan.id)
    try {
      await this.src.play()
    } catch (err) {
      console.error('Remix: item preview could not play', err)
      this.onDone?.(this)
    }
  }

  wait() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.shot(), nextGapSeconds(this.plan.entry) * 1000)
  }

  ended() {
    if (this.stopped) return
    if (this.repeat) this.wait()
    else this.onDone?.(this)
  }

  setRepeat(on) {
    if (this.plan.kind === 'loop') return
    this.repeat = on
    if (!on) clearTimeout(this.timer)
    else if (!this.src.playing && !this.stopped) this.wait()
  }

  // The volume envelope follows the play position frame by frame.
  tick() {
    if (this.stopped) return
    if (this.src.playing) this.src.tickEnvelope(this.src.currentTime)
    this.raf = requestAnimationFrame(() => this.tick())
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    cancelAnimationFrame(this.raf)
    this.src.pause()
    const src = this.src
    setTimeout(() => src.dispose(), 250)
  }
}

// The group's own filters on top of its members: gain, high and low pass,
// EQ and pan (echo and occlusion stay in the Mixer).
function groupBus(engine, filters) {
  const ctx = engine.context
  const f = filters ?? {}
  const nodes = []
  const gain = ctx.createGain()
  gain.gain.value = Math.pow(10, (Number(f.gainDb) || 0) / 20)
  nodes.push(gain)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = Number(f.highpassHz) || 0
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = Number(f.lowpassHz) || 20000
  nodes.push(hp, lp)
  for (const band of f.eq ?? []) {
    if (band.muted || band.type === 'off') continue
    const b = ctx.createBiquadFilter()
    b.type = band.type ?? 'peaking'
    b.frequency.value = band.freqHz ?? 1000
    b.gain.value = band.gainDb ?? 0
    b.Q.value = biquadQ(b.type, band.q)
    nodes.push(b)
  }
  const pan = ctx.createStereoPanner()
  pan.pan.value = Math.min(1, Math.max(-1, Number(f.pan) || 0))
  nodes.push(pan)
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1])
  pan.connect(engine.masterGain)
  return { input: gain, dispose: () => nodes.forEach((n) => n.disconnect()) }
}

export class ItemPreviewPlayer {
  constructor(engine, { onChange, onShot } = {}) {
    this.engine = engine
    this.onChange = onChange
    this.onShot = onShot
    this.key = null
    this.voices = []
    this.bus = null
  }

  isPlaying(key) {
    return this.key === key
  }

  async playSound(key, plan) {
    this.stop({ quiet: true })
    if (!plan) return this.changed()
    await this.engine.resume()
    this.key = key
    const voice = new SoundVoice(this.engine, plan, this.engine.masterGain, {
      onShot: (id) => this.onShot?.(id),
      onDone: () => this.stop()
    })
    this.voices = [voice]
    this.changed()
    await voice.start()
  }

  async playGroup(key, plan) {
    this.stop({ quiet: true })
    if (!plan || !plan.members.length) return this.changed()
    await this.engine.resume()
    this.key = key
    this.bus = groupBus(this.engine, plan.filters)
    this.voices = plan.members.map(
      (m) =>
        new SoundVoice(this.engine, { ...m, waitFirst: true }, this.bus.input, {
          onShot: (id) => this.onShot?.(id),
          onDone: (v) => {
            this.voices = this.voices.filter((x) => x !== v)
            v.stop()
            if (!this.voices.length) this.stop()
          }
        })
    )
    this.changed()
    await Promise.all(this.voices.map((v) => v.start()))
  }

  // The row's Loop: only the single sound preview listens to it.
  setRepeat(soundId, on) {
    for (const v of this.voices) if (this.voices.length === 1 && v.plan.id === soundId) v.setRepeat(on)
  }

  stop({ quiet = false } = {}) {
    const had = this.key != null
    for (const v of this.voices) v.stop()
    this.voices = []
    const bus = this.bus
    this.bus = null
    if (bus) setTimeout(() => bus.dispose(), 300)
    this.key = null
    if (had && !quiet) this.changed()
  }

  changed() {
    this.onChange?.(this.key)
  }
}
