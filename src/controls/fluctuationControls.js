import { createFluctuationBar } from '../components/FluctuationBar.js'
import { FLUC_VOL_MIN, FLUC_VOL_MAX, FLUC_PITCH_MIN, FLUC_PITCH_MAX, FLUC_PAN_MIN, FLUC_PAN_MAX, PAN_DRIFT_DEFAULTS, formatPan, SHOT_AXES, SHOT_AXIS_NAMES } from '../domain/mixSettings.js'

// Builds the fluctuation bars (volume, pitch, pan) and the per-play random bars, and wires their inputs; returns the bars. c: patchFluctuation(axis, vals), applyFluctuationControls, applyScatterControls, applyScheduleControls.
export function wireFluctuationControls(els, c) {
  // --- Fluctuation (v0.1.164) ---
  // The two 3-circle bars. Unlike trim/filters/EQ, fluctuation is NOT part
  // of the snapshot/undo/autosave/A-B-compare machinery - it's a
  // playback-time behavior, never baked, so it persists on its own (a
  // debounced library.updateFluctuation) the moment a control settles,
  // and previews live without any ffmpeg round-trip.
  const flucVolBar = createFluctuationBar(els.flucVolBar, {
    valueMin: FLUC_VOL_MIN,
    valueMax: FLUC_VOL_MAX,
    defaults: { min: 0.5, bias: 0.8, max: 1 },
    format: (v) => `${Math.round(v * 100)}%`,
    onChange: (vals) => {
      c.patchFluctuation('volume', vals)
      c.applyFluctuationControls()
    }
  })
  const flucPitchBar = createFluctuationBar(els.flucPitchBar, {
    valueMin: FLUC_PITCH_MIN,
    valueMax: FLUC_PITCH_MAX,
    defaults: { min: -1, bias: 0, max: 1 },
    format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} st`,
    onChange: (vals) => {
      c.patchFluctuation('pitch', vals)
      c.applyFluctuationControls()
    }
  })
  const flucPanBar = createFluctuationBar(els.flucPanBar, {
    valueMin: FLUC_PAN_MIN,
    valueMax: FLUC_PAN_MAX,
    defaults: PAN_DRIFT_DEFAULTS,
    format: formatPan,
    onChange: (vals) => {
      c.patchFluctuation('pan', vals)
      c.applyFluctuationControls()
    }
  })
  // Per-play random bars (v0.1.218) - Random Interval + Scheduled.
  const shotBars = { scatter: {}, schedule: {} }
  for (const kind of ['scatter', 'schedule']) {
    for (const axis of SHOT_AXIS_NAMES) {
      const cfg = SHOT_AXES[axis]
      const key = `${kind}${axis[0].toUpperCase()}${axis.slice(1)}`
      shotBars[kind][axis] = createFluctuationBar(els[`${key}Bar`], {
        valueMin: cfg.lo,
        valueMax: cfg.hi,
        defaults: cfg.defaults,
        format: cfg.format,
        onChange: () => (kind === 'scatter' ? c.applyScatterControls() : c.applyScheduleControls())
      })
      for (const suffix of ['FullyRandom', 'BiasEnabled']) {
        els[`${key}${suffix}`].addEventListener('change', () =>
          kind === 'scatter' ? c.applyScatterControls() : c.applyScheduleControls()
        )
      }
    }
  }
  const flucInputs = [
    els.flucPanEnabled,
    els.flucPanFullRandom,
    els.flucPanChangeMin,
    els.flucPanChangeMax,
    els.flucPanTransition,
    els.flucPanBias,
    els.flucVolBias,
    els.flucPitchBias,
    els.flucVolEnabled,
    els.flucVolFullRandom,
    els.flucVolChangeMin,
    els.flucVolChangeMax,
    els.flucVolTransition,
    els.flucPitchEnabled,
    els.flucPitchFullRandom,
    els.flucPitchChangeMin,
    els.flucPitchChangeMax,
    els.flucPitchTransition
  ]
  for (const el of flucInputs) {
    el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => c.applyFluctuationControls())
  }
  return { flucVolBar, flucPitchBar, flucPanBar, shotBars }
}
