import { lookupEls } from './lookup.js'

// Selectors for the shell panel's elements (ids unchanged; CSS and e2e depend on them).
export const SHELL_SELECTORS = {
  saveStatus: '#editor-save-status',
  scrollTop: '#editor-scroll-top',
  leaveConfirmDialog: '#editor-leave-confirm',
  leaveConfirmYes: '#editor-leave-confirm-yes',
  leaveConfirmNo: '#editor-leave-confirm-no',
  leaveConfirmDontAsk: '#editor-leave-confirm-dont-ask'
}

export function findShellEls(container) {
  return lookupEls(container, SHELL_SELECTORS)
}
