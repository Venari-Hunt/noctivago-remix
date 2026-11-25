import { createSpectralRepairController } from '../components/SpectralRepairView.js'

// Spectrum panel: creates the repair controller and wires its listeners and fields.
// loopEditor: the trim waveform controller (shares markers, playhead, noise band).
// c: updateSpectralControls, applyFilterControls, syncSpectralTool, setMarkers, editMarker, syncSpectralView, setSpectralTool, useShapeAsNoiseSample, seekPreview(sec), setFilterValues(values), hasSpectrogram.
export function mountSpectral(els, loopEditor, c, create = createSpectralRepairController) {
  const spectralView = create(els.spectralCanvas)
  spectralView.onChange(() => {
    c.updateSpectralControls()
    c.applyFilterControls()
  })
  spectralView.onSelect(() => c.updateSpectralControls())
  spectralView.onToolChange(() => c.syncSpectralTool())
  for (const view of [loopEditor, spectralView]) {
    view.onMarkersChange((list) => c.setMarkers(list))
    view.onMarkerEdit((marker, x, y) => c.editMarker(marker, x, y))
  }
  // The Spectrum tab is hidden until opened, so the first fetch has to wait for a real size.
  spectralView.onResize(() => c.syncSpectralView())
  // Dragging the needle seeks the preview (playing or paused).
  spectralView.onSeek((sec) => c.seekPreview(sec))
  // A number field now: half-typed values wait, change clamps to 6-80 dB.
  const reductionDb = () => {
    const v = Number(els.spectralReduction.value)
    return Number.isFinite(v) ? Math.min(80, Math.max(6, Math.round(v))) : null
  }
  els.spectralReduction.addEventListener('input', () => {
    const v = Number(els.spectralReduction.value)
    if (Number.isFinite(v) && v >= 6 && v <= 80) spectralView.setSelectedReduction(Math.round(v))
  })
  els.spectralReduction.addEventListener('change', () => {
    const db = reductionDb() ?? 40
    els.spectralReduction.value = String(db)
    spectralView.setSelectedReduction(db)
  })
  els.spectralShape.addEventListener('click', (evt) => {
    const btn = evt.target.closest('[data-shape]')
    if (!btn) return
    c.setSpectralTool(btn.dataset.shape)
  })
  // The Noise sample band: dragging it moves the From/To fields live and
  // applies once the drag ends, the same as typing them. The same band is
  // drawn on the Trim waveform and works the same way there.
  const onNoise = ({ startSec, endSec, final }) => {
    c.setFilterValues({ denoiseSampleStartSec: startSec, denoiseSampleEndSec: endSec, ...(final ? { denoiseEnabled: true } : {}) })
    if (final) c.applyFilterControls()
  }
  spectralView.onNoiseChange(onNoise)
  loopEditor.onNoiseSampleChange(onNoise)
  els.spectralUseNoise.addEventListener('click', () => c.useShapeAsNoiseSample())
  els.spectralDelete.addEventListener('click', () => spectralView.removeSelected())
  els.spectralClear.addEventListener('click', () => spectralView.clear())
  // Needs app 0.1.237's getSpectrogram; hide the panel on an older app
  // rather than show a box that can never fill in.
  els.spectralSection.classList.toggle('hidden', !c.hasSpectrogram)
  return spectralView
}
