import { lookupEls } from './lookup.js'

// Selectors for the trim panel's elements (ids unchanged; CSS and e2e depend on them).
export const TRIM_SELECTORS = {
  canvas: '#editor-canvas',
  scrollbarTrack: '#editor-scrollbar',
  scrollbarThumb: '#editor-scrollbar-thumb',
  waveformStatus: '#editor-waveform-status',
  needleInput: '#editor-needle-input',
  startInput: '#editor-start-input',
  endInput: '#editor-end-input',
  lengthInput: '#editor-length-input',
  suggestLoopBtn: '#editor-suggest-loop',
  suggestStatus: '#editor-suggest-status'
}

export function findTrimEls(container) {
  return lookupEls(container, TRIM_SELECTORS)
}
