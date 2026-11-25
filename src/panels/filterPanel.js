import { lookupEls } from './lookup.js'

// Selectors for the filter panel's elements (ids unchanged; CSS and e2e depend on them).
export const FILTER_SELECTORS = {
  filters: '#editor-filters',
  eqCanvas: '#editor-eq-canvas',
  eqReset: '#editor-eq-reset',
  eqAddBand: '#editor-eq-add-band',
  eqRemoveBand: '#editor-eq-remove-band',
  eqZoomIn: '#editor-eq-zoom-in',
  eqZoomOut: '#editor-eq-zoom-out',
  eqInvert: '#editor-eq-invert',
  eqCompareA: '#editor-eq-compare-a',
  eqCompareB: '#editor-eq-compare-b',
  eqRevertBanner: '#editor-eq-revert-banner',
  eqType: '#editor-eq-type',
  eqSlope: '#editor-eq-slope',
  eqSlopeLabel: '#editor-eq-slope-label',
  eqFreq: '#editor-eq-freq',
  eqGain: '#editor-eq-gain',
  eqQ: '#editor-eq-q',
  eqMute: '#editor-eq-mute',
  eqSolo: '#editor-eq-solo',
  resetFilters: '#editor-reset-filters',
  presetButtons: { all: '[data-preset]' }
}

export function findFilterEls(container) {
  return lookupEls(container, FILTER_SELECTORS)
}
