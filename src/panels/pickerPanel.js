import { lookupEls } from './lookup.js'

// Selectors for the picker panel's elements (ids unchanged; CSS and e2e depend on them).
export const PICKER_SELECTORS = {
  soundSearch: '#editor-sound-search',
  soundOptions: '#editor-sound-options',
  panel: '#editor-panel',
  empty: '#editor-empty',
  soundName: '#editor-sound-name',
  syncGroupRow: '#editor-sync-group-row'
}

export function findPickerEls(container) {
  return lookupEls(container, PICKER_SELECTORS)
}
