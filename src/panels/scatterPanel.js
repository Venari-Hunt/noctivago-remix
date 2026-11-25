import { lookupEls } from './lookup.js'

// Selectors for the scatter panel's elements (ids unchanged; CSS and e2e depend on them).
export const SCATTER_SELECTORS = {
  scatterSection: '#editor-scatter-section',
  scatterGapMin: '#editor-scatter-gap-min',
  scatterGapMax: '#editor-scatter-gap-max',
  scatterGapFullyRandom: '#editor-scatter-gap-fully-random',
  scatterGapBiasEnabled: '#editor-scatter-gap-bias-enabled',
  scatterGapBias: '#editor-scatter-gap-bias',
  scatterPitchBar: '#editor-scatter-pitch-bar',
  scatterPitchFullyRandom: '#editor-scatter-pitch-fully-random',
  scatterPitchBiasEnabled: '#editor-scatter-pitch-bias-enabled',
  scatterVolumeBar: '#editor-scatter-volume-bar',
  scatterVolumeFullyRandom: '#editor-scatter-volume-fully-random',
  scatterVolumeBiasEnabled: '#editor-scatter-volume-bias-enabled',
  scatterPanBar: '#editor-scatter-pan-bar',
  scatterPanFullyRandom: '#editor-scatter-pan-fully-random',
  scatterPanBiasEnabled: '#editor-scatter-pan-bias-enabled',
  scatterGroupNote: '#editor-scatter-group-note',
  scatterSpeedBar: '#editor-scatter-speed-bar',
  scatterSpeedFullyRandom: '#editor-scatter-speed-fully-random',
  scatterSpeedBiasEnabled: '#editor-scatter-speed-bias-enabled',
  scatterFadeIn: '#editor-scatter-fade-in',
  scatterFadeOut: '#editor-scatter-fade-out',
  scatterSyncGroup: '#editor-scatter-sync-group'
}

export function findScatterEls(container) {
  return lookupEls(container, SCATTER_SELECTORS)
}
