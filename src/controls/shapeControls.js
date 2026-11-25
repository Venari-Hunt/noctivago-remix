// Wires crossfade, seam listen, the volume envelope toggle and reset, and speed, pitch and doppler. c: applyCrossfadeControl, toggleSeamListen, applyFilterControls, applySpeedPitchControls; loopEditor is the loop editor controller.
export function wireShapeControls(els, loopEditor, c) {
  els.crossfade.addEventListener('input', () => c.applyCrossfadeControl())
  els.seamListen.addEventListener('click', () =>
    c.toggleSeamListen().catch((err) => console.error('Editor: seam preview failed', err))
  )

  els.envelopeEnabled.addEventListener('change', () => {
    loopEditor.setEnvelope(els.envelopeEnabled.checked, loopEditor.getEnvelope().points)
    c.applyFilterControls()
  })
  els.envelopeReset.addEventListener('click', () => {
    loopEditor.setEnvelope(els.envelopeEnabled.checked, defaultVolumeEnvelope().points)
    c.applyFilterControls()
  })

  els.speed.addEventListener('input', () => c.applySpeedPitchControls())
  els.pitch.addEventListener('input', () => c.applySpeedPitchControls())
  els.reverse.addEventListener('change', () => c.applySpeedPitchControls())
  els.doppler.addEventListener('change', () => c.applySpeedPitchControls())
  els.dopplerIntensity.addEventListener('input', () => c.applySpeedPitchControls())
  els.dopplerSharpness.addEventListener('input', () => c.applySpeedPitchControls())
  els.dopplerReversed.addEventListener('change', () => c.applySpeedPitchControls())
}
