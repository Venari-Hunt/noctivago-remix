import { lookupEls } from './lookup.js'

// Selectors for the seam panel's elements (ids unchanged; CSS and e2e depend on them).
export const SEAM_SELECTORS = {
  seamListen: '#editor-seam-listen',
  seamCanvas: '#editor-seam-canvas',
  seamStatus: '#editor-seam-status'
}

export function findSeamEls(container) {
  return lookupEls(container, SEAM_SELECTORS)
}
