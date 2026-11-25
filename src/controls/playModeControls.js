// Wires the play mode radios and the Random Interval and Scheduled controls. c: applyPlayModeControl, applyScatterControls, applyScheduleControls, toggleFade, syncFadeToggle.
export function wirePlayModeControls(els, c) {
  els.playModeLoop.addEventListener('change', () => c.applyPlayModeControl())
  els.playModeScatter.addEventListener('change', () => c.applyPlayModeControl())
  els.playModeScheduled.addEventListener('change', () => c.applyPlayModeControl())
  els.scatterGapMin.addEventListener('input', () => c.applyScatterControls())
  els.scatterGapMax.addEventListener('input', () => c.applyScatterControls())
  els.scatterGapFullyRandom.addEventListener('change', () => c.applyScatterControls())
  els.scatterGapBiasEnabled.addEventListener('change', () => c.applyScatterControls())
  els.scatterGapBias.addEventListener('input', () => c.applyScatterControls())
  els.scatterFadeEnabled.addEventListener('change', () =>
    c.toggleFade(els.scatterFadeEnabled, els.scatterFadeIn, els.scatterFadeOut, () => c.applyScatterControls())
  )
  els.scatterFadeIn.addEventListener('input', () => {
    c.syncFadeToggle(els.scatterFadeEnabled, els.scatterFadeIn, els.scatterFadeOut)
    c.applyScatterControls()
  })
  els.scatterFadeOut.addEventListener('input', () => {
    c.syncFadeToggle(els.scatterFadeEnabled, els.scatterFadeIn, els.scatterFadeOut)
    c.applyScatterControls()
  })
  els.scatterSyncGroup.addEventListener('input', () => c.applyScatterControls())

  els.scheduleTypeTimes.addEventListener('change', () => c.applyScheduleControls())
  els.scheduleTypeInterval.addEventListener('change', () => c.applyScheduleControls())
  els.scheduleTimes.addEventListener('input', () => c.applyScheduleControls())
  els.scheduleInterval.addEventListener('input', () => c.applyScheduleControls())
  els.scheduleFadeEnabled.addEventListener('change', () =>
    c.toggleFade(els.scheduleFadeEnabled, els.scheduleFadeIn, els.scheduleFadeOut, () => c.applyScheduleControls())
  )
  els.scheduleFadeIn.addEventListener('input', () => {
    c.syncFadeToggle(els.scheduleFadeEnabled, els.scheduleFadeIn, els.scheduleFadeOut)
    c.applyScheduleControls()
  })
  els.scheduleFadeOut.addEventListener('input', () => {
    c.syncFadeToggle(els.scheduleFadeEnabled, els.scheduleFadeIn, els.scheduleFadeOut)
    c.applyScheduleControls()
  })
}
