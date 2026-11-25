import { lookupEls } from './lookup.js'

// Selectors for the fluctuation panel's elements (ids unchanged; CSS and e2e depend on them).
export const FLUCTUATION_SELECTORS = {
  fluctuationSavedNote: '#editor-fluctuation-saved-note',
  flucVolEnabled: '#editor-fluc-vol-enabled',
  flucVolBar: '#editor-fluc-vol-bar',
  flucVolChangeMin: '#editor-fluc-vol-changemin',
  flucVolChangeMax: '#editor-fluc-vol-changemax',
  flucVolTransition: '#editor-fluc-vol-transition',
  flucVolFullRandom: '#editor-fluc-vol-fullrandom',
  flucPitchEnabled: '#editor-fluc-pitch-enabled',
  flucPitchBar: '#editor-fluc-pitch-bar',
  flucPitchChangeMin: '#editor-fluc-pitch-changemin',
  flucPitchChangeMax: '#editor-fluc-pitch-changemax',
  flucPitchTransition: '#editor-fluc-pitch-transition',
  flucPitchFullRandom: '#editor-fluc-pitch-fullrandom',
  flucPanEnabled: '#editor-fluc-pan-enabled',
  flucGroupNote: '#editor-fluc-group-note',
  flucVolBias: '#editor-fluc-vol-bias',
  flucPitchBias: '#editor-fluc-pitch-bias',
  flucPanBias: '#editor-fluc-pan-bias',
  flucPanBar: '#editor-fluc-pan-bar',
  flucPanChangeMin: '#editor-fluc-pan-changemin',
  flucPanChangeMax: '#editor-fluc-pan-changemax',
  flucPanTransition: '#editor-fluc-pan-transition',
  flucPanFullRandom: '#editor-fluc-pan-fullrandom'
}

export function findFluctuationEls(container) {
  return lookupEls(container, FLUCTUATION_SELECTORS)
}
