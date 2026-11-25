import { createFluctuationBar } from '../components/FluctuationBar.js'
import { FLUC_PITCH_MIN, FLUC_PITCH_MAX, FLUC_PAN_MIN, FLUC_PAN_MAX, PAN_DRIFT_DEFAULTS, formatPan } from '../domain/mixSettings.js'

// Fluctuation bars for Preset / Group mode (volume; Group also pitch and pan),
// and the control bundles the shared read/write/enabled-UI helpers take.
// c: patchPresetVolume(vals), patchGroupVolume(vals), readPresetMixControlsAndPreview, readGroupControlsAndPreview.
export function mountMixFluctuation(els, c, create = createFluctuationBar) {
  const volume = { valueMin: 0, valueMax: 1, defaults: { min: 0.5, bias: 0.8, max: 1 }, format: (v) => `${Math.round(v * 100)}%` }
  const presetFlucBar = create(els.mixPresetFlucBar, {
    ...volume,
    onChange: (vals) => {
      c.patchPresetVolume(vals)
      c.readPresetMixControlsAndPreview()
    }
  })
  const groupFlucBar = create(els.mixGroupFlucBar, {
    ...volume,
    onChange: (vals) => {
      c.patchGroupVolume(vals)
      c.readGroupControlsAndPreview()
    }
  })
  const groupFlucPitchBar = create(els.mixGroupFlucPitchBar, {
    valueMin: FLUC_PITCH_MIN,
    valueMax: FLUC_PITCH_MAX,
    defaults: { min: -1, bias: 0, max: 1 },
    format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} st`,
    onChange: () => c.readGroupControlsAndPreview()
  })
  const groupFlucPanBar = create(els.mixGroupFlucPanBar, {
    valueMin: FLUC_PAN_MIN,
    valueMax: FLUC_PAN_MAX,
    defaults: PAN_DRIFT_DEFAULTS,
    format: formatPan,
    onChange: () => c.readGroupControlsAndPreview()
  })

  const presetFlucEls = {
    enabledEl: els.mixPresetFlucEnabled,
    bar: presetFlucBar,
    changeMinEl: els.mixPresetFlucChangeMin,
    changeMaxEl: els.mixPresetFlucChangeMax,
    transEl: els.mixPresetFlucTransition,
    fullRandomEl: els.mixPresetFlucFullRandom,
    biasEl: els.mixPresetFlucBias
  }
  const groupFlucEls = {
    enabledEl: els.mixGroupFlucEnabled,
    bar: groupFlucBar,
    changeMinEl: els.mixGroupFlucChangeMin,
    changeMaxEl: els.mixGroupFlucChangeMax,
    transEl: els.mixGroupFlucTransition,
    fullRandomEl: els.mixGroupFlucFullRandom,
    biasEl: els.mixGroupFlucBias,
    perSoundEl: els.mixGroupFlucPerSound,
    pitch: {
      enabledEl: els.mixGroupFlucPitchEnabled,
      bar: groupFlucPitchBar,
      changeMinEl: els.mixGroupFlucPitchChangeMin,
      changeMaxEl: els.mixGroupFlucPitchChangeMax,
      transEl: els.mixGroupFlucPitchTransition,
      fullRandomEl: els.mixGroupFlucPitchFullRandom,
      biasEl: els.mixGroupFlucPitchBias,
      perSoundEl: els.mixGroupFlucPitchPerSound,
      perSoundLocked: true
    },
    pan: {
      enabledEl: els.mixGroupFlucPanEnabled,
      bar: groupFlucPanBar,
      changeMinEl: els.mixGroupFlucPanChangeMin,
      changeMaxEl: els.mixGroupFlucPanChangeMax,
      transEl: els.mixGroupFlucPanTransition,
      fullRandomEl: els.mixGroupFlucPanFullRandom,
      biasEl: els.mixGroupFlucPanBias,
      perSoundEl: els.mixGroupFlucPanPerSound
    }
  }
  return { presetFlucBar, groupFlucBar, groupFlucPitchBar, groupFlucPanBar, presetFlucEls, groupFlucEls }
}
