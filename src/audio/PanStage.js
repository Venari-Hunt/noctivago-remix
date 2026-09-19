// Plugin-local copy of core's src/renderer/audio/PanStage.js plus the pan law
// from src/shared/pan.js (the plugin:// sandbox can't import outside this
// directory) - keep all three in sync if the pan law ever changes.

export function normalizePan(pan) {
  const p = Number(pan)
  if (!Number.isFinite(p)) return 0
  return Math.min(1, Math.max(-1, p))
}

// Returns [[LfromL, LfromR], [RfromL, RfromR]].
export function stereoPanMatrix(pan) {
  const p = normalizePan(pan)
  const a = Math.abs(p)
  // Far side: a mixer balance curve (-3 dB center law, normalized to 1 at
  // center), so a wide stereo recording audibly moves at moderate pans
  // (v0.1.227; the earlier cos curve gave wide stereo only 0.7 dB at 25%).
  const far = Math.SQRT2 * Math.cos(((1 + a) * Math.PI) / 4)
  // How much of the far channel the near side takes in (0 at center, all of
  // it at a hard pan).
  const fold = Math.sin((a * Math.PI) / 2)
  const norm = 1 / Math.sqrt(1 + fold * fold)
  if (p <= 0) {
    return [
      [norm, fold * norm],
      [0, far]
    ]
  }
  return [
    [far, 0],
    [fold * norm, norm]
  ]
}

// Live stereo pan (v0.1.216): a 2x2 gain matrix (splitter -> four gains ->
// merger) driven by the same pan law the ffmpeg bake uses
// (src/shared/pan.js), rather than a StereoPannerNode, whose own law differs
// (and boosts a hard-panned mono sound by 6 dB). The input is forced to two
// channels, so a mono source is up-mixed to L = R = M at full level first -
// the same assumption panFilter.js makes. Connect into `input`, out of
// `output`.
const SMOOTHING_SECONDS = 0.02

export class PanStage {
  constructor(context, pan = 0) {
    this.context = context
    this.input = context.createGain()
    this.input.channelCount = 2
    this.input.channelCountMode = 'explicit'
    this.input.channelInterpretation = 'speakers'
    this._splitter = context.createChannelSplitter(2)
    this.output = context.createChannelMerger(2)
    this._gains = [0, 1, 2, 3].map(() => context.createGain())
    const [ll, lr, rl, rr] = this._gains
    this.input.connect(this._splitter)
    this._splitter.connect(ll, 0)
    this._splitter.connect(lr, 1)
    this._splitter.connect(rl, 0)
    this._splitter.connect(rr, 1)
    ll.connect(this.output, 0, 0)
    lr.connect(this.output, 0, 0)
    rl.connect(this.output, 0, 1)
    rr.connect(this.output, 0, 1)
    this.pan = null
    this.setPan(pan, { immediate: true })
  }

  hasPan(pan) {
    return this.pan === normalizePan(pan)
  }

  setPan(pan, { immediate = false } = {}) {
    const p = normalizePan(pan)
    this.pan = p
    const values = stereoPanMatrix(p).flat()
    const now = this.context.currentTime
    this._gains.forEach((g, i) => {
      if (immediate) g.gain.value = values[i]
      else g.gain.setTargetAtTime(values[i], now, SMOOTHING_SECONDS)
    })
  }

  dispose() {
    this.input.disconnect()
    this._splitter.disconnect()
    for (const g of this._gains) g.disconnect()
    this.output.disconnect()
  }
}
