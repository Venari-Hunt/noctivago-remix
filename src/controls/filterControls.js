import { mountFilterControls } from '../components/FilterControls.jsx'
import { NEUTRAL_FILTERS, FILTER_PRESETS } from '../domain/mixSettings.js'

// Mounts the filter sliders island and wires Reset filters and the filter presets; returns the island handle. c: applyFilterControls, setFilterSliders, setSpectralTool, syncNoiseBand.
export function wireFilterControls(els, { layout, loopEditor, spectralView }, c) {
  // The filter sliders are a React island (src/islands/FilterControls.jsx,
  // the pilot for moving Remix's UI to React) - it owns their markup,
  // labels and values; this class reads/writes them through
  // filterControls.getValues()/setValues() only.
  const filterControls = mountFilterControls(els.filters, {
    targets: layout.filterTargets,
    onChange: () => c.applyFilterControls(),
    onShowSampleChange: () => c.syncNoiseBand(),
    // "Mark noise sample": open the Repair view with the Noise sample tool; pressed again, back to the Brush.
    onMarkNoiseSample: () => {
      const on = spectralView.getShape() !== 'noise'
      c.setSpectralTool(on ? 'noise' : 'brush')
      if (on) layout.setView('spec')
    },
    onNoiseSampleFromLoop: () => {
      const { loopStart, loopEnd } = loopEditor.getLoopPoints()
      const end = Math.min(loopEnd, loopStart + Math.min(1.5, (loopEnd - loopStart) / 3))
      filterControls.setValues({
        denoiseSampleStartSec: Number(loopStart.toFixed(2)),
        denoiseSampleEndSec: Number(end.toFixed(2)),
        denoiseEnabled: true
      })
      c.applyFilterControls()
    }
  })

  els.resetFilters.addEventListener('click', () => {
    c.setFilterSliders(NEUTRAL_FILTERS)
    c.applyFilterControls()
  })

  for (const button of els.presetButtons) {
    button.addEventListener('click', () => {
      const preset = FILTER_PRESETS[button.dataset.preset]
      if (!preset) return
      c.setFilterSliders(preset)
      c.applyFilterControls()
    })
  }
  return filterControls
}
