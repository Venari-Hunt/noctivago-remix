import { lookupEls } from './lookup.js'

// Selectors for the playMode panel's elements (ids unchanged; CSS and e2e depend on them).
export const PLAYMODE_SELECTORS = {
  playModeLoop: '#editor-playmode-loop',
  playModeScatter: '#editor-playmode-scatter',
  playModeScheduled: '#editor-playmode-scheduled',
  fadeSection: '#editor-fade-section',
  scatterFadeFields: '#editor-scatter-fade-fields',
  scatterFadeEnabled: '#editor-scatter-fade-enabled',
  scheduleFadeFields: '#editor-schedule-fade-fields',
  scheduleFadeEnabled: '#editor-schedule-fade-enabled',
  crossfadeSection: '#editor-crossfade-section',
  crossfade: '#editor-crossfade',
  crossfadeValue: '#editor-crossfade-value'
}

export function findPlayModeEls(container) {
  return lookupEls(container, PLAYMODE_SELECTORS)
}
