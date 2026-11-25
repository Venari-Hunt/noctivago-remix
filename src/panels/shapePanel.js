import { lookupEls } from './lookup.js'

// Selectors for the shape panel's elements (ids unchanged; CSS and e2e depend on them).
export const SHAPE_SELECTORS = {
  envelopeEnabled: '#editor-envelope-enabled',
  envelopeReset: '#editor-envelope-reset',
  spectralSection: '#editor-spectral-section',
  spectralCanvas: '#editor-spectral-canvas',
  spectralShape: '#editor-spectral-shape',
  spectralDelete: '#editor-spectral-delete',
  spectralClear: '#editor-spectral-clear',
  spectralUseNoise: '#editor-spectral-use-noise',
  spectralHint: '#editor-spectral-hint',
  spectralLegendNoise: '#editor-spectral-legend-noise',
  spectralLegendNoiseText: '#editor-spectral-legend-noise-text',
  spectralSelection: '#editor-spectral-selection',
  spectralReduction: '#editor-spectral-reduction',
  spectralReductionValue: '#editor-spectral-reduction-value'
}

export function findShapeEls(container) {
  return lookupEls(container, SHAPE_SELECTORS)
}
