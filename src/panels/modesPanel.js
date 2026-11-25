import { lookupEls } from './lookup.js'

// Selectors for the modes panel's elements (ids unchanged; CSS and e2e depend on them).
export const MODES_SELECTORS = {
  modeSound: '#editor-mode-sound',
  modePreset: '#editor-mode-preset',
  modeGroup: '#editor-mode-group',
  modeHint: '#editor-mode-hint',
  modePanelSound: '#editor-mode-panel-sound',
  modePanelPreset: '#editor-mode-panel-preset',
  modePanelGroup: '#editor-mode-panel-group',
  mixPickerRow: '#editor-mix-picker-row',
  mixPresetSelect: '#editor-mix-preset-select',
  mixGroupSelectLabel: '#editor-mix-group-select-label',
  mixGroupSelect: '#editor-mix-group-select',
  mixGroupNew: '#editor-mix-group-new'
}

export function findModesEls(container) {
  return lookupEls(container, MODES_SELECTORS)
}
